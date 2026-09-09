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
const SH_GIVING_SHEET     = 'ShepherdingGiving';   // cached giving stats (pid → stats), refreshed daily
const SH_CELL_CHUNK       = 40000;

// SHA-256 of the shepherding page password ("1peter5"). var (not const) so the
// web-app and actions files reliably see it — cross-file top-level const/let
// sharing is unreliable in Apps Script. Keep in sync with PASTOR_HASH in index.html.
var SHEPHERDING_PW_HASH   = '19714e8203cc3d5e9f7c4a4499981a5d37448d56e193336b3ed32913abbc3b3d';

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
  deaconNotes:    '1082244'  // text
};

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
  var allIds = [], seenId = {};
  lists.forEach(function(l){ l.people.forEach(function(p){ if (p.id && !seenId[p.id]) { seenId[p.id]=1; allIds.push(p.id); } }); });
  Logger.log('   Elders: ' + lists.length + ' · unique people: ' + allIds.length);
  if (!allIds.length) { Logger.log('   ! no people — aborting (keeping previous)'); return; }

  // Essential, cheap reads that always complete inside the budget.
  var groups  = spGroupInvolvementByPerson_(startMs);  // id → {cg:[],serve:[]}
  var contact = spContactByPerson_(allIds, startMs);   // id → {email,phone,member}
  var fields  = spFieldsByPerson_(allIds, startMs);    // id → {status,healthDate,assignedElder,spiritualMat,...}
  // Giving comes from the daily cache (heavy 24-mo + household work runs separately).
  var givingCache = spReadGivingCache_() || {};

  var eldersOut = lists.map(function(l){
    var people = l.people.map(function(p){
      var giving = givingCache[p.id] || spEmptyGiving_();
      return spBuildPerson_(p, giving, groups[p.id], contact[p.id], fields[p.id]);
    }).sort(function(a,b){ return (a.score||0)-(b.score||0) || a.name.localeCompare(b.name); }); // infants first within elder
    return { elder: l.elder, list: l.list, summary: spSummarize_(people), people: people };
  });

  var uniq = [], seenU = {};
  eldersOut.forEach(function(e){ e.people.forEach(function(p){ if (p.id && !seenU[p.id]) { seenU[p.id]=1; uniq.push(p); } }); });

  var out = {
    generatedAt: new Date().toISOString(),
    asOf: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    givingMonths: SH_TREND_HALF,
    statusVocab: SH_STATUS_VOCAB,
    paciVocab: ['parent','adult','child','infant'],
    elderOptions: spElderOptions_(),        // for the reassign-pastor dropdown (full names)
    congregation: spSummarize_(uniq),
    elders: eldersOut
  };
  out.congregation.totalPeople = uniq.length;

  spStorePrivate_(out);
  spPushToGitHub_(spBuildPublicSeed_(out));
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

  var givingByPerson  = spGivingByPerson_(startMs);
  var recurring       = spRecurringDonorIds_();
  var householdAdults = spHouseholdAdultsByPerson_(allIds, startMs);

  var map = {};
  allIds.forEach(function(id){ map[id] = spComputeGivingFor_(id, householdAdults[id]||[id], givingByPerson, recurring); });
  spStoreGivingCache_({ generatedAt: new Date().toISOString(), giving: map });
  Logger.log('✓ Shepherding Giving — cached ' + allIds.length + ' people in ' + Math.round(shElapsed_(startMs)/1000) + 's');
}
function spEmptyGiving_() {
  return { monthsGiven:0, gifts:0, totalCents:0, recurring:false, trend:'none', lastGiftAt:null, lastGiftDaysAgo:null };
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
  var last12 = 0, prior12 = 0, last12all = 0, monthsSet = {}, lastGiftTs = 0;
  gifts.forEach(function(g){
    var isLast = g.ts >= halfTs;
    if (isLast) { last12all += g.cents; monthsSet[Math.floor((g.ts)/1)+''] = 1; }
    if (g.ts > lastGiftTs) lastGiftTs = g.ts;
    var counted = (median > 0 && g.cents >= outlier) ? 0 : g.cents; // exclude one-offs from trend
    if (isLast) last12 += counted; else prior12 += counted;
  });
  // months given = distinct YYYY-MM in last 12
  var months = {};
  gifts.forEach(function(g){ if (g.ts >= halfTs) { var d=new Date(g.ts); months[d.getFullYear()+'-'+d.getMonth()] = 1; } });
  var trend = 'steady';
  if (prior12 === 0 && last12 > 0) trend = 'up';
  else if (last12 > prior12 * 1.15) trend = 'up';
  else if (last12 < prior12 * 0.85) trend = 'down';
  return {
    monthsGiven: Math.min(Object.keys(months).length, SH_TREND_HALF),
    gifts: gifts.length,
    totalCents: last12all,
    recurring: recurring,
    trend: trend,
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
        rec[bucket].push({ name:gName, role:attr.role||'member' });
      });
    });
  });
  return byPerson;
}

/* =========================================================
   Contact info (email/phone/membership)
========================================================= */
function spContactByPerson_(ids, startMs) {
  var out = {};
  var CHUNK = 25;
  for (var i=0; i<ids.length; i+=CHUNK) {
    if (shOverBudget_(startMs)) { Logger.log('   ! budget hit during contact — partial'); break; }
    var chunk = ids.slice(i, i+CHUNK), res;
    try {
      res = pcoGetAllWithIncluded_('/people/v2/people?where[id]=' + chunk.join(',') +
              '&include=emails,phone_numbers&per_page=' + chunk.length);
    } catch (e) { Logger.log('   ! contact chunk failed: ' + e.message); continue; }
    var emailById = {}, phoneById = {};
    (res.included||[]).forEach(function(inc){
      if (inc.type==='Email') emailById[inc.id]=inc.attributes||{};
      else if (inc.type==='PhoneNumber') phoneById[inc.id]=inc.attributes||{};
    });
    (res.data||[]).forEach(function(p){
      var a = p.attributes||{}, rel = p.relationships||{};
      out[String(p.id)] = {
        email: spPickPrimary_(rel.emails, emailById, 'address'),
        phone: spPickPrimary_(rel.phone_numbers, phoneById, 'number'),
        member: /member|deacon|pastor/i.test(String(a.membership||''))
      };
    });
  }
  return out;
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
   Shepherding-tab fields (exact ids)
========================================================= */
function spFieldsByPerson_(ids, startMs) {
  var out = {};
  var pages = fgBatchFetch_(ids.map(function(id){ return '/people/v2/people/'+id+'/field_data?per_page=100'; }), startMs);
  ids.forEach(function(id, i){
    var rows = (pages[i]&&pages[i].data)||[];
    var byDef = {};
    rows.forEach(function(fd){
      var defId = String((((fd.relationships||{}).field_definition||{}).data||{}).id||'');
      var v = (fd.attributes||{}).value;
      if (defId && v != null && String(v).trim() !== '') byDef[defId] = String(v).trim();
    });
    out[id] = {
      statusRaw: byDef[SH_FIELD.healthAssess] || '',
      status: shNormStatus_(byDef[SH_FIELD.healthAssess] || ''),
      healthDate: byDef[SH_FIELD.healthDate] || '',
      assignedElder: byDef[SH_FIELD.assignedElder] || '',
      spiritualMat: byDef[SH_FIELD.spiritualMat] || '',
      preferredComm: byDef[SH_FIELD.preferredComm] || '',
      known: byDef[SH_FIELD.known] || '',
      deaconSupport: byDef[SH_FIELD.deaconSupport] || '',
      deaconNotes: byDef[SH_FIELD.deaconNotes] || ''
    };
  });
  return out;
}

/* =========================================================
   Build person + PACI score
========================================================= */
function spBuildPerson_(base, giving, grp, contact, fld) {
  grp = grp || {cg:[],serve:[]};
  contact = contact || {email:'',phone:'',member:base.member};
  fld = fld || {status:'unknown'};

  var cgLeader = grp.cg.some(function(x){ return /leader/i.test(x.role); });
  var serveLeader = grp.serve.some(function(x){ return /leader/i.test(x.role); });
  var leads = cgLeader || serveLeader;
  var scored = spComputeScore_({
    monthsGiven: giving.monthsGiven, recurring: giving.recurring,
    inCG: grp.cg.length>0, cgLeader: cgLeader, serveCount: grp.serve.length, serveLeader: serveLeader
  });
  var paci = spPaci_(scored.score, leads);
  var trajectory = giving.trend==='up' ? 'up' : giving.trend==='down' ? 'down' : 'steady';

  var flags = [];
  if (grp.cg.length===0) flags.push('Not in a group');
  if (grp.serve.length===0) flags.push('Not serving');
  if (giving.gifts===0) flags.push('No recent giving');
  else if (giving.trend==='down') flags.push('Giving declined');
  if (!contact.email && !contact.phone) flags.push('No contact info');
  if (fld.status==='lost' || fld.status==='could-not-contact') flags.push('Out of contact');

  return {
    id: base.id, name: base.name, first: base.first, last: base.last,
    email: contact.email||'', phone: contact.phone||'', member: !!(contact.member||base.member),
    status: fld.status, statusRaw: fld.statusRaw||'', healthDate: fld.healthDate||'',
    assignedElder: fld.assignedElder||'', spiritualMat: fld.spiritualMat||'',
    preferredComm: fld.preferredComm||'',
    score: scored.score, paci: paci, leads: leads, trajectory: trajectory,
    pillars: scored.pillars,
    giving: { monthsGiven:giving.monthsGiven, gifts:giving.gifts, totalCents:giving.totalCents,
              recurring:giving.recurring, trend:giving.trend, lastGiftAt:giving.lastGiftAt,
              lastGiftDaysAgo:giving.lastGiftDaysAgo },
    groups: grp.cg, serveTeams: grp.serve, flags: flags
  };
}

// GIVING 35 + GROUP 35 + SERVE 30 → 1-10
function spComputeScore_(x) {
  var giving = Math.min(35, (Math.min(x.monthsGiven,12)/12)*30 + (x.recurring?10:0));
  var group = x.cgLeader ? 35 : (x.inCG ? 25 : 0);
  var serve = x.serveLeader ? 30 : (x.serveCount>=1 ? 18 + Math.min(x.serveCount-1,2)*4 : 0);
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
            givingGrowing:0, noRecentGiving:0, needsAttention:0,
            paciCounts:{parent:0,adult:0,child:0,infant:0},
            statusCounts:{healthy:0,weak:0,wandering:0,lost:0,'could-not-contact':0,unknown:0} };
  if (!n) return s;
  var sum = 0;
  people.forEach(function(p){
    sum += p.score||0;
    if (p.groups && p.groups.length) s.inGroup++;
    if (p.serveTeams && p.serveTeams.length) s.serving++;
    if (p.leads) s.leading++;
    if (p.giving) {
      if (p.giving.recurring || p.giving.monthsGiven>=6) s.givingRegular++;
      if (p.giving.recurring) s.recurring++;
      if (p.giving.trend==='up') s.givingGrowing++;
      if (p.giving.gifts===0) s.noRecentGiving++;
    }
    if (s.paciCounts.hasOwnProperty(p.paci)) s.paciCounts[p.paci]++;
    var st = s.statusCounts.hasOwnProperty(p.status) ? p.status : 'unknown';
    s.statusCounts[st]++;
    if (p.paci==='infant' || p.status==='lost' || p.status==='weak' || p.status==='could-not-contact') s.needsAttention++;
  });
  s.avgScore = Math.round((sum/n)*10)/10;
  s.pct = { inGroup:s.inGroup/n, serving:s.serving/n, leading:s.leading/n,
            givingRegular:s.givingRegular/n, recurring:s.recurring/n, givingGrowing:s.givingGrowing/n };
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
    status:'unknown', statusRaw:'', healthDate:'', assignedElder:'', spiritualMat:'', preferredComm:'',
    score:null, paci:null, leads:!!p.leads, trajectory:'steady', pillars:null, giving:null,
    groups:p.groups||[], serveTeams:p.serveTeams||[], flags:(p.flags||[]).filter(function(f){return safe[f];}), pending:true }; }
  var elders = (full.elders||[]).map(function(e){
    var people = e.people.map(san);
    return { elder:e.elder, list:e.list, summary:spSummarize_(people), people:people };
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
