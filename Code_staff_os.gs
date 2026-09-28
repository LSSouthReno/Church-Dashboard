/**
 * Staff OS — per-staff-member workspace backend.
 *
 * Personal dashboards for each staff member: To-Do tasks (assignable to other
 * staff with a note), Rocks / Boulders / Areas of Focus, and Annual Plan goals
 * (metric · target · current · progress) with action steps.
 *
 * Storage: three tabs in the bound "Church Dashboard auto" spreadsheet —
 *   StaffRoster [name, role, pin]
 *   StaffTasks  [id, owner, title, notes, status, due, priority, assignedBy, createdAt, updatedAt, planId]
 *   StaffPlans  [id, owner, type, title, detail, period, status, progress, metric, target, current, parentId, createdAt, updatedAt]
 *
 * Wired into the shared web app via Code_eos_webapp.gs doGet/doPost dispatch
 * (actions prefixed `sos_`). Front-end talks to STAFF_OS_WEBAPP_URL in index.html.
 * Returns JSON via eosWaJson_ (shared helper).
 */

var SOS_GET_ACTIONS_  = ['sos_roster', 'sos_data', 'sos_seed_pins', 'sos_pco_lists', 'sos_pin_diag'];
var SOS_POST_ACTIONS_ = ['sos_task_add', 'sos_task_update', 'sos_task_delete',
                         'sos_plan_add', 'sos_plan_update', 'sos_plan_delete', 'sos_signin', 'sos_login', 'sos_img', 'sos_import_plans'];
var SOS_ADMINS_ = ['Brad Borowski', 'Ryan Griffin'];  // can cycle through & edit everyone

var SOS_ROSTER_SEED_ = [
  ['Brad Borowski', 'Executive Pastor'], ['John Conelea', 'Creative / Worship'],
  ['Katie Thompson', 'Executive & Students Coordinator'], ['Ryan Griffin', 'Pastor'],
  ['Isaac Griffin', 'Pastor'], ['Deana Griffin', 'Staff'], ['Adam Carp', 'Staff'],
  ['Geoffrey Caliger', 'Kids'], ['Gordon Fava', 'Staff'], ['Keith Primus', 'Staff'],
  ['Rachel Primus', 'Staff']
];

function sosDoGet_(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'sos_roster') return eosWaJson_({ ok: true, roster: sosRoster_() });
  if (action === 'sos_data') {
    var who = (e && e.parameter && e.parameter.who) || '';
    // One read per sheet (was two task-sheet reads per load).
    var allTasks = sosRows_('StaffTasks', SOS_TASK_HDRS_);
    var mine = allTasks.filter(function(t){ return String(t.owner) === who; });
    var assigned = mine.filter(function(t){ return t.assignedBy && String(t.assignedBy) !== who; });
    return eosWaJson_({ ok: true, who: who, tasks: mine, assigned: assigned, plans: sosPlansFor_(who), roster: sosRoster_() });
  }
  if (action === 'sos_pin_diag') return eosWaJson_(sosPinDiag_());
  if (action === 'sos_pco_lists') return eosWaJson_(sosPcoLists_(((e && e.parameter && e.parameter.refresh) || '') === '1'));
  if (action === 'sos_seed_pins') {
    // Preview by default; pass &confirm=lssr to actually write PINs.
    var dry = ((e && e.parameter && e.parameter.confirm) || '') !== 'lssr';
    return eosWaJson_(sosSeedPinsFromPCO_(dry));
  }
  return eosWaJson_({ ok: false, error: 'Unknown staff-os action' });
}

function sosDoPost_(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) {}
  var action = body.action || '';
  // Read-only actions never wait on the write lock (keeps photos + login fast).
  if (action === 'sos_img')   return eosWaJson_(sosImgProxy_(body));
  if (action === 'sos_login') return eosWaJson_(sosLogin_(body));
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (x) {}
  try {
    if (action === 'sos_signin')      return eosWaJson_(sosSignin_(body));
    if (action === 'sos_task_add')    return eosWaJson_(sosTaskAdd_(body));
    if (action === 'sos_task_update') return eosWaJson_(sosRowUpdate_('StaffTasks', body));
    if (action === 'sos_task_delete') return eosWaJson_(sosRowDelete_('StaffTasks', body.id));
    if (action === 'sos_plan_add')    return eosWaJson_(sosPlanAdd_(body));
    if (action === 'sos_plan_update') return eosWaJson_(sosRowUpdate_('StaffPlans', body));
    if (action === 'sos_plan_delete') return eosWaJson_(sosRowDelete_('StaffPlans', body.id));
    if (action === 'sos_import_plans') return eosWaJson_(sosImportPlans_(body));
    return eosWaJson_({ ok: false, error: 'Unknown staff-os action' });
  } finally { try { lock.releaseLock(); } catch (x) {} }
}

// ── Sheet helpers ────────────────────────────────────────────────────────────
function sosSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, headers.length).setValues([headers]); sh.setFrozenRows(1); }
  return sh;
}
// planId = the Annual Plan action step this task was sent from (checking one off checks the other).
var SOS_TASK_HDRS_ = ['id', 'owner', 'title', 'notes', 'status', 'due', 'priority', 'assignedBy', 'createdAt', 'updatedAt', 'planId'];
var SOS_PLAN_HDRS_ = ['id', 'owner', 'type', 'title', 'detail', 'period', 'status', 'progress', 'metric', 'target', 'current', 'parentId', 'createdAt', 'updatedAt'];

function sosRows_(name, headers) {
  var sh = sosSheet_(name, headers);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var tz = Session.getScriptTimeZone();
  return vals.filter(function(r){ return r[0] !== '' && r[0] != null; }).map(function(r){
    var o = {}; headers.forEach(function(h, i){ o[h] = r[i]; });
    // Sheets turns a typed "2026-09-23" into a Date cell; hand the page back the plain day.
    if (o.due instanceof Date && !isNaN(o.due.getTime())) o.due = Utilities.formatDate(o.due, tz, 'yyyy-MM-dd');
    return o;
  });
}
function sosId_() { return 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

// PINs: a cell may hold several ("1234, 5678" = last 4 of each of the person's phones).
// Numbers are padded back to 4 digits (Sheets turns "0482" into 482).
function sosPinList_(cell) {
  if (typeof cell === 'number') return [String(Math.round(cell)).padStart(4, '0')];
  return String(cell == null ? '' : cell).split(/[^0-9]+/).filter(function(x){ return x.length >= 3; })
    .map(function(x){ return x.length < 4 ? x.padStart(4, '0') : x; });
}
// Roster rows, cached in CacheService so sign-in and the roster never wait on the big
// (and often busy) dashboard spreadsheet. Cleared whenever PINs are re-seeded.
function sosRosterRows_() {
  var cache = CacheService.getScriptCache(), hit = null;
  try { hit = cache.get('SOS_ROSTER_ROWS_V2'); } catch (x) {}
  if (hit) { try { return JSON.parse(hit); } catch (x) {} }
  var sh = sosSheet_('StaffRoster', ['name', 'role', 'pin']);
  if (sh.getLastRow() < 2) {
    var seed = SOS_ROSTER_SEED_.map(function(r){ return [r[0], r[1], '']; });
    sh.getRange(2, 1, seed.length, 3).setValues(seed);
  }
  var last = sh.getLastRow();
  var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 3).getValues().filter(function(r){ return r[0]; })
    .map(function(r){ return { name: String(r[0]), role: String(r[1] || ''), pins: sosPinList_(r[2]) }; });
  try { cache.put('SOS_ROSTER_ROWS_V2', JSON.stringify(rows), 21600); } catch (x) {}
  return rows;
}
function sosRoster_() {
  return sosRosterRows_().map(function(r){ return { name: r.name, role: r.role, hasPin: r.pins.length > 0, isAdmin: SOS_ADMINS_.indexOf(r.name) !== -1 }; });
}

function sosSignin_(body) {
  var who = String(body.who || '').trim();
  var pin = String(body.pin || '').trim();
  if (!who) return { ok: false, error: 'Pick your name.' };
  var row = sosRosterRows_().filter(function(r){ return r.name === who; })[0];
  if (!row) return { ok: false, error: 'Name not found.' };
  if (row.pins.length && row.pins.indexOf(pin) === -1) return { ok: false, error: 'Incorrect PIN.' };
  return { ok: true, who: who, role: row.role };
}

function sosTasksFor_(who) { return sosRows_('StaffTasks', SOS_TASK_HDRS_).filter(function(t){ return String(t.owner) === who; }); }
function sosTasksAssignedTo_(who) { return sosRows_('StaffTasks', SOS_TASK_HDRS_).filter(function(t){ return String(t.owner) === who && t.assignedBy && String(t.assignedBy) !== who; }); }
function sosPlansFor_(who) { return sosRows_('StaffPlans', SOS_PLAN_HDRS_).filter(function(p){ return String(p.owner) === who; }); }

function sosTaskAdd_(body) {
  var sh = sosSheet_('StaffTasks', SOS_TASK_HDRS_);
  var now = Date.now();
  var id = sosId_();
  var owner = String(body.owner || '').trim();           // who it's FOR
  var assignedBy = String(body.assignedBy || '').trim();  // who created it (if delegated)
  if (!owner) return { ok: false, error: 'Missing owner.' };
  sosTaskTextFormat_(sh);
  sh.appendRow([id, owner, String(body.title || '').trim(), String(body.notes || ''), 'open',
    String(body.due || ''), String(body.priority || 'normal'), assignedBy, now, now, String(body.planId || '')]);
  return { ok: true, id: id, createdAt: now };
}

// Keep due dates as typed text (not Date cells) and make sure the planId column has its header.
function sosTaskTextFormat_(sh) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SOS_TASK_TEXTFMT_V1') === '1') return;
  sh.getRange(1, SOS_TASK_HDRS_.indexOf('planId') + 1).setValue('planId');
  sh.getRange(2, SOS_TASK_HDRS_.indexOf('due') + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  props.setProperty('SOS_TASK_TEXTFMT_V1', '1');
}

// Plan text columns are stored as PLAIN TEXT so what people type is kept exactly —
// otherwise Sheets turns "60%" into 0.6 and "2026-09-07" into a Date. Runs once per sheet.
function sosPlanTextFormat_(sh) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SOS_PLAN_TEXTFMT_V1') === '1') return;
  ['title', 'detail', 'period', 'metric', 'target', 'current'].forEach(function(h) {
    var col = SOS_PLAN_HDRS_.indexOf(h) + 1;
    if (col > 0) sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });
  props.setProperty('SOS_PLAN_TEXTFMT_V1', '1');
}
function sosRowUpdate_(sheetName, body) {
  var headers = sheetName === 'StaffTasks' ? SOS_TASK_HDRS_ : SOS_PLAN_HDRS_;
  var sh = sosSheet_(sheetName, headers);
  var last = sh.getLastRow(); if (last < 2) return { ok: false, error: 'No rows.' };
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(body.id)) {
      var rowNum = i + 2;
      if (sheetName === 'StaffPlans') sosPlanTextFormat_(sh); else sosTaskTextFormat_(sh);
      var cur = sh.getRange(rowNum, 1, 1, headers.length).getValues()[0];
      headers.forEach(function(h, ci){ if (h !== 'id' && h !== 'createdAt' && Object.prototype.hasOwnProperty.call(body, h)) cur[ci] = body[h]; });
      cur[headers.indexOf('updatedAt')] = Date.now();
      sh.getRange(rowNum, 1, 1, headers.length).setValues([cur]);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Not found.' };
}

function sosRowDelete_(sheetName, id) {
  var headers = sheetName === 'StaffTasks' ? SOS_TASK_HDRS_ : SOS_PLAN_HDRS_;
  var sh = sosSheet_(sheetName, headers);
  var last = sh.getLastRow(); if (last < 2) return { ok: false, error: 'No rows.' };
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: false, error: 'Not found.' };
}

function sosPlanAdd_(body) {
  var sh = sosSheet_('StaffPlans', SOS_PLAN_HDRS_);
  sosPlanTextFormat_(sh);
  var now = Date.now(); var id = sosId_();
  var owner = String(body.owner || '').trim();
  if (!owner) return { ok: false, error: 'Missing owner.' };
  sh.appendRow([id, owner, String(body.type || 'goal'), String(body.title || '').trim(), String(body.detail || ''),
    String(body.period || ''), String(body.status || 'active'), Number(body.progress || 0),
    String(body.metric || ''), String(body.target || ''), String(body.current || ''),
    String(body.parentId || ''), now, now]);
  return { ok: true, id: id };
}


/**
 * Set each staff member's PIN = last 4 digits of their PCO People phone number.
 * dry=true previews matches without writing. Uses pcoGetAllWithIncluded_ (shared).
 */
function sosSeedPinsFromPCO_(dry) {
  sosRoster_(); // ensure the roster is seeded
  var sh = sosSheet_('StaffRoster', ['name', 'role', 'pin']);
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'Empty roster.' };
  var rows = sh.getRange(2, 1, last - 1, 3).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var name = String(rows[i][0]).trim();
    if (!name) continue;
    var parts = name.split(/\s+/);
    var first = (parts[0] || '').toLowerCase();
    var lastn = parts.slice(1).join(' ');
    var pin = '', matched = '';
    try {
      var res = pcoGetAllWithIncluded_('/people/v2/people?where[last_name]=' + encodeURIComponent(lastn) +
        '&include=phone_numbers&per_page=25');
      var people = res.data || [];
      var phoneById = {};
      (res.included || []).forEach(function(x) { if (x.type === 'PhoneNumber') phoneById[x.id] = x.attributes || {}; });
      var person = people.filter(function(p) {
        var fn = ((p.attributes || {}).first_name || '').toLowerCase();
        return fn === first || fn.indexOf(first) === 0 || (first && first.indexOf(fn) === 0);
      })[0] || people[0];
      if (person) {
        matched = ((person.attributes || {}).first_name || '') + ' ' + ((person.attributes || {}).last_name || '');
        var rel = (person.relationships && person.relationships.phone_numbers && person.relationships.phone_numbers.data) || [];
        var nums = rel.map(function(r) { return phoneById[r.id]; }).filter(Boolean);
        // Last 4 of EVERY phone on their profile (primary first) — people don't always know which is "primary".
        nums.sort(function(a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0); });
        var seen = {};
        pin = nums.map(function(n) { return String(n.number || '').replace(/\D/g, ''); })
          .filter(function(d) { return d.length >= 4; }).map(function(d) { return d.slice(-4); })
          .filter(function(p) { if (seen[p]) return false; seen[p] = 1; return true; }).join(', ');
      }
    } catch (err) { matched = 'ERR ' + err.message; }
    out.push({ name: name, matchedPcoName: matched, pinSet: !!pin, phones: pin ? pin.split(',').length : 0 });
    if (!dry && pin) { sh.getRange(i + 2, 3).setNumberFormat('@').setValue(pin); }
  }
  if (!dry) { try { CacheService.getScriptCache().remove('SOS_ROSTER_ROWS_V2'); } catch (x) {} }
  return { ok: true, dry: !!dry, count: out.length, results: out };
}


/** PIN-first login: return the staff member(s) whose PIN matches (like the pastor
 *  dashboard — the 4-digit PIN identifies the person and logs them straight in). */
function sosLogin_(body) {
  var pin = String(body.pin || '').trim();
  if (!pin) return { ok: false, error: 'Enter your PIN.' };
  pin = pin.replace(/\D/g, '');
  var matches = sosRosterRows_().filter(function(r) { return r.pins.indexOf(pin) !== -1; })
    .map(function(r) { return { name: r.name, role: r.role, isAdmin: SOS_ADMINS_.indexOf(r.name) !== -1 }; });
  if (!matches.length) return { ok: false, nomatch: true, error: 'No staff member has that PIN (it\'s the last 4 digits of your phone).' };
  // Fast path: identity only — the page paints from its cache and loads the workspace after.
  if (matches.length === 1 && body.lite) return { ok: true, matches: matches, who: matches[0].name, role: matches[0].role, isAdmin: matches[0].isAdmin, lite: true, roster: sosRoster_() };
  // Single match → return their full workspace in the SAME response (one round-trip).
  if (matches.length === 1) {
    var who = matches[0].name;
    var allT = sosRows_('StaffTasks', SOS_TASK_HDRS_);
    var mineT = allT.filter(function(t){ return String(t.owner) === who; });
    return { ok: true, matches: matches, who: who, role: matches[0].role, isAdmin: matches[0].isAdmin,
      tasks: mineT, assigned: mineT.filter(function(t){ return t.assignedBy && String(t.assignedBy) !== who; }),
      plans: sosPlansFor_(who), roster: sosRoster_() };
  }
  return { ok: true, matches: matches };
}


/** Image proxy for the announcement-card PDF export. Planning Center's image CDN
 *  sends no CORS headers, so the browser can't draw those photos into the PDF.
 *  This fetches them server-side (whitelisted PCO hosts only, max 12, in parallel)
 *  and returns data: URLs the page can embed. No state is stored. */
var SOS_IMG_HOSTS_ = /^https:\/\/(images\.planningcenterusercontent\.com|groups-production\.s3\.amazonaws\.com|[a-z0-9-]+\.planningcenteronline\.com|[a-z0-9-]+\.churchcenter\.com)\//i;
function sosImgProxy_(body) {
  var urls = (body.urls || []).slice(0, 12).map(function(u){ return String(u || ''); });
  var reqs = [], idx = [];
  urls.forEach(function(u, i){ if (SOS_IMG_HOSTS_.test(u)) { reqs.push({ url: u, muteHttpExceptions: true, followRedirects: true }); idx.push(i); } });
  var out = urls.map(function(){ return null; });
  if (!reqs.length) return { ok: true, images: out };
  var resps = UrlFetchApp.fetchAll(reqs);
  resps.forEach(function(r, k){
    try {
      if (r.getResponseCode() !== 200) return;
      var blob = r.getBlob();
      var ct = String(r.getHeaders()['Content-Type'] || blob.getContentType() || 'image/jpeg').split(';')[0];
      if (!/^image\//.test(ct)) return;
      var bytes = blob.getBytes();
      if (bytes.length > 3 * 1024 * 1024) return;       // skip anything huge
      out[idx[k]] = 'data:' + ct + ';base64,' + Utilities.base64Encode(bytes);
    } catch (e) {}
  });
  return { ok: true, images: out };
}


/**
 * One-off / re-runnable import of goals + action steps for one person (e.g. from the
 * "Volunteer Church Action Items" doc). Previously imported rows with the same tag are
 * replaced; steps whose title matches an old step keep their done status, and the goal
 * keeps its progress. Requires confirm:'lssr'.
 */
function sosImportPlans_(body) {
  if (body.confirm !== 'lssr') return { ok: false, error: 'confirm required' };
  var owner = String(body.owner || '').trim(), tag = String(body.tag || '').trim();
  if (!owner || !tag) return { ok: false, error: 'owner and tag required' };
  var sh = sosSheet_('StaffPlans', SOS_PLAN_HDRS_);
  var rows = sosRows_('StaffPlans', SOS_PLAN_HDRS_);
  var marker = '[import:' + tag + ']';
  var oldGoals = rows.filter(function(r) { return String(r.owner) === owner && (r.type === 'goal' || r.type === 'objective') && String(r.detail).indexOf(marker) !== -1; });
  var oldIds = {}; oldGoals.forEach(function(g) { oldIds[g.id] = g; });
  var oldSteps = rows.filter(function(r) { return r.type === 'step' && oldIds[r.parentId]; });
  var doneByTitle = {}; oldSteps.forEach(function(st) { if (st.status === 'done') doneByTitle[String(st.title)] = true; });
  var progByTitle = {}; oldGoals.forEach(function(g) { progByTitle[String(g.title)] = Number(g.progress || 0); });
  // delete old rows (bottom-up)
  var kill = {}; oldGoals.concat(oldSteps).forEach(function(r) { kill[r.id] = true; });
  var last = sh.getLastRow();
  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) if (kill[ids[i][0]]) sh.deleteRow(i + 2);
  }
  var now = Date.now(), out = [], created = 0;
  (body.goals || []).forEach(function(g) {
    var gid = sosId_();
    var detail = String(g.detail || '') + (g.detail ? ' ' : '') + marker;
    out.push([gid, owner, String(g.type || 'goal'), String(g.title || '').trim(), detail, String(g.period || ''), 'active',
      progByTitle[String(g.title || '').trim()] || 0, String(g.metric || ''), String(g.target || ''), '', '', now, now]);
    created++;
    (g.steps || []).forEach(function(t, k) {
      t = String(t || '').trim(); if (!t) return;
      out.push([sosId_() + k, owner, 'step', t, '', '', doneByTitle[t] ? 'done' : 'active', 0, '', '', '', gid, now + k + 1, now + k + 1]);
      created++;
    });
  });
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, SOS_PLAN_HDRS_.length).setValues(out);
  return { ok: true, owner: owner, removed: Object.keys(kill).length, created: created };
}


/**
 * Every Planning Center People list with its head-count, for the Core Strategies
 * number picker ("pull data from anywhere"). total_people is PCO's count as of the
 * list's last refresh (refreshedAt). Cached 20 min; ?refresh=1 bypasses the cache.
 */
function sosPcoLists_(force) {
  var cache = CacheService.getScriptCache(), key = 'SOS_PCO_LISTS_V1';
  if (!force) { var hit = cache.get(key); if (hit) { try { return JSON.parse(hit); } catch (x) {} } }
  var res = pcoGetAllWithIncluded_('/people/v2/lists?per_page=100&include=category&order=name');
  var cats = {};
  (res.included || []).forEach(function(inc) { if (inc.type === 'ListCategory') cats[inc.id] = (inc.attributes || {}).name || ''; });
  var lists = (res.data || []).map(function(l) {
    var a = l.attributes || {}, rel = ((l.relationships || {}).category || {}).data;
    return { id: l.id, name: a.name || a.name_or_description || ('List ' + l.id), count: Number(a.total_people || 0),
             category: rel && cats[rel.id] || '', refreshedAt: a.refreshed_at || a.updated_at || '' };
  }).filter(function(l) { return l.name; });
  var out = { ok: true, lists: lists, asOf: new Date().toISOString() };
  try { cache.put(key, JSON.stringify(out), 1200); } catch (x) {}
  return out;
}


/** Read-only PIN health check — yes/no facts only, never digits. */
function sosPinDiag_() {
  var sh = sosSheet_('StaffRoster', ['name', 'role', 'pin']);
  var last = sh.getLastRow(); if (last < 2) return { ok: true, rows: [] };
  var vals = sh.getRange(2, 1, last - 1, 3).getValues();
  return { ok: true, rows: vals.filter(function(r){ return r[0]; }).map(function(r) {
    var raw = r[2], list = sosPinList_(raw);
    return { name: String(r[0]), storedAs: typeof raw, pinCount: list.length,
             lostLeadingZero: typeof raw === 'number' && raw < 1000, looksValid: list.every(function(p){ return /^\d{4}$/.test(p); }) };
  }) };
}
