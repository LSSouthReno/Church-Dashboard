/* =========================================================
   ATTENDANCE BY SERVICE TIME  (rebuilt 2026-09-30)
   ---------------------------------------------------------
   Feeds the dashboard's per-service views:
     attendanceByServiceWeekly = { services, weeks, data:{ 'yyyy-MM-dd': { '8:00 AM': {adults,kids} } } }
       → weekly attendance pop-up (bars split by service) + "Weekly spreadsheet (by service)"
     attendanceByService       = { services, months, data:{ 'yyyy-MM': { '8:00 AM': {adults,kids} } } }
       → per-Sunday AVERAGE per service for each month

   The original version (Sep 16) lived only in Apps Script HEAD and was lost on
   Sep 20 when HEAD was replaced from a checkout that didn't have it. This keeps
   the same output shape the front end already reads.

   How it works:
   - getAttendanceWeeklyRowsForMonths_ (the weekly sync) already has adults/kids per
     event_time; it hands them to attnSvcCollect_, which turns them into
     [DateKey, Service, Adults, Kids] rows (Service = start time, e.g. "8:00 AM").
     Same counting rules as the weekly totals, so services always add up to the week.
   - upsertWeeklyAttendanceRows_ calls attnSvcFlush_, which writes those rows to the
     "AttendanceByService" tab (replacing any rows for the same dates).
   - History before the rebuild is seeded ONCE from the last dashboard-data.json that
     had it (commit ATTN_SVC_SEED_REF_), filling only dates the tab doesn't have yet.
========================================================= */

var ATTN_SVC_SHEET_ = 'AttendanceByService';
var ATTN_SVC_HDRS_ = ['DateKey', 'Service', 'Adults', 'Kids'];
var ATTN_SVC_SEED_REF_ = '97fe1c4734fbddee4a99147e2db9ed001279c26f';  // last commit with the feed (2026-09-20)
var ATTN_SVC_SEED_PROP_ = 'ATTN_SVC_SEEDED';
var ATTN_SVC_LAST_ = [];   // rows from the most recent weekly pull, waiting to be written
var ATTN_SVC_GF_PROP_ = 'ATTN_SVC_GOOD_FRIDAY';   // {done:{year:1}, seen:{date:[event names]}}
var ATTN_SVC_GF_FIRST_YEAR_ = 2019;

// ── pure helpers (no Apps Script services) ──────────────────────────────────

// "8:00 AM"-style label from minutes after midnight.
function attnSvcLabelFromMin_(mins) {
  var h = Math.floor(mins / 60) % 24, m = mins % 60, ap = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}
function attnSvcMin_(label) {
  var m = String(label).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 9999;
  var h = parseInt(m[1], 10) % 12; if (/PM/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

// items: [{ dateKey, service, adults, kids }] (several event_times can share a slot) →
// merged rows [DateKey, Service, Adults, Kids], empty slots dropped.
function attnSvcRowsFromItems_(items) {
  var by = {};
  items.forEach(function(it) {
    if (!it.dateKey || !it.service) return;
    var k = it.dateKey + '|' + it.service;
    if (!by[k]) by[k] = [it.dateKey, it.service, 0, 0];
    by[k][2] += Number(it.adults) || 0;
    by[k][3] += Number(it.kids) || 0;
  });
  return Object.keys(by).map(function(k) { return by[k]; })
    .filter(function(r) { return r[2] || r[3]; });
}

// Merge new rows into existing ones: every date present in `fresh` is replaced wholesale.
function attnSvcMergeRows_(existing, fresh) {
  var freshDates = {};
  fresh.forEach(function(r) { freshDates[r[0]] = 1; });
  return existing.filter(function(r) { return !freshDates[r[0]]; }).concat(fresh)
    .sort(function(a, b) { return a[0] === b[0] ? attnSvcMin_(a[1]) - attnSvcMin_(b[1]) : (a[0] < b[0] ? -1 : 1); });
}

// Rows from a saved dashboard-data.json feed — only dates `haveDates` doesn't already cover.
function attnSvcRowsFromFeed_(feed, haveDates) {
  var rows = [];
  var data = (feed && feed.data) || {};
  Object.keys(data).forEach(function(dk) {
    if (haveDates[dk]) return;
    Object.keys(data[dk] || {}).forEach(function(svc) {
      var c = data[dk][svc] || {};
      var a = Number(c.adults) || 0, k = Number(c.kids) || 0;
      if (a || k) rows.push([dk, svc, a, k]);
    });
  });
  return rows;
}

// rows [DateKey, Service, Adults, Kids] → { weekly, monthly } in the dashboard's shape.
function attnSvcFeeds_(rows) {
  var svcSet = {}, wk = {}, mo = {};
  rows.forEach(function(r) {
    var dk = r[0], s = r[1], a = Number(r[2]) || 0, k = Number(r[3]) || 0;
    svcSet[s] = 1;
    (wk[dk] = wk[dk] || {})[s] = { adults: a, kids: k };
    var mk = dk.slice(0, 7), m = (mo[mk] = mo[mk] || {});
    var t = (m[s] = m[s] || { a: 0, k: 0, na: 0, nk: 0 });
    if (a) { t.a += a; t.na++; }
    if (k) { t.k += k; t.nk++; }
  });
  var services = Object.keys(svcSet).sort(function(x, y) { return attnSvcMin_(x) - attnSvcMin_(y); });
  var months = Object.keys(mo).sort(), mdata = {};
  months.forEach(function(mk) {
    mdata[mk] = {};
    Object.keys(mo[mk]).forEach(function(s) {
      var t = mo[mk][s];
      // Per-Sunday average; adults and kids each average only the weeks they were counted
      // (a service with no adult headcount one week shouldn't drag its average down).
      mdata[mk][s] = { adults: t.na ? Math.round(t.a / t.na) : 0, kids: t.nk ? Math.round(t.k / t.nk) : 0 };
    });
  });
  return {
    weekly:  { services: services, weeks: Object.keys(wk).sort(), data: wk },
    monthly: { services: services, months: months, data: mdata }
  };
}

// Good Friday (yyyy-MM-dd) for a year — Easter Sunday by the anonymous Gregorian algorithm, minus 2 days.
// Keep in sync with attnGoodFriday_ in index.html.
function attnSvcGoodFriday_(year) {
  var a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  var dt = new Date(Date.UTC(year, month - 1, day - 2));
  return dt.toISOString().slice(0, 10);
}

// ── Apps Script glue ─────────────────────────────────────────────────────────

// Called from getAttendanceWeeklyRowsForMonths_ with its per-event_time counts.
function attnSvcCollect_(eventTimes, adultHcByEtId, kidsHcByEtId, kidCheckinsByEtId) {
  var tz = Session.getScriptTimeZone();
  var items = [];
  eventTimes.forEach(function(et) {
    var when = et.attributes.starts_at || et.attributes.created_at || et.attributes.shows_at;
    if (!when) return;
    var d = new Date(when);
    var hm = Utilities.formatDate(d, tz, 'H:mm').split(':');
    items.push({
      dateKey: isoDate_(d),
      service: attnSvcLabelFromMin_(Number(hm[0]) * 60 + Number(hm[1])),
      adults: adultHcByEtId[et.id] || 0,
      kids: (kidCheckinsByEtId[et.id] || 0) + (kidsHcByEtId[et.id] || 0)
    });
  });
  ATTN_SVC_LAST_ = attnSvcRowsFromItems_(items);
}

function attnSvcSheet_(ss) {
  var sh = ensureSheet_(ss, ATTN_SVC_SHEET_, ATTN_SVC_HDRS_);
  sh.getRange('A:B').setNumberFormat('@');   // keep "2026-09-06" / "8:00 AM" as text, not Dates
  return sh;
}
function attnSvcRead_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, 4).getValues().map(function(r) {
    var dk = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') : String(r[0]).trim();
    var s = r[1] instanceof Date ? attnSvcLabelFromMin_(r[1].getHours() * 60 + r[1].getMinutes()) : String(r[1]).trim();
    return [dk, s, Number(r[2]) || 0, Number(r[3]) || 0];
  }).filter(function(r) { return /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[1]; });
}
function attnSvcWrite_(sh, rows) {
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 4).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
}

// One-time: bring back the history published before the Sep 20 loss.
function attnSvcSeedIfNeeded_(ss) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(ATTN_SVC_SEED_PROP_)) return;
  var owner = propOptional_('GITHUB_OWNER'), repo = propOptional_('GITHUB_REPO'), token = propOptional_('GITHUB_TOKEN');
  if (!owner || !repo || !token) { Logger.log('AttendanceByService seed: missing GitHub props'); return; }
  var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/dashboard-data.json?ref=' + ATTN_SVC_SEED_REF_;
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (res.getResponseCode() !== 200) { Logger.log('AttendanceByService seed: GET ' + res.getResponseCode()); return; }
  var feed = (JSON.parse(res.getContentText()) || {}).attendanceByServiceWeekly;
  if (!feed || !feed.data) { Logger.log('AttendanceByService seed: no feed at ' + ATTN_SVC_SEED_REF_); return; }
  var sh = attnSvcSheet_(ss), existing = attnSvcRead_(sh), have = {};
  existing.forEach(function(r) { have[r[0]] = 1; });
  var seed = attnSvcRowsFromFeed_(feed, have);
  attnSvcWrite_(sh, attnSvcMergeRows_(seed, existing));   // existing (fresh PCO) rows win
  props.setProperty(ATTN_SVC_SEED_PROP_, new Date().toISOString() + ' +' + seed.length + ' rows');
  Logger.log('AttendanceByService seed: +' + seed.length + ' historical rows');
}

// Good Friday isn't part of the Sunday Service check-in event the weekly sync reads, so it's
// pulled on its own: every event_time on Good Friday from the Sunday event or any check-in
// event named "Good Friday", counted the same way (non-kids headcounts = adults; kids
// headcounts + check-ins = kids). History is pulled once per year; the latest one is
// re-pulled for 3 weeks after it. Event names seen that day are kept for troubleshooting.
function attnSvcGoodFridayRows_(gf) {
  var tz = Session.getScriptTimeZone();
  var until = new Date(Date.parse(gf + 'T00:00:00Z') + 2 * 864e5).toISOString().slice(0, 10);
  var res = pcoGetAllWithIncluded_('/check-ins/v2/event_times?where[starts_at][gte]=' + gf +
    '&where[starts_at][lte]=' + until + '&include=headcounts,event&per_page=100');
  var names = {}, adults = {}, kidsHc = {};
  (res.included || []).forEach(function(inc) {
    if (inc.type === 'Event') { names[inc.id] = (inc.attributes || {}).name || ''; return; }
    if (inc.type !== 'Headcount') return;
    var etId = relId_(inc, 'event_time'), total = Number((inc.attributes || {}).total) || 0;
    if (!etId || !total) return;
    if (isKidsHeadcount_(inc)) kidsHc[etId] = (kidsHc[etId] || 0) + total;
    else adults[etId] = (adults[etId] || 0) + total;
  });
  var seen = {}, items = [];
  (res.data || []).forEach(function(et) {
    var when = et.attributes.starts_at; if (!when) return;
    var d = new Date(when);
    if (Utilities.formatDate(d, tz, 'yyyy-MM-dd') !== gf) return;
    var evId = relId_(et, 'event'), name = names[evId] || ('event ' + evId);
    seen[name] = (seen[name] || 0) + 1;
    if (evId !== String(DASHBOARD_CONFIG.CHECKINS_EVENT_ID) && !/good\s*friday/i.test(name)) return;
    var kids = kidsHc[et.id] || 0;
    try { kids += pcoGetAll_('/check-ins/v2/event_times/' + et.id + '/check_ins?per_page=100').length; } catch (x) {}
    var hm = Utilities.formatDate(d, tz, 'H:mm').split(':');
    items.push({ dateKey: gf, service: attnSvcLabelFromMin_(Number(hm[0]) * 60 + Number(hm[1])),
                 adults: adults[et.id] || 0, kids: kids });
  });
  return { rows: attnSvcRowsFromItems_(items),
           seen: Object.keys(seen).map(function(n) { return n + (seen[n] > 1 ? ' ×' + seen[n] : ''); }) };
}
function attnSvcPullGoodFridays_(ss) {
  var props = PropertiesService.getScriptProperties();
  var st = {}; try { st = JSON.parse(props.getProperty(ATTN_SVC_GF_PROP_) || '{}'); } catch (x) {}
  st.done = st.done || {}; st.seen = st.seen || {};
  var today = isoDate_(new Date()), rows = [], ran = false;
  for (var y = ATTN_SVC_GF_FIRST_YEAR_; y <= new Date().getFullYear(); y++) {
    var gf = attnSvcGoodFriday_(y);
    if (gf > today) continue;
    var recent = (Date.parse(today) - Date.parse(gf)) / 864e5 <= 21;
    if (st.done[y] && !recent) continue;
    var r = attnSvcGoodFridayRows_(gf);
    rows = rows.concat(r.rows); st.seen[gf] = r.seen; st.done[y] = 1; ran = true;
  }
  if (!ran) return;
  if (rows.length) { var sh = attnSvcSheet_(ss); attnSvcWrite_(sh, attnSvcMergeRows_(attnSvcRead_(sh), rows)); }
  props.setProperty(ATTN_SVC_GF_PROP_, JSON.stringify(st));
  Logger.log('AttendanceByService Good Friday: ' + rows.length + ' row(s); seen ' + JSON.stringify(st.seen));
}

// Called from upsertWeeklyAttendanceRows_ — writes the rows the last weekly pull collected.
function attnSvcFlush_(ss) {
  try {
    attnSvcSeedIfNeeded_(ss);
    try { attnSvcPullGoodFridays_(ss); } catch (e) { Logger.log('Good Friday pull failed: ' + e.message); }
    var fresh = ATTN_SVC_LAST_ || [];
    ATTN_SVC_LAST_ = [];
    if (!fresh.length) return;
    var sh = attnSvcSheet_(ss);
    attnSvcWrite_(sh, attnSvcMergeRows_(attnSvcRead_(sh), fresh));
  } catch (err) {
    Logger.log('AttendanceByService flush failed: ' + err.message);
  }
}

// For buildDashboardDataFromSheet_: { weekly, monthly } (empty feeds on any error).
function attnSvcFeedsFromSheet_(ss) {
  try {
    attnSvcSeedIfNeeded_(ss);
    var sh = ss.getSheetByName(ATTN_SVC_SHEET_);
    var feeds = attnSvcFeeds_(sh ? attnSvcRead_(sh) : []);
    try { feeds.weekly.goodFridayEvents = (JSON.parse(PropertiesService.getScriptProperties().getProperty(ATTN_SVC_GF_PROP_) || '{}').seen) || {}; } catch (x) {}
    return feeds;
  } catch (err) {
    Logger.log('AttendanceByService feed failed: ' + err.message);
    return attnSvcFeeds_([]);
  }
}
