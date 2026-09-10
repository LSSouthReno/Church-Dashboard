/**
 * Pastor Shepherding Health Sync
 *
 * Builds the data behind the (password-gated) Pastor Shepherding page: for every
 * person on an elder's "Shepherding - [Elder]" PCO People smart list, it pulls
 * their real Planning Center activity and computes a PACI maturity band
 * (Parent / Adult / Child / Infant) plus contact info and their Shepherding-tab
 * status, then rolls those up into per-elder and whole-congregation health.
 *
 * PACI (spComputeScore_): a 0-100 activity score from GIVING (35) + COMMUNITY
 * GROUP (35) + SERVING (30) → 1-10, banded to:
 *     Infant 1-3 (red) · Child 4-6 (yellow) · Adult 7-10 (green) ·
 *     Parent = Adult who LEADS a group/team (bright green).
 * PACI is purely activity-based and independent of the pastor-assigned Health
 * Assessment (Healthy/Weak/Wandering/Lost/Could Not Contact), which is shown and
 * filtered alongside it.
 *
 * GIVING: pulled church-wide for 24 months and joined by PCO person id. Spouses
 * are credited jointly by summing giving across the ADULT members of each PCO
 * household (kids excluded). "Growing/declining" compares the last 12 months to
 * the prior 12, excluding any single gift >= 4x that person's median gift (so a
 * one-off asset-sale gift doesn't distort the trend).
 *
 * The heavy per-person detail (notes, custom fields, form answers, workflow
 * cards) is NOT synced here — it is lazy-loaded live per card via the web app
 * (shepPersonDetail_ / shepUpdate_ in Code_eos_webapp.gs).
 *
 * Shares PCO_APP_ID/PCO_SECRET/GITHUB_* script properties and the
 * pcoHeaders_/pcoGetAll_/getProp_/fgBatchFetch_ helpers from the other sync files.
 * Deploy, then run installShepherdingHealthTrigger() once (hourly). On-demand:
 * ?action=run_shepherding_health_sync.
 */

const SH_TIME_BUDGET_MS  = 5.2 * 60 * 1000;
const SH_GIVING_MONTHS    = 24;   // pulled window
const SH_TREND_HALF       = 12;   // last 12 vs prior 12
const SH_OUTLIER_MULT     = 4;    // a gift >= 4x the person's median is a one-off
const SH_OUTPUT_FILE      = 'shepherding-data.json';
const SH_PRIVATE_SHEET    = 'ShepherdingData';
const SH_GIVING_SHEET     = 'ShepherdingGiving';   // cached giving stats (pid → stats)
const SH_GIVING_LEDGER    = 'ShepherdingGivingLedger';  // church-wide 24-mo gift ledger (incremental)
const SH_GIVING_WM_PROP   = 'SH_GIVING_WATERMARK';      // ISO created_at watermark for delta pulls
const SH_MANUAL_SHEET     = 'ShepherdingManualMaturity'; // pid | by | date — manual maturity overrides
const SH_CHANGELOG_SHEET  = 'ShepherdingChangeLog';      // ts | pastor | pid | field | value — audit trail
const SH_OVERRIDES_SHEET  = 'ShepherdingPendingEdits';   // pid | field | value | by | ts — edits not yet in the hourly snapshot
const SH_CELL_CHUNK       = 40000;

// ── Pending edits: dashboard changes appear instantly (and survive reloads) by
// overlaying them on the cached snapshot until the hourly sync catches up. ──
function spReadOverrides_() {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_OVERRIDES_SHEET);
    if (!sh) return [];
    var last = sh.getLastRow(); if (!last) return [];
    return sh.getRange(1,1,last,5).getValues().filter(function(r){ return r[0]; })
      .map(function(r){ return { pid:String(r[0]), field:String(r[1]), value:String(r[2]), by:String(r[3]||''), ts:String(r[4]||'') }; });
  } catch (e) { return []; }
}
// Overlay pending edits onto a shepherding-data object (mutates it).
function spApplyOverrides_(data) {
  if (!data || !data.elders) return data;
  var ov = spReadOverrides_(); if (!ov.length) return data;
  var byId = {};
  data.elders.forEach(function(e){ (e.people||[]).forEach(function(p){ if (p.id) byId[String(p.id)] = p; }); });
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy');
  ov.forEach(function(o){
    var p = byId[o.pid]; if (!p) return;
    var v = o.value;
    if (o.field==='health') { p.statusRaw=v; p.status=shNormStatus_(v); p.healthDate=today; p.healthDaysAgo=0; p.overdue = (v===''); }
    else if (o.field==='healthDate') { p.healthDate=v; p.healthDaysAgo=spHealthDaysAgo_(v); p.overdue=(p.healthDaysAgo==null)||(p.healthDaysAgo>SH_OVERDUE_DAYS); }
    else if (o.field==='maturity') { p.spiritualMat=v; p.maturityManual = v ? { by:o.by, date:(o.ts||'').slice(0,10) } : null; }
    else if (o.field==='membership') { p.membershipType=v; p.member=/member|deacon|pastor/i.test(v); }
    else if (o.field==='elder') { p.assignedElder=v; }
    else if (o.field==='pref') { p.preferredComm=v; }
    else if (o.field==='known') { p.known=v; }
    else if (o.field==='deaconSupport') { p.deaconSupport=v; }
    else if (o.field==='deaconNotes') { p.deaconNotes=v; }
    p._edited = true;
  });
  return data;
}
// After a fresh sync (which read PCO directly), drop pending edits made before it started.
function spClearOverridesBefore_(cutoffIso) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_OVERRIDES_SHEET);
    if (!sh) return;
    var last = sh.getLastRow(); if (!last) return;
    var rows = sh.getRange(1,1,last,5).getValues();
    var keep = rows.filter(function(r){ return r[0] && String(r[4]||'') > cutoffIso; });  // keep edits newer than cutoff
    sh.clearContents();
    if (keep.length) sh.getRange(1,1,keep.length,5).setValues(keep);
  } catch (e) {}
}

// pid → {by, date} for people whose Spiritual Maturity was set from the dashboard.
function spReadManualMaturity_() {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_MANUAL_SHEET);
    if (!sh) return {};
    var last = sh.getLastRow(); if (!last) return {};
    var rows = sh.getRange(1,1,last,3).getValues();
    var out = {};
    rows.forEach(function(r){ if (r[0]) out[String(r[0])] = { by:String(r[1]||''), date:String(r[2]||'') }; });
    return out;
  } catch (e) { return {}; }
}

// SHA-256 of the shepherding page password ("1peter5"). var (not const) so the
// web-app and actions files reliably see it — cross-file top-level const/let
// sharing is unreliable in Apps Script. Keep in sync with PASTOR_HASH in index.html.
var SHEPHERDING_PW_HASH   = '19714e8203cc3d5e9f7c4a4499981a5d37448d56e193336b3ed32913abbc3b3d';

// Per-pastor logins: SHA-256(firstname + last-4-of-phone) → identity. Lets the
// dashboard know who is signed in (for change attribution + personalization).
// "1peter5" stays as a master/admin. Keep in sync with SH_PASTORS in index.html.
var SHEPHERDING_PASTORS = {
  '75b088e8499b902e30e0348e32dccd5badc5146769d97799900531fac3d445a4': { name:'Adam Carp',     elder:'Adam' },
  'af97c9ab71bee6cdef40ca8ac5571c6ddded6fb2693aeb363b62c1c5d87799b4': { name:'Brad Borowski', elder:'Brad' },
  '97e2216c3784767313cb3161a67dabb622e7b4ec9abc0f46d427c9fef3b8dda0': { name:'Josh Wampler',  elder:'Josh' },
  '6a71359975c01071defa0fd07dfa374ffeff87995a9bdc1a69557fc6aef01ff6': { name:'Keith Primus',  elder:'Keith' },
  '007008de8fd721c4326810fbc7796eab66c1bbe00d5bce52e1fad27697a64bef': { name:'Nick Colonna',  elder:'Nick' },
  'e43df0398932fe57d94c058c3821b9804be86418fb42bfbd0b136faf1042f95b': { name:'Ray Brown',     elder:'Ray' },
  '258a074a71811b4c9184e49c95fee3fcbd3700932de36df2bbac9619798ec483': { name:'Ryan Griffin',  elder:'Ryan' },
  '19714e8203cc3d5e9f7c4a4499981a5d37448d56e193336b3ed32913abbc3b3d': { name:'Admin',         elder:'' }
};
// hash → pastor name (or null if not a valid login). Used to gate + attribute.
function spPastorForHash_(hash) {
  var p = SHEPHERDING_PASTORS[String(hash||'')];
  return p ? p.name : null;
}

// PCO field-definition ids (discovered) — precise, no fuzzy matching.
// var so Code_shepherding_actions.gs (write-back) reliably sees it cross-file.
var SH_FIELD = {
  assignedElder:  '789184',  // select: elder full names
  spiritualMat:   '789187',  // select: N/A, Infant, Child, Adult, Parent
  healthAssess:   '789188',  // select: Healthy, Weak, Wandering, Lost, Could Not Contact
  healthDate:     '789189',  // date
  preferredComm:  '789190',  // select: Email, Phone, Text, Any/All
  known:          '846717',  // boolean
  deaconSupport:  '1082241', // boolean
  deaconNotes:    '1082244', // text
  baptized:       '790028',  // boolean
  baptismDate:    '789176',  // date
  salvationDate:  '789177',  // date
  firstVisit:     '789178',  // date
  childDedication:'789179',  // date
  membershipStart:'789180'   // date
};
// Reverse map (definition id → our short key) for the bulk field_data read.
var SH_FIELD_BY_ID = (function(){ var m={}; for (var k in SH_FIELD) m[SH_FIELD[k]]=k; return m; })();
var SH_OVERDUE_DAYS = 183;  // ~6 months → shepherding check-in overdue

const SH_STATUS_VOCAB = ['healthy', 'weak', 'wandering', 'lost', 'could-not-contact', 'unknown'];
function shNormStatus_(raw) {
  var v = String(raw || '').trim().toLowerCase();
  if (!v) return 'unknown';
  if (v.indexOf('healthy') !== -1) return 'healthy';
  if (v.indexOf('weak') !== -1) return 'weak';
  if (v.indexOf('wander') !== -1) return 'wandering';
  if (v.indexOf('lost') !== -1) return 'lost';
  if (v.indexOf('could') !== -1 || v.indexOf('contact') !== -1) return 'could-not-contact';
  return 'unknown';
}

function shElapsed_(s) { return new Date().getTime() - s; }
function shOverBudget_(s) { return shElapsed_(s) > SH_TIME_BUDGET_MS; }

/* =========================================================
   MAIN
========================================================= */
function syncShepherdingHealth_() {
  Logger.log('▶ Shepherding Health — starting');
  var startMs = new Date().getTime();

  var lists = spFetchShepherdingLists_();
  var seenId = {};
  lists.forEach(function(l){ l.people.forEach(function(p){ if (p.id) seenId[p.id]=1; }); });

  // Members with NO shepherding elder → "Unassigned" list (should normally be empty).
  var unassigned = spUnassignedMembers_(seenId, startMs);
  if (unassigned.length) { lists.push({ elder: 'Unassigned', list: 'Unassigned', people: unassigned, unassigned: true }); }

  // New people IN the "New Family Member" workflow (not yet full members) — to be
  // highlighted on their elder's list as needing contact to finalize membership.
  var newFamily = spNewFamilyMembers_(startMs);

  var allIds = [];
  lists.forEach(function(l){ l.people.forEach(function(p){ if (p.id && allIds.indexOf(p.id)===-1) allIds.push(p.id); }); });
  newFamily.forEach(function(nf){ if (nf.id && allIds.indexOf(nf.id)===-1) allIds.push(nf.id); });
  Logger.log('   people: ' + allIds.length + ' · unassigned: ' + unassigned.length + ' · newFamily: ' + newFamily.length);
  if (!allIds.length) { Logger.log('   ! no people — aborting (keeping previous)'); return; }

  var groups = spGroupInvolvementByPerson_(startMs);
  var cf = spContactAndFields_(allIds, startMs);   // reliable contact + field read (include=field_data)
  var givingCache = spReadGivingCache_() || {};
  var manual = spReadManualMaturity_();

  // Place each new-family person on their Assigned-Elder's list (else Unassigned).
  if (newFamily.length) {
    var byElder = {}; lists.forEach(function(l){ byElder[l.elder] = l; });
    var unList = lists.filter(function(l){ return l.unassigned; })[0];
    newFamily.forEach(function(nf){
      var elderFull = (cf.fields[nf.id]||{}).assignedElder || '';
      var target = elderFull ? byElder[elderFull.split(' ')[0]] : null;
      if (!target) {
        if (!unList) { unList = { elder:'Unassigned', list:'Unassigned', people:[], unassigned:true }; lists.push(unList); byElder['Unassigned']=unList; }
        target = unList;
      }
      var existing = target.people.filter(function(p){ return String(p.id)===String(nf.id); })[0];
      if (existing) { existing._nf=true; existing._step=nf.step; existing._cardId=nf.cardId; }
      else target.people.push({ id:nf.id, first:nf.first, last:nf.last, name:nf.name, member:false, _nf:true, _step:nf.step, _cardId:nf.cardId });
    });
  }

  var eldersOut = lists.map(function(l){
    var people = l.people.map(function(p){
      var giving = givingCache[p.id] || spEmptyGiving_();
      var rec = spBuildPerson_(p, giving, groups[p.id], cf.contact[p.id], cf.fields[p.id], manual[p.id]);
      if (p._nf) { rec.newFamilyMember = true; rec.familyStep = p._step || ''; rec.familyCardId = p._cardId || ''; }
      return rec;
    });
    // "Unassigned" = empty Assigned-Elder field (or a new-family person not yet assigned).
    if (l.unassigned) people = people.filter(function(p){ return !p.assignedElder || p.newFamilyMember; });
    people.sort(function(a,b){ return (b.newFamilyMember?1:0)-(a.newFamilyMember?1:0) || (a.score||0)-(b.score||0) || a.name.localeCompare(b.name); });
    return { elder: l.elder, list: l.list, unassigned: !!l.unassigned, summary: spSummarize_(people), people: people };
  }).filter(function(e){ return !(e.unassigned && !e.people.length); });

  // Congregation stats cover the shepherded MEMBERS — exclude new-family prospects and Unassigned.
  var uniq = [], seenU = {};
  eldersOut.forEach(function(e){ if (e.unassigned) return; e.people.forEach(function(p){ if (p.newFamilyMember) return; if (p.id && !seenU[p.id]) { seenU[p.id]=1; uniq.push(p); } }); });

  var out = {
    generatedAt: new Date().toISOString(),
    asOf: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    givingMonths: SH_TREND_HALF,
    statusVocab: SH_STATUS_VOCAB,
    paciVocab: ['parent','adult','child','infant'],
    elderOptions: spElderOptions_(),
    membershipOptions: cf.membershipValues.sort(),
    overdueDays: SH_OVERDUE_DAYS,
    congregation: spSummarize_(uniq),
    elders: eldersOut
  };
  out.congregation.totalPeople = uniq.length;

  spStorePrivate_(out);
  spPushToGitHub_(spBuildPublicSeed_(out));
  // This snapshot read PCO fresh, so pending edits made before the sync started
  // are now baked in — drop them (keep any made mid-sync).
  spClearOverridesBefore_(new Date(startMs).toISOString());
  Logger.log('✓ Shepherding Health — done in ' + Math.round(shElapsed_(startMs)/1000) + 's. people=' +
             uniq.length + ' avgScore=' + out.congregation.avgScore);
}

/* =========================================================
   Shepherding lists → people (ids)
========================================================= */
function spFetchShepherdingLists_() {
  var lists = pcoGetAll_('/people/v2/lists?per_page=100') || [];
  var out = [];
  lists.forEach(function(l){
    var name = String(((l.attributes||{}).name||'')).trim();
    if (!/^shepherding\s*[-–—]/i.test(name)) return;
    var elder = name.replace(/^shepherding\s*[-–—]\s*/i, '').trim() || name;
    var people = [];
    try {
      people = (pcoGetAll_('/people/v2/lists/' + l.id + '/people?per_page=100') || []).map(function(p){
        var a = p.attributes || {};
        var full = ((a.first_name||'') + ' ' + (a.last_name||'')).trim();
        return { id:String(p.id), first:a.first_name||'', last:a.last_name||'', name:full||('Person '+p.id),
                 member:/member|deacon|pastor/i.test(String(a.membership||'')) };
      }).filter(function(p){ return !!p.id; });
    } catch (e) { Logger.log('   ! list "' + name + '" people fetch failed: ' + e.message); }
    out.push({ elder: elder, list: name, people: people });
  });
  out.sort(function(a,b){ return a.elder.localeCompare(b.elder); });
  return out;
}

function spElderOptions_() {
  try {
    var res = pcoGetAllWithIncluded_('/people/v2/field_definitions?include=field_options&per_page=200');
    var opts = [];
    (res.included||[]).forEach(function(o){
      if (o.type !== 'FieldOption') return;
      var d = (((o.relationships||{}).field_definition||{}).data||{}).id;
      if (String(d) === SH_FIELD.assignedElder) opts.push((o.attributes||{}).value);
    });
    return opts;
  } catch (e) { return []; }
}

/* =========================================================
   DAILY GIVING JOB — heavy 24-mo pull + household join → cache
========================================================= */
function syncShepherdingGiving_() {
  Logger.log('▶ Shepherding Giving — starting');
  var startMs = new Date().getTime();
  var lists = spFetchShepherdingLists_();
  var allIds = [], seen = {};
  lists.forEach(function(l){ l.people.forEach(function(p){ if (p.id && !seen[p.id]) { seen[p.id]=1; allIds.push(p.id); } }); });
  if (!allIds.length) { Logger.log('   ! no people — abort'); return; }

  // Incremental: only pull donations created since last run; the 24-mo window
  // lives in a sheet ledger, so we never re-pull 24 months every night.
  var ledger          = spUpdateGivingLedger_(startMs);   // { byPerson: {pid:[{cents,ts}]} }
  var recurring       = spRecurringDonorIds_();
  var householdAdults = spHouseholdAdultsByPerson_(allIds, startMs);

  var map = {};
  allIds.forEach(function(id){ map[id] = spComputeGivingFor_(id, householdAdults[id]||[id], ledger.byPerson, recurring); });
  spStoreGivingCache_({ generatedAt: new Date().toISOString(), giving: map });
  Logger.log('✓ Shepherding Giving — cached ' + allIds.length + ' people in ' + Math.round(shElapsed_(startMs)/1000) + 's');
}

// Incrementally maintain a church-wide 24-month gift ledger in a hidden sheet.
// Watermarks on created_at (monotonic) so late-entered/backdated gifts aren't
// missed, dedupes by donation id, prunes rows older than 24 months, and returns
// per-person gift arrays built from the full ledger.
function spUpdateGivingLedger_(startMs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SH_GIVING_LEDGER) || ss.insertSheet(SH_GIVING_LEDGER);
  try { sh.hideSheet(); } catch (e) {}
  var props = PropertiesService.getScriptProperties();
  var tz = Session.getScriptTimeZone();

  var last = sh.getLastRow();
  var existing = last>0 ? sh.getRange(1,1,last,4).getValues() : [];   // [id, personId, cents, receivedISO]
  var seen = {}, rows = [];
  existing.forEach(function(r){ if (r[0]) { seen[String(r[0])]=1; rows.push(r); } });

  var wm = props.getProperty(SH_GIVING_WM_PROP);
  var sinceStr;
  if (wm) { var s = new Date(wm); s.setDate(s.getDate()-1); sinceStr = Utilities.formatDate(s, tz, 'yyyy-MM-dd'); }
  else { var s0 = new Date(); s0.setMonth(s0.getMonth()-SH_GIVING_MONTHS); sinceStr = Utilities.formatDate(s0, tz, 'yyyy-MM-dd'); }

  var url = 'https://api.planningcenteronline.com/giving/v2/donations?where[created_at][gte]=' + sinceStr +
            '&per_page=100&order=created_at';
  var maxCreated = wm ? new Date(wm).getTime() : 0;
  var added = 0, pages = 0;
  while (url && pages < 600) {
    if (shOverBudget_(startMs)) { Logger.log('   ! ledger budget hit — partial'); break; }
    pages++;
    var json; try { json = fgFetchPage_(url); } catch (e) { Logger.log('   ! ledger page failed: ' + e.message); break; }
    (json.data||[]).forEach(function(d){
      var id = String(d.id); if (seen[id]) return;
      var a = d.attributes || {};
      var created = a.created_at ? new Date(a.created_at).getTime() : 0;
      if (created > maxCreated) maxCreated = created;
      if (!spDonationCounts_(a)) return;
      var pid = relId_(d,'person'); if (!pid) return;
      var received = a.received_at || a.completed_at || a.created_at; if (!received) return;
      seen[id]=1; rows.push([id, pid, Number(a.amount_cents||0), received]); added++;
    });
    url = (json.links && json.links.next) ? json.links.next : null;
  }

  var cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-SH_GIVING_MONTHS); var cutoffTs = cutoff.getTime();
  rows = rows.filter(function(r){ return new Date(r[3]).getTime() >= cutoffTs; });

  sh.clearContents();
  if (rows.length) sh.getRange(1,1,rows.length,4).setValues(rows);
  if (maxCreated) props.setProperty(SH_GIVING_WM_PROP, new Date(maxCreated).toISOString());
  Logger.log('   Ledger: +' + added + ' new, ' + rows.length + ' rows kept (' + pages + ' pages)');

  var byPerson = {};
  rows.forEach(function(r){ (byPerson[String(r[1])] = byPerson[String(r[1])] || { gifts:[] }).gifts.push({ cents:Number(r[2]), ts:new Date(r[3]).getTime() }); });
  return { byPerson: byPerson };
}
function spEmptyGiving_() {
  return { monthsGiven:0, gifts:0, totalCents:0, recurring:false, trend:'none',
           giftsEarlyHalf:0, giftsRecentHalf:0, firstGiftAt:null, lastGiftAt:null, lastGiftDaysAgo:null };
}
function spStoreGivingCache_(obj) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SH_GIVING_SHEET) || ss.insertSheet(SH_GIVING_SHEET);
  try { sh.hideSheet(); } catch (e) {}
  var json = JSON.stringify(obj), chunks = [];
  for (var i=0;i<json.length;i+=SH_CELL_CHUNK) chunks.push([json.substr(i, SH_CELL_CHUNK)]);
  sh.clearContents();
  if (chunks.length) sh.getRange(1,1,chunks.length,1).setValues(chunks);
}
function spReadGivingCache_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SH_GIVING_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow(); if (!last) return null;
  var json = sh.getRange(1,1,last,1).getValues().map(function(r){ return r[0]; }).join('');
  try { return (JSON.parse(json)||{}).giving || null; } catch (e) { return null; }
}

/* =========================================================
   Giving (24 mo, church-wide) → per person gift list
========================================================= */
function spGivingByPerson_(startMs) {
  var now = new Date();
  var since = new Date(now); since.setMonth(since.getMonth() - SH_GIVING_MONTHS);
  var sinceStr = Utilities.formatDate(since, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var byPerson = {};
  var url = 'https://api.planningcenteronline.com/giving/v2/donations?where[received_at][gte]=' + sinceStr +
            '&per_page=100&order=-received_at';
  var pages = 0;
  while (url && pages < 400) {
    if (shOverBudget_(startMs)) { Logger.log('   ! budget hit during giving pull — partial'); break; }
    pages++;
    var json;
    try { json = fgFetchPage_(url); } catch (e) { Logger.log('   ! giving page failed: ' + e.message); break; }
    (json.data||[]).forEach(function(d){
      var a = d.attributes || {};
      if (!spDonationCounts_(a)) return;
      var pid = relId_(d, 'person'); if (!pid) return;
      var received = a.received_at || a.completed_at || a.created_at; if (!received) return;
      var rec = byPerson[pid] || (byPerson[pid] = { gifts: [] });
      rec.gifts.push({ cents: Number(a.amount_cents||0), ts: new Date(received).getTime() });
    });
    url = (json.links && json.links.next) ? json.links.next : null;
  }
  Logger.log('   Donors (24mo): ' + Object.keys(byPerson).length + ' over ' + pages + ' pages');
  return byPerson;
}

function spDonationCounts_(a) {
  var s = String(a.payment_status||a.status||'').toLowerCase();
  if (s.indexOf('fail')!==-1||s.indexOf('cancel')!==-1||s.indexOf('declin')!==-1||s==='refunded'||s==='reversed') return false;
  if (a.refunded === true) return false;
  return Number(a.amount_cents||0) > 0;
}

function spRecurringDonorIds_() {
  var ids = new Set();
  try {
    (pcoGetAll_('/giving/v2/recurring_donations?per_page=100')||[]).forEach(function(r){
      var st = String((r.attributes||{}).status||'').toLowerCase();
      if (st && st !== 'active') return;
      var pid = relId_(r,'person'); if (pid) ids.add(pid);
    });
  } catch (e) { Logger.log('   ! recurring fetch failed: ' + e.message); }
  return ids;
}

/* =========================================================
   Household adults (joint-giving unit) → per person
========================================================= */
function spHouseholdAdultsByPerson_(ids, startMs) {
  var out = {};
  var pages = fgBatchFetch_(ids.map(function(id){ return '/people/v2/people/'+id+'/households?include=people&per_page=5'; }), startMs);
  ids.forEach(function(id, i){
    var page = pages[i];
    var adults = [id];
    if (page && page.included) {
      page.included.forEach(function(m){
        if (m.type !== 'Person') return;
        if ((m.attributes||{}).child === true) return;   // exclude kids
        if (String(m.id) !== id) adults.push(String(m.id));
      });
    }
    // de-dup
    out[id] = adults.filter(function(v,ix,arr){ return arr.indexOf(v)===ix; });
  });
  return out;
}

// Combine gifts across a person's household adults, then compute stats.
function spComputeGivingFor_(pid, adultIds, givingByPerson, recurringSet) {
  var gifts = [];
  var recurring = false;
  adultIds.forEach(function(aid){
    var rec = givingByPerson[aid];
    if (rec) gifts = gifts.concat(rec.gifts);
    if (recurringSet.has(aid)) recurring = true;
  });
  if (!gifts.length) {
    return { monthsGiven:0, gifts:0, totalCents:0, recurring:recurring, trend:'none', lastGiftAt:null, lastGiftDaysAgo:null };
  }
  var now = new Date().getTime();
  var half = new Date(); half.setMonth(half.getMonth() - SH_TREND_HALF); var halfTs = half.getTime();
  // median gift → outlier threshold
  var cents = gifts.map(function(g){ return g.cents; }).sort(function(a,b){ return a-b; });
  var median = cents.length % 2 ? cents[(cents.length-1)/2] : Math.round((cents[cents.length/2-1]+cents[cents.length/2])/2);
  var outlier = median * SH_OUTLIER_MULT;
  // Split the last-12 window into an early half (12–6 mo ago) and recent half
  // (last 6 mo) so we can tell whether giving is front-loaded or recent.
  var recentHalf = new Date(); recentHalf.setMonth(recentHalf.getMonth() - Math.round(SH_TREND_HALF/2)); var recentTs = recentHalf.getTime();
  var last12 = 0, prior12 = 0, last12all = 0, lastGiftTs = 0, firstGiftTs = 0;
  var giftsEarlyHalf = 0, giftsRecentHalf = 0, last12count = 0;
  gifts.forEach(function(g){
    var isLast = g.ts >= halfTs;
    if (isLast) {
      last12all += g.cents; last12count++;
      if (!firstGiftTs || g.ts < firstGiftTs) firstGiftTs = g.ts;
      if (g.ts >= recentTs) giftsRecentHalf++; else giftsEarlyHalf++;
    }
    if (g.ts > lastGiftTs) lastGiftTs = g.ts;
    var counted = (median > 0 && g.cents >= outlier) ? 0 : g.cents; // exclude one-offs from trend
    if (isLast) last12 += counted; else prior12 += counted;
  });
  var months = {};
  gifts.forEach(function(g){ if (g.ts >= halfTs) { var d=new Date(g.ts); months[d.getFullYear()+'-'+d.getMonth()] = 1; } });
  var trend = 'steady';
  if (prior12 === 0 && last12 > 0) trend = 'up';
  else if (last12 > prior12 * 1.15) trend = 'up';
  else if (last12 < prior12 * 0.85) trend = 'down';
  return {
    monthsGiven: Math.min(Object.keys(months).length, SH_TREND_HALF),
    gifts: last12count,
    totalCents: last12all,
    recurring: recurring,
    trend: trend,
    giftsEarlyHalf: giftsEarlyHalf,     // 12–6 months ago
    giftsRecentHalf: giftsRecentHalf,   // last 6 months
    firstGiftAt: firstGiftTs ? new Date(firstGiftTs).toISOString() : null,
    lastGiftAt: lastGiftTs ? new Date(lastGiftTs).toISOString() : null,
    lastGiftDaysAgo: lastGiftTs ? Math.floor((now - lastGiftTs)/86400000) : null
  };
}

/* =========================================================
   Group / Serve involvement
========================================================= */
function spGroupInvolvementByPerson_(startMs) {
  var byPerson = {};
  var types = pcoGetAll_('/groups/v2/group_types?per_page=100') || [];
  types.filter(function(t){
    var n = String(((t.attributes||{}).name||'')).toLowerCase();
    return n.indexOf('community group')!==-1 || n.indexOf('serve team')!==-1;
  }).forEach(function(t){
    if (shOverBudget_(startMs)) return;
    var bucket = String(((t.attributes||{}).name||'')).toLowerCase().indexOf('serve')!==-1 ? 'serve' : 'cg';
    var gs = pcoGetAll_('/groups/v2/group_types/'+t.id+'/groups?per_page=100') || [];
    if (!gs.length) return;
    var pages = fgBatchFetch_(gs.map(function(g){ return '/groups/v2/groups/'+g.id+'/memberships?per_page=100'; }), startMs);
    gs.forEach(function(g, i){
      var gName = (g.attributes&&g.attributes.name) || 'Untitled';
      ((pages[i]&&pages[i].data)||[]).forEach(function(m){
        var attr = m.attributes||{};
        if (attr.left_at || attr.removed_at) return;
        var pid = relId_(m,'person'); if (!pid) return;
        var rec = byPerson[pid] || (byPerson[pid]={cg:[],serve:[]});
        rec[bucket].push({ name:gName, role:attr.role||'member', joinedAt:attr.joined_at||'' });
      });
    });
  });
  return byPerson;
}

/* =========================================================
   Contact + shepherding/important-date fields — ONE reliable read
   include=field_data returns each person's custom fields in the same paginated,
   429-backed-off call as their contact info, so nothing gets dropped per-person.
========================================================= */
function spContactAndFields_(ids, startMs) {
  var contact = {}, fields = {}, membershipValues = {};
  var CHUNK = 25;
  for (var i=0; i<ids.length; i+=CHUNK) {
    if (shOverBudget_(startMs)) { Logger.log('   ! budget hit during people read — partial'); break; }
    var chunk = ids.slice(i, i+CHUNK), res;
    try {
      res = pcoGetAllWithIncluded_('/people/v2/people?where[id]=' + chunk.join(',') +
              '&include=emails,phone_numbers,field_data&per_page=' + chunk.length);
    } catch (e) { Logger.log('   ! people chunk failed: ' + e.message); continue; }
    var emailById = {}, phoneById = {}, fdByPerson = {};
    (res.included||[]).forEach(function(inc){
      if (inc.type==='Email') emailById[inc.id]=inc.attributes||{};
      else if (inc.type==='PhoneNumber') phoneById[inc.id]=inc.attributes||{};
      else if (inc.type==='FieldDatum') {
        var pid = String((((inc.relationships||{}).customizable||{}).data||{}).id||'');
        var defId = String((((inc.relationships||{}).field_definition||{}).data||{}).id||'');
        var v = (inc.attributes||{}).value;
        if (pid && defId && v != null && String(v).trim() !== '') { (fdByPerson[pid]=fdByPerson[pid]||{})[defId] = String(v).trim(); }
      }
    });
    (res.data||[]).forEach(function(p){
      var pid = String(p.id), a = p.attributes||{}, rel = p.relationships||{};
      var mt = String(a.membership||'').trim();
      if (mt) membershipValues[mt] = 1;
      contact[pid] = {
        email: spPickPrimary_(rel.emails, emailById, 'address'),
        phone: spPickPrimary_(rel.phone_numbers, phoneById, 'number'),
        member: /member|deacon|pastor/i.test(mt),
        membershipType: mt
      };
      var byDef = fdByPerson[pid] || {};
      var f = { statusRaw: byDef[SH_FIELD.healthAssess]||'', status: shNormStatus_(byDef[SH_FIELD.healthAssess]||''),
        healthDate: byDef[SH_FIELD.healthDate]||'', assignedElder: byDef[SH_FIELD.assignedElder]||'',
        spiritualMat: byDef[SH_FIELD.spiritualMat]||'', preferredComm: byDef[SH_FIELD.preferredComm]||'',
        known: byDef[SH_FIELD.known]||'', deaconSupport: byDef[SH_FIELD.deaconSupport]||'', deaconNotes: byDef[SH_FIELD.deaconNotes]||'',
        baptized: /true/i.test(byDef[SH_FIELD.baptized]||'') || !!byDef[SH_FIELD.baptismDate],
        importantDates: {
          baptism: byDef[SH_FIELD.baptismDate]||'', salvation: byDef[SH_FIELD.salvationDate]||'',
          firstVisit: byDef[SH_FIELD.firstVisit]||'', childDedication: byDef[SH_FIELD.childDedication]||'',
          membershipStart: byDef[SH_FIELD.membershipStart]||''
        } };
      fields[pid] = f;
    });
  }
  return { contact: contact, fields: fields, membershipValues: Object.keys(membershipValues) };
}
function spPickPrimary_(relObj, byId, key) {
  try {
    var list = (relObj&&relObj.data)||[], firstVal='';
    for (var i=0;i<list.length;i++){ var it=byId[list[i].id]; if(!it) continue; var v=it[key]||'';
      if(!firstVal&&v) firstVal=v; if(it.primary&&v) return v; }
    return firstVal;
  } catch (e) { return ''; }
}

/* =========================================================
   New Family Member workflow — people still in the join process (not yet members)
========================================================= */
var SH_WF_NEW_FAMILY_ID = '528798';
function spNewFamilyMembers_(startMs) {
  var out = [];
  try {
    var res = pcoGetAllWithIncluded_('/people/v2/workflows/' + SH_WF_NEW_FAMILY_ID + '/cards?include=person,current_step&per_page=100');
    var stepName = {}, persons = {};
    (res.included||[]).forEach(function(x){
      if (x.type==='WorkflowStep') stepName[x.id] = (x.attributes||{}).name;
      if (x.type==='Person') persons[x.id] = x.attributes||{};
    });
    (res.data||[]).forEach(function(c){
      var a = c.attributes||{};
      if (String(a.stage)==='completed') return;                    // still in process only
      var pid = relId_(c,'person'); if (!pid) return;
      var pa = persons[pid] || {};
      if (/member|deacon|pastor/i.test(String(pa.membership||''))) return;  // members already finished — skip
      var stepId = relId_(c,'current_step');
      out.push({ id:String(pid), first:pa.first_name||'', last:pa.last_name||'',
                 name:((pa.first_name||'')+' '+(pa.last_name||'')).trim()||('Person '+pid),
                 membership:String(pa.membership||''), step:stepName[stepId]||'', cardId:c.id });
    });
  } catch (e) { Logger.log('   ! new family fetch failed: ' + e.message); }
  return out;
}

/* =========================================================
   Unassigned members — Members/Deacons/Pastors with no Assigned Elder
========================================================= */
function spUnassignedMembers_(assignedSet, startMs) {
  var out = [];
  try {
    ['Member','Deacon','Pastor'].forEach(function(mt){
      if (shOverBudget_(startMs)) return;
      var url = 'https://api.planningcenteronline.com/people/v2/people?where[membership]=' + encodeURIComponent(mt) + '&per_page=100';
      var people = pcoGetAll_(url) || [];
      people.forEach(function(p){
        var id = String(p.id);
        if (assignedSet[id]) return;                 // already shepherded
        if (out.some(function(x){ return x.id===id; })) return;
        var a = p.attributes||{};
        var full = ((a.first_name||'')+' '+(a.last_name||'')).trim();
        out.push({ id:id, first:a.first_name||'', last:a.last_name||'', name:full||('Person '+id), member:true });
      });
    });
  } catch (e) { Logger.log('   ! unassigned fetch failed: ' + e.message); }
  out.sort(function(a,b){ return a.name.localeCompare(b.name); });
  return out;
}

/* =========================================================
   Build person + PACI score
========================================================= */
function spBuildPerson_(base, giving, grp, contact, fld, manual) {
  grp = grp || {cg:[],serve:[]};
  contact = contact || {email:'',phone:'',member:base.member,membershipType:''};
  fld = fld || {status:'unknown', importantDates:{}};

  var cgLeader = grp.cg.some(function(x){ return /leader/i.test(x.role); });
  var serveLeader = grp.serve.some(function(x){ return /leader/i.test(x.role); });
  var leads = cgLeader || serveLeader;
  var scored = spComputeScore_({
    monthsGiven: giving.monthsGiven, recurring: giving.recurring, totalCents: giving.totalCents,
    inCG: grp.cg.length>0, cgLeader: cgLeader, serveCount: grp.serve.length, serveLeader: serveLeader
  });
  var paci = spPaci_(scored.score, leads);
  var trajectory = giving.trend==='up' ? 'up' : giving.trend==='down' ? 'down' : 'steady';
  var healthDaysAgo = spHealthDaysAgo_(fld.healthDate);
  var overdue = (healthDaysAgo == null) || (healthDaysAgo > SH_OVERDUE_DAYS);
  var givesRegular = giving.recurring || giving.monthsGiven>=6;

  var flags = [];
  if (grp.cg.length===0) flags.push('Not in a group');
  if (grp.serve.length===0) flags.push('Not serving');
  if (giving.gifts===0) flags.push('No recent giving');
  else if (giving.trend==='down') flags.push('Giving declined');
  if (!fld.baptized) flags.push('Not baptized');
  if (overdue) flags.push('Check-in overdue');
  if (!contact.email && !contact.phone) flags.push('No contact info');
  if (fld.status==='lost' || fld.status==='could-not-contact') flags.push('Out of contact');

  var nextStep = spComputeNextStep_({
    status: fld.status, inCG: grp.cg.length>0, serving: grp.serve.length>0, leads: leads,
    givesRegular: givesRegular, gaveAny: giving.gifts>0, givingTrend: giving.trend,
    baptized: fld.baptized, paci: paci
  });

  return {
    id: base.id, name: base.name, first: base.first, last: base.last,
    email: contact.email||'', phone: contact.phone||'', member: !!(contact.member||base.member),
    membershipType: contact.membershipType||'',
    status: fld.status, statusRaw: fld.statusRaw||'', healthDate: fld.healthDate||'', healthDaysAgo: healthDaysAgo, overdue: overdue,
    assignedElder: fld.assignedElder||'', spiritualMat: fld.spiritualMat||'',
    maturityManual: manual || null,
    preferredComm: fld.preferredComm||'',
    known: fld.known||'', deaconSupport: fld.deaconSupport||'', deaconNotes: fld.deaconNotes||'',
    baptized: !!fld.baptized, importantDates: fld.importantDates||{},
    score: scored.score, paci: paci, leads: leads, trajectory: trajectory, nextStep: nextStep,
    pillars: scored.pillars,
    giving: { monthsGiven:giving.monthsGiven, gifts:giving.gifts, totalCents:giving.totalCents,
              recurring:giving.recurring, trend:giving.trend, givesRegular:givesRegular,
              giftsEarlyHalf:giving.giftsEarlyHalf, giftsRecentHalf:giving.giftsRecentHalf,
              firstGiftAt:giving.firstGiftAt, lastGiftAt:giving.lastGiftAt, lastGiftDaysAgo:giving.lastGiftDaysAgo },
    groups: grp.cg, serveTeams: grp.serve, flags: flags
  };
}

// Days since a MM/DD/YYYY (or ISO) health-assessment date; null if none/unparseable.
function spHealthDaysAgo_(d) {
  if (!d) return null;
  var t = null;
  var m = String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) t = new Date(+m[3], +m[1]-1, +m[2]).getTime();
  else { var dt = new Date(d); if (!isNaN(dt.getTime())) t = dt.getTime(); }
  if (t == null) return null;
  return Math.floor((new Date().getTime() - t) / 86400000);
}

// The single highest-impact next step to grow this person's maturity.
function spComputeNextStep_(x) {
  if (x.status==='lost' || x.status==='could-not-contact') return { code:'reconnect', text:'Re-establish contact — reach out personally' };
  if (x.status==='wandering') return { code:'reconnect', text:'Check in — they may be drifting' };
  if (!x.baptized) return { code:'baptism', text:'Invite them toward baptism' };
  if (!x.inCG) return { code:'group', text:'Get them into a community group' };
  if (!x.serving) return { code:'serve', text:'Invite them onto a serve team' };
  if (!x.gaveAny) return { code:'give', text:'Encourage first steps in generosity' };
  if (!x.givesRegular || x.givingTrend==='down') return { code:'give', text:'Encourage consistent / recurring giving' };
  if (x.paci==='parent' || x.leads) return { code:'lead', text:'Pour into them — they can disciple others' };
  return { code:'lead', text:'Invite them to lead or mentor someone' };
}

// GIVING 35 + GROUP 30 + SERVE 35 → 1-10.
// Giving rewards CONSISTENCY *or* generous AMOUNT (whichever is stronger), so a
// big giver who gives in only a few months isn't scored as disengaged. Serving
// scales with number of teams. (Annual $ tiers ~ this congregation's quartiles.)
function spComputeScore_(x) {
  var dollars = (x.totalCents||0)/100;
  var consistency = Math.min(35, (Math.min(x.monthsGiven,12)/12)*25 + (x.recurring?10:0));
  var amount = dollars>=15000 ? 35 : dollars>=6000 ? 28 : dollars>=2000 ? 20 : dollars>0 ? 10 : 0;
  var giving = Math.max(consistency, amount);
  var group = x.cgLeader ? 30 : (x.inCG ? 22 : 0);
  var serve = x.serveLeader ? 35 : (x.serveCount>=1 ? [0,20,27,32,35][Math.min(x.serveCount,4)] : 0);
  var total = Math.max(0, Math.min(100, giving + group + serve));
  return { score: Math.max(1, Math.round(total/10)),
           pillars: { giving:Math.round(giving), group:group, serve:serve } };
}
function spPaci_(score, leads) {
  if (score >= 7) return leads ? 'parent' : 'adult';
  if (score >= 4) return 'child';
  return 'infant';
}

/* =========================================================
   Aggregates
========================================================= */
function spSummarize_(people) {
  var n = people.length;
  var s = { totalPeople:n, avgScore:0, inGroup:0, serving:0, leading:0, givingRegular:0, recurring:0,
            givingGrowing:0, noRecentGiving:0, needsAttention:0, overdue:0, notBaptized:0,
            notInGroup:0, notServing:0, notGiving:0,
            paciCounts:{parent:0,adult:0,child:0,infant:0},
            statusCounts:{healthy:0,weak:0,wandering:0,lost:0,'could-not-contact':0,unknown:0} };
  if (!n) return s;
  var sum = 0;
  people.forEach(function(p){
    sum += p.score||0;
    if (p.groups && p.groups.length) s.inGroup++; else s.notInGroup++;
    if (p.serveTeams && p.serveTeams.length) s.serving++; else s.notServing++;
    if (p.leads) s.leading++;
    if (p.giving) {
      if (p.giving.givesRegular) s.givingRegular++;
      if (p.giving.recurring) s.recurring++;
      if (p.giving.trend==='up') s.givingGrowing++;
      if (p.giving.gifts===0) { s.noRecentGiving++; s.notGiving++; }
    }
    if (p.overdue) s.overdue++;
    if (!p.baptized) s.notBaptized++;
    if (s.paciCounts.hasOwnProperty(p.paci)) s.paciCounts[p.paci]++;
    var st = s.statusCounts.hasOwnProperty(p.status) ? p.status : 'unknown';
    s.statusCounts[st]++;
    // Needs attention = a pastor-assessed concern, NOT merely low activity. An
    // "infant" who's healthy doesn't need attention. (Overdue has its own metric.)
    if (p.status==='lost' || p.status==='weak' || p.status==='could-not-contact') s.needsAttention++;
  });
  s.avgScore = Math.round((sum/n)*10)/10;
  s.pct = { inGroup:s.inGroup/n, serving:s.serving/n, leading:s.leading/n,
            givingRegular:s.givingRegular/n, recurring:s.recurring/n, givingGrowing:s.givingGrowing/n,
            overdue:s.overdue/n, notBaptized:s.notBaptized/n };
  return s;
}

/* =========================================================
   Private store (hidden sheet, chunked)
========================================================= */
function spStorePrivate_(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SH_PRIVATE_SHEET) || ss.insertSheet(SH_PRIVATE_SHEET);
  try { sh.hideSheet(); } catch (e) {}
  var json = JSON.stringify(data), chunks = [];
  for (var i=0;i<json.length;i+=SH_CELL_CHUNK) chunks.push([json.substr(i, SH_CELL_CHUNK)]);
  sh.clearContents();
  if (chunks.length) sh.getRange(1,1,chunks.length,1).setValues(chunks);
  Logger.log('   Stored private data: ' + json.length + ' chars / ' + chunks.length + ' cells');
}
function spReadPrivate_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SH_PRIVATE_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow(); if (!last) return null;
  var json = sh.getRange(1,1,last,1).getValues().map(function(r){ return r[0]; }).join('');
  if (!json) return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}

/* =========================================================
   Public seed (sanitised — safe fields only)
========================================================= */
function spBuildPublicSeed_(full) {
  var safe = { 'Not in a group':1, 'Not serving':1 };
  function san(p){ return { id:null, name:p.name, first:p.first, last:p.last, email:'', phone:'', member:false,
    membershipType:'', status:'unknown', statusRaw:'', healthDate:'', healthDaysAgo:null, overdue:false,
    assignedElder:'', spiritualMat:'', maturityManual:null, preferredComm:'',
    baptized:false, importantDates:{}, nextStep:null,
    score:null, paci:null, leads:!!p.leads, trajectory:'steady', pillars:null, giving:null,
    newFamilyMember:!!p.newFamilyMember, familyStep:p.familyStep||'',
    groups:p.groups||[], serveTeams:p.serveTeams||[], flags:(p.flags||[]).filter(function(f){return safe[f];}), pending:true }; }
  var elders = (full.elders||[]).map(function(e){
    var people = e.people.map(san);
    return { elder:e.elder, list:e.list, unassigned:!!e.unassigned, summary:spSummarize_(people), people:people };
  });
  var uniq=[], seen={};
  elders.forEach(function(e){ e.people.forEach(function(p){ if(!seen[p.name]){seen[p.name]=1;uniq.push(p);} }); });
  var cong = spSummarize_(uniq); cong.totalPeople = uniq.length;
  return { generatedAt:full.generatedAt, asOf:full.asOf, givingMonths:full.givingMonths,
           statusVocab:full.statusVocab, paciVocab:full.paciVocab, seed:true, congregation:cong, elders:elders };
}

/* =========================================================
   Push public seed
========================================================= */
function spPushToGitHub_(data) {
  var owner=getProp_('GITHUB_OWNER'), token=getProp_('GITHUB_TOKEN'), repo=getProp_('GITHUB_REPO');
  var branch=propOptional_('GITHUB_BRANCH')||'main';
  var url='https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+SH_OUTPUT_FILE;
  var hdrs={Authorization:'token '+token, Accept:'application/vnd.github.v3+json'};
  var ex=UrlFetchApp.fetch(url+'?ref='+branch,{method:'get',muteHttpExceptions:true,headers:hdrs});
  var sha=null; if(ex.getResponseCode()===200){ try{ sha=JSON.parse(ex.getContentText()).sha; }catch(e){} }
  var payload={ message:'Update shepherding health data', branch:branch,
                content:Utilities.base64Encode(JSON.stringify(data,null,2), Utilities.Charset.UTF_8) };
  if(sha) payload.sha=sha;
  var res=UrlFetchApp.fetch(url,{method:'put',contentType:'application/json',muteHttpExceptions:true,headers:hdrs,payload:JSON.stringify(payload)});
  var code=res.getResponseCode();
  if(code<200||code>=300) throw new Error('Shepherding push failed: '+code+' — '+res.getContentText().substring(0,200));
  Logger.log('✓ Pushed '+SH_OUTPUT_FILE);
}

/* =========================================================
   Triggers
========================================================= */
function installShepherdingHealthTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){ var h=t.getHandlerFunction();
    if (h==='syncShepherdingHealth_' || h==='syncShepherdingGiving_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncShepherdingHealth_').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncShepherdingGiving_').timeBased().everyDays(1).atHour(4).create();
  Logger.log('Triggers installed: hourly health + daily giving (4am).');
}
function runShepherdingHealthNow() { syncShepherdingHealth_(); }
function runShepherdingGivingNow() { syncShepherdingGiving_(); }
function spEnsureShepherdingTrigger_() {
  var ts = ScriptApp.getProjectTriggers();
  if (!ts.some(function(t){ return t.getHandlerFunction()==='syncShepherdingHealth_'; }))
    ScriptApp.newTrigger('syncShepherdingHealth_').timeBased().everyHours(1).create();
  if (!ts.some(function(t){ return t.getHandlerFunction()==='syncShepherdingGiving_'; }))
    ScriptApp.newTrigger('syncShepherdingGiving_').timeBased().everyDays(1).atHour(4).create();
}
