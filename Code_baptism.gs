/**
 * Baptism board — Pastor Shepherding page (/pastors → 💧 Baptisms).
 * =================================================================
 * Two-way view of the two PCO People workflows:
 *   • Baptism Requested (564704) — one step, "Pastoral Meeting". The "I'm interested in
 *     Baptism" form (764941) adds people here; the assigned pastor meets with them, then
 *     completes the card. PCO's automation adds them to Baptism Ready the next day.
 *   • Baptism Ready (528797) — "Schedule for Baptism" → "Baptism Scheduled". Completing the
 *     last step = baptized.
 * The chosen Sunday + service has no PCO field, so it lives in a private "BaptismPlan" tab of
 * the bound sheet (and a note on the PCO card). The staff "Schedule" tab of the Baptisms
 * sheet (DASHBOARD_CONFIG.BAPTISM_SCHEDULE_SHEET_ID) is read, never written, to fill in dates
 * for people scheduled there by hand.
 *
 * GET actions (pw = a pastor login hash, same gate as shepherding_data):
 *   bap_list                          → board data
 *   bap_act&op=…&wf=req|ready&cardId  → assign | note | met | snooze | unsnooze | remove |
 *                                       schedule | unschedule | baptized
 * Dispatched from doGet in Code_eos_webapp.gs via BAP_GET_ACTIONS_.
 */

var BAP_ = {
  WF: { req: '564704', ready: '528797' },
  STEP_SCHEDULE: '1416111',     // Ready: "Schedule for Baptism"
  STEP_SCHEDULED: '1416113',    // Ready: "Baptism Scheduled"
  FORM_INTEREST: '764941',
  FORM_Q: [['5951292', 'Baptized before?'], ['5951295', 'Why baptism'], ['5951301', 'Testimony'],
           ['5978998', 'What is the Gospel?'], ['6126518', 'Other notes']],
  PLAN_TAB: 'BaptismPlan',
  PLAN_HDRS: ['pid', 'cardId', 'date', 'service', 'updatedBy', 'updatedAt', 'baptizedAt'],
  SERVICES: ['8:00 AM', '9:30 AM', '11:00 AM'],
  MET_DAYS: 10,                 // show "met → moving to Ready" for this long
  DONE_DAYS: 120                // recently baptized window
};
var BAP_GET_ACTIONS_ = ['bap_list', 'bap_act'];

function bapDoGet_(e) {
  var p = (e && e.parameter) || {};
  var by = spPastorForHash_(p.pw);
  if (!by) return eosWaJson_({ error: 'unauthorized' });
  if (p.action === 'bap_list') return eosWaJson_(bapList_());
  if (p.action === 'bap_act') return eosWaJson_(bapAct_(p, by));
  return eosWaJson_({ error: 'unknown baptism action' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────
function bapCards_(key) {
  var res = pcoGetAllWithIncluded_('/people/v2/workflows/' + BAP_.WF[key] + '/cards?include=person,assignee,current_step&per_page=100');
  var inc = {};
  (res.included || []).forEach(function (x) { inc[x.type + ':' + x.id] = x; });
  return (res.data || []).map(function (c) {
    var a = c.attributes || {}, r = c.relationships || {};
    var pid = ((r.person || {}).data || {}).id, aid = ((r.assignee || {}).data || {}).id, sid = ((r.current_step || {}).data || {}).id;
    var per = (inc['Person:' + pid] || {}).attributes || {}, asg = (inc['Person:' + aid] || {}).attributes || {};
    return {
      wf: key, cardId: c.id, pid: String(pid || ''), name: per.name || [per.first_name, per.last_name].join(' ').trim(),
      avatar: per.avatar || '', child: !!per.child, birthdate: per.birthdate || '',
      stage: a.stage, stepId: String(sid || ''), step: ((inc['WorkflowStep:' + sid] || {}).attributes || {}).name || '',
      assigneeId: String(aid || ''), assignee: asg.name || [asg.first_name, asg.last_name].join(' ').trim(),
      created: a.created_at, movedAt: a.moved_to_step_at, dueAt: a.calculated_due_at, overdue: !!a.overdue,
      snoozeUntil: a.snooze_until, completedAt: a.completed_at, removedAt: a.removed_at
    };
  });
}

function bapList_() {
  var now = Date.now(), DAY = 864e5;
  var req = bapCards_('req'), ready = bapCards_('ready');
  var live = function (c) { return c.stage !== 'completed' && c.stage !== 'removed'; };

  var reqActive = req.filter(live), readyActive = ready.filter(live);
  // Met with + completed recently, but PCO hasn't added them to Ready yet (it runs next day).
  var readyByPid = {};
  ready.forEach(function (c) { (readyByPid[c.pid] = readyByPid[c.pid] || []).push(c); });
  var met = req.filter(function (c) {
    if (c.stage !== 'completed' || !c.completedAt) return false;
    var t = Date.parse(c.completedAt);
    if (now - t > BAP_.MET_DAYS * DAY) return false;
    return !(readyByPid[c.pid] || []).some(function (r) { return Date.parse(r.created) >= t - DAY; });
  });
  var done = ready.filter(function (c) { return c.stage === 'completed' && c.completedAt && now - Date.parse(c.completedAt) <= BAP_.DONE_DAYS * DAY; })
    .sort(function (a, b) { return a.completedAt < b.completedAt ? 1 : -1; });

  bapEnrich_(reqActive.concat(readyActive).concat(met), reqActive.concat(met));

  // Sunday + service: dashboard plan first, else the staff Schedule tab (matched by name).
  var plans = bapPlans_();
  var sheet = null; try { sheet = getBaptismSchedule_(); } catch (x) {}
  var sheetByName = {};
  if (sheet) (sheet.byService || []).forEach(function (g) {
    g.people.forEach(function (p) { sheetByName[bapNorm_(p.name)] = { date: sheet.date, service: g.service, baptizer: p.baptizer }; });
  });
  readyActive.concat(done).forEach(function (c) {
    var pl = plans[c.pid];
    if (pl) { if (pl.date) { c.date = pl.date; c.service = pl.service; c.planBy = pl.updatedBy; c.dateSource = 'dashboard'; } }
    else if (sheetByName[bapNorm_(c.name)]) { var s = sheetByName[bapNorm_(c.name)]; c.date = s.date; c.service = s.service; c.baptizer = s.baptizer; c.dateSource = 'sheet'; }
  });

  return {
    ok: true, asOf: new Date().toISOString(),
    requested: reqActive, met: met, ready: readyActive, baptized: done,
    pastors: bapPastors_(), sundays: bapFirstSundays_(8), services: BAP_.SERVICES,
    sheetSchedule: sheet
  };
}

// Card notes (both workflows), contact, and the interest-form answers — fetched in parallel.
function bapEnrich_(cards, formCards) {
  var reqs = [], jobs = [], base = shApiBase_(), hdr = pcoHeaders_();
  var add = function (url, fn) { reqs.push({ url: base + url, method: 'get', headers: hdr, muteHttpExceptions: true }); jobs.push(fn); };
  var seen = {};
  cards.forEach(function (c) {
    add('/people/v2/workflows/' + BAP_.WF[c.wf] + '/cards/' + c.cardId + '/notes?per_page=25&order=-created_at', function (j) {
      c.notes = ((j && j.data) || []).map(function (n) { return { at: n.attributes.created_at, text: n.attributes.note }; });
    });
    if (seen[c.pid]) return;
    seen[c.pid] = 1;
    add('/people/v2/people/' + c.pid + '?include=emails,phone_numbers', function (j) {
      var inc = (j && j.included) || [];
      var em = inc.filter(function (x) { return x.type === 'Email'; }), ph = inc.filter(function (x) { return x.type === 'PhoneNumber'; });
      var pick = function (arr) { return (arr.filter(function (x) { return x.attributes.primary; })[0] || arr[0] || {}).attributes || {}; };
      var contact = { email: pick(em).address || '', phone: pick(ph).number || '' };
      cards.forEach(function (o) { if (o.pid === c.pid) o.contact = contact; });
    });
  });
  var fseen = {};
  formCards.forEach(function (c) {
    if (fseen[c.pid]) return;
    fseen[c.pid] = 1;
    add('/people/v2/people/' + c.pid + '/form_submissions?include=form_submission_values&per_page=25', function (j) {
      var subs = ((j && j.data) || []).filter(function (s) { return String((((s.relationships || {}).form || {}).data || {}).id) === BAP_.FORM_INTEREST; })
        .sort(function (a, b) { return a.attributes.created_at < b.attributes.created_at ? 1 : -1; });
      if (!subs.length) return;
      var ids = {};
      ((((subs[0].relationships || {}).form_submission_values || {}).data) || []).forEach(function (d) { ids[d.id] = 1; });
      var byField = {};
      ((j && j.included) || []).forEach(function (v) {
        if (v.type !== 'FormSubmissionValue' || !ids[v.id]) return;
        byField[(((v.relationships || {}).form_field || {}).data || {}).id] = (v.attributes || {}).display_value;
      });
      var form = { at: subs[0].attributes.created_at, answers: [] };
      BAP_.FORM_Q.forEach(function (q) { if (byField[q[0]]) form.answers.push({ q: q[1], a: String(byField[q[0]]) }); });
      cards.forEach(function (o) { if (o.pid === c.pid) o.form = form; });
    });
  });
  for (var i = 0; i < reqs.length; i += 25) {
    var batch = UrlFetchApp.fetchAll(reqs.slice(i, i + 25));
    batch.forEach(function (r, k) {
      var j = null; try { j = JSON.parse(r.getContentText()); } catch (x) {}
      try { if (r.getResponseCode() < 300) jobs[i + k](j); } catch (x) {}
    });
  }
}

function bapPastors_() {
  var full = {};
  Object.keys(SHEPHERDING_PASTORS).forEach(function (h) { var p = SHEPHERDING_PASTORS[h]; if (p.elder) full[p.elder] = p.name; });
  return Object.keys(SH_ELDER_BY_PERSON).map(function (id) { var s = SH_ELDER_BY_PERSON[id]; return { id: id, short: s, name: full[s] || s }; })
    .sort(function (a, b) { return a.short < b.short ? -1 : 1; });
}

// Baptisms are on the first Sunday of each month.
function bapFirstSundays_(n) {
  var tz = Session.getScriptTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), out = [];
  var y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  for (var k = 0; out.length < n && k < n + 2; k++) {
    var d1 = new Date(y, m + k, 1), first = new Date(y, m + k, 1 + (7 - d1.getDay()) % 7);
    var key = Utilities.formatDate(first, tz, 'yyyy-MM-dd');
    if (key >= today) out.push(key);
  }
  return out;
}

function bapNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

// ─────────────────────────────────────────────────────────────────────────────
// Plan tab (Sunday + service per person)
// ─────────────────────────────────────────────────────────────────────────────
function bapPlanSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(BAP_.PLAN_TAB);
  if (!sh) {
    sh = ss.insertSheet(BAP_.PLAN_TAB);
    sh.appendRow(BAP_.PLAN_HDRS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), BAP_.PLAN_HDRS.length).setNumberFormat('@');
    try { sh.hideSheet(); } catch (x) {}
  }
  return sh;
}
function bapPlans_() {
  var out = {};
  try {
    var v = bapPlanSheet_().getDataRange().getValues();
    for (var r = 1; r < v.length; r++) {
      var o = {}; BAP_.PLAN_HDRS.forEach(function (h, i) { o[h] = String(v[r][i] || ''); });
      if (o.pid && !o.baptizedAt) out[o.pid] = o;
    }
  } catch (x) {}
  return out;
}
function bapSetPlan_(pid, cardId, fields) {
  var sh = bapPlanSheet_(), v = sh.getDataRange().getValues(), row = 0;
  for (var r = 1; r < v.length; r++) if (String(v[r][0]) === String(pid) && !v[r][6]) { row = r + 1; break; }
  var cur = row ? v[row - 1].map(String) : [String(pid), String(cardId), '', '', '', '', ''];
  Object.keys(fields).forEach(function (k) { cur[BAP_.PLAN_HDRS.indexOf(k)] = String(fields[k]); });
  cur[1] = String(cardId || cur[1]);
  if (row) sh.getRange(row, 1, 1, cur.length).setValues([cur]); else sh.appendRow(cur);
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────
function bapAct_(p, by) {
  var op = String(p.op || ''), key = String(p.wf || ''), cardId = String(p.cardId || '');
  if (!BAP_.WF[key] || !/^\d+$/.test(cardId)) return { ok: false, error: 'bad card' };
  var base = '/people/v2/workflows/' + BAP_.WF[key] + '/cards/' + cardId;
  var g = shGet_(base);
  if (g.code !== 200 || !g.json || !g.json.data) return { ok: false, error: 'card not found (' + g.code + ')' };
  var card = g.json.data, rel = card.relationships || {};
  var pid = String(((rel.person || {}).data || {}).id || ''), stepId = String(((rel.current_step || {}).data || {}).id || '');
  var w, res = { ok: false, op: op };
  var done = function (x) { return x && x.code >= 200 && x.code < 300; };
  var move = function (action) {
    var r = shWrite_('post', base + '/' + action, { data: {} });
    if (r.code === 404) r = shWrite_('post', '/people/v2/workflow_cards/' + cardId + '/' + action, { data: {} });
    return r;
  };
  var note = function (text) { return shWrite_('post', base + '/notes', { data: { attributes: { note: text + '\n— ' + by } } }); };

  if (op === 'assign') {
    var aid = String(p.assignee || '');
    if (!/^\d+$/.test(aid)) return { ok: false, error: 'bad assignee' };
    w = shWrite_('patch', base, { data: { type: 'WorkflowCard', id: cardId, attributes: { assignee_id: aid, sticky_assignment: true } } });
    res.ok = done(w) && String((((((w.json || {}).data || {}).relationships || {}).assignee || {}).data || {}).id || aid) === aid;
  } else if (op === 'note') {
    var text = String(p.note || '').trim().substring(0, 4000);
    if (!text) return { ok: false, error: 'empty note' };
    w = note(text); res.ok = done(w);
    if (res.ok) res.note = { at: new Date().toISOString(), text: text + '\n— ' + by };
  } else if (op === 'met') {
    if (key !== 'req') return { ok: false, error: 'met is for Baptism Requested' };
    if (p.note) note(String(p.note).substring(0, 4000));
    w = move('promote'); res.ok = done(w);
  } else if (op === 'snooze') {
    var days = Math.max(1, Math.min(365, parseInt(p.days, 10) || 30));
    w = shWrite_('post', base + '/snooze', { data: { attributes: { duration: days } } }); res.ok = done(w);
  } else if (op === 'unsnooze') {
    w = shWrite_('post', base + '/unsnooze', { data: {} }); res.ok = done(w);
  } else if (op === 'remove') {
    w = shWrite_('post', base + '/remove', { data: {} });
    if (w.code === 404 || w.code === 405) w = shWrite_('delete', base, {});
    res.ok = done(w);
  } else if (op === 'schedule') {
    if (key !== 'ready') return { ok: false, error: 'schedule is for Baptism Ready' };
    var date = String(p.date || ''), svc = String(p.service || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || BAP_.SERVICES.indexOf(svc) < 0) return { ok: false, error: 'pick a Sunday and a service' };
    bapSetPlan_(pid, cardId, { date: date, service: svc, updatedBy: by, updatedAt: new Date().toISOString() });
    w = stepId === BAP_.STEP_SCHEDULE ? move('promote') : { code: 200 };
    res.ok = done(w);
    var nice = Utilities.formatDate(new Date(date + 'T12:00:00'), Session.getScriptTimeZone(), 'EEE MMM d, yyyy');
    note('📅 Scheduled for baptism: ' + nice + ' · ' + svc + ' service');
  } else if (op === 'unschedule') {
    bapSetPlan_(pid, cardId, { date: '', service: '', updatedBy: by, updatedAt: new Date().toISOString() });
    w = stepId === BAP_.STEP_SCHEDULED ? move('go_back') : { code: 200 };
    res.ok = done(w);
  } else if (op === 'baptized') {
    if (key !== 'ready') return { ok: false, error: 'baptized is for Baptism Ready' };
    if (stepId === BAP_.STEP_SCHEDULE) { w = move('promote'); if (!done(w)) return { ok: false, code: w.code, detail: (w.raw || '').substring(0, 300) }; }
    w = move('promote'); res.ok = done(w);
    if (res.ok) {
      var tz = Session.getScriptTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
      var pl = bapPlans_()[pid], when = (pl && pl.date && pl.date <= today) ? pl.date : today;
      bapSetPlan_(pid, cardId, { baptizedAt: when, updatedBy: by, updatedAt: new Date().toISOString() });
      // Stamp the profile (only fills a blank Baptism Date; never overwrites one).
      var fd = shGet_('/people/v2/people/' + pid + '/field_data?per_page=100'), hasDate = false;
      ((fd.json && fd.json.data) || []).forEach(function (d) {
        if (String((((d.relationships || {}).field_definition || {}).data || {}).id) === SH_FIELD.baptismDate && (d.attributes || {}).value) hasDate = true;
      });
      if (!hasDate) res.dateSet = shSetFieldDatum_(pid, SH_FIELD.baptismDate, when).ok ? when : false;
      res.baptizedFlag = shSetFieldDatum_(pid, SH_FIELD.baptized, 'true').ok;
    }
  } else return { ok: false, error: 'unknown op ' + op };

  if (!res.ok && w) { res.code = w.code; res.detail = (w.raw || '').substring(0, 300); }
  if (res.ok) spLogChange_(by, pid, 'baptism-' + key, op + (p.date ? ' ' + p.date + ' ' + (p.service || '') : '') + (p.assignee ? ' ' + p.assignee : ''));
  return res;
}
