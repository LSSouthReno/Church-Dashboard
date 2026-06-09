/**
 * Church Dashboard Sync — Cached Sheet Version
 *
 * What changed:
 *  - Uses this Google Sheet as the data cache/source of truth.
 *  - Run backfillAllDashboardData() once to populate history.
 *  - Hourly trigger should run syncDashboard(), which refreshes only current month + previous 2 months.
 *  - dashboard-data.json is generated from the cached Sheet rows, then pushed to GitHub.
 *  - Serve Teams are read from the "Leader Forms" tab in THIS same Google Sheet.
 *
 * Required Script Properties:
 *   PCO_APP_ID
 *   PCO_SECRET
 *   GITHUB_TOKEN
 *   GITHUB_OWNER
 *   GITHUB_REPO
 *
 * Optional Script Properties:
 *   GITHUB_BRANCH       default: main
 *   GITHUB_FILE_PATH    default: dashboard-data.json
 */

const DASHBOARD_CONFIG = {
  GENERAL_FUND_ID: '370586',
  BUILDING_FUND_ID: '378639',
  CHECKINS_EVENT_ID: '760446',
  COMMUNITY_GROUP_TYPE_ID: '441907',

  TEAMS_TAB_NAME: 'Leader Forms',

  PLEDGE_TARGET: 8500000,
  BUILDING_FUND_PLEDGE_START: '2024-11-01',
  GENERAL_FUND_PLEDGE_START: '2025-04-01',

  RECENT_MONTHS_TO_REFRESH: 3,

  // Full-history starts here by default to avoid hammering PCO with empty 2010–2024 calls.
  // Move this earlier later if you truly need older history.
  FULL_HISTORY_START_DATE: '2018-01-01',

  // Resumable backfill runs in small chunks so Apps Script/PCO don't time out.
  BACKFILL_MONTHS_PER_RUN: 3,

  // PCO rate limit is 100 requests / 20 seconds. Keep a small gap between calls.
  PCO_REQUEST_DELAY_MS: 250,
  PCO_RATE_LIMIT_SLEEP_MS: 21000
};

const SHEETS = {
  giving: 'GivingMonthly',
  attendance: 'AttendanceMonthly',
  attendanceWeekly: 'AttendanceWeekly',
  groups: 'CommunityGroupsMonthly',
  members: 'MembersGrowth',
  json: 'DashboardJSON',
  teams: 'Leader Forms',
  servicesTeams: 'ServeTeams',
  volunteers: 'Volunteers',
  plans: 'Plans',
  baptisms: 'Baptisms',
  budget: 'Budget',
  missions: 'Missions',
  cgAttendance: 'CGGroupAttendance',
  cgPipeline:   'CGLeaderPipeline',
  cgFunnel:     'CGJoinFunnel',
  cgOutsiders:  'CGOutsiders'
};

/* =========================================================
   MAIN FUNCTIONS
========================================================= */

function syncDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);
  const months = getRecentMonths_(DASHBOARD_CONFIG.RECENT_MONTHS_TO_REFRESH);

  // 1. Pull giving, attendance (monthly), community groups
  refreshDashboardMonths_(months, 'recent refresh');

  // 2. Pull weekly attendance for recent months and push updated JSON
  safeRun_('Weekly Attendance (recent)', () => {
    const rows = getAttendanceWeeklyRowsForMonths_(months);
    upsertWeeklyAttendanceRows_(ss.getSheetByName(SHEETS.attendanceWeekly), rows);
  });

  // 3. Pull serve teams once, then rebuild and push final JSON
  safeRun_('Services Teams', () => { syncServicesTeamsData_(); });

  // 4. Pull volunteer stats + service plan history from PCO Services
  safeRun_('Teams Volunteers+Plans', () => { syncTeamsDetailData_(); });

  // 4b. Pull upcoming Sunday plan details (volunteers, order of service, preacher)
  safeRun_('Sunday Plans', () => { syncSundayPlansData_(); });

  // 5. Pull baptism dates from PCO People API (people with baptized_at set)
  safeRun_('Baptisms', () => { syncBaptisms_(); });

  // 5b. Pull church member counts over time from PCO People API
  safeRun_('Members Growth', () => { syncMembersOverTime_(); });

  // 6. CG detailed: per-group attendance, join funnel, outsiders, leader pipeline
  safeRun_('CG Group Attendance', () => { syncCGGroupAttendance_(); });
  safeRun_('CG Join Funnel',      () => { syncCGJoinFunnel_(); });
  safeRun_('CG Outsiders',        () => { syncCGOutsiders_(); });
  safeRun_('CG Leader Pipeline',  () => { syncCGLeaderPipeline_(); });

  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);
  Logger.log('Final JSON (with weekly attendance + serve teams) pushed to GitHub.');

  // 7. Push funnel + calendar data to Staff OS eos-data.json
  safeRun_('Staff OS Funnel+Calendar', () => { syncStaffOSFunnelAndCalendar_(); });
}

function syncRecentDashboardData() {
  // Kept for backwards compatibility — just calls syncDashboard now.
  syncDashboard();
}

function refreshServicesTeams() {
  // Manual helper: run this any time you want to refresh the ServeTeams tab only.
  syncServicesTeamsData_();
}

function syncSundayAndPublish() {
  // Re-fetches Sunday plan data from PCO, updates SundayPlans sheet,
  // rebuilds dashboard-data.json, and pushes to GitHub. ~2 min.
  syncSundayPlansData_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
}


/**
 * Manual one-time historical backfill chunks.
 * Run these one at a time from the Apps Script dropdown:
 *   1) backfillDashboard2018To2020
 *   2) backfillDashboard2021To2023
 *   3) backfillDashboard2024ToNow
 *
 * After those finish, your hourly syncDashboard trigger only refreshes recent months.
 */

function backfillDashboard2018To2020() {
  backfillDashboardRange_('2018-01-01', '2020-12-31');
}

function backfillDashboard2021To2023() {
  backfillDashboardRange_('2021-01-01', '2023-12-31');
}

function backfillDashboard2024ToNow() {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  backfillDashboardRange_('2024-01-01', today);
}

/**
 * Attendance-only backfill — run these to populate weekly attendance history
 * without re-pulling giving/groups (which are already cached).
 * Run in order:
 *   1) backfillWeeklyAttendance2018To2020
 *   2) backfillWeeklyAttendance2021To2023
 *   3) backfillWeeklyAttendance2024ToNow
 */

/**
 * Run this ONE function to backfill ALL weekly attendance from 2018 to now.
 * It processes one year at a time and schedules itself to continue,
 * so it won't time out. Check Executions log for progress.
 */
function backfillAllWeeklyAttendance() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('WEEKLY_BACKFILL_YEAR', '2018');
  removeWeeklyBackfillTriggers_();
  Logger.log('Starting full weekly attendance backfill from 2018...');
  continueWeeklyAttendanceBackfill();
}

function continueWeeklyAttendanceBackfill() {
  const props = PropertiesService.getScriptProperties();
  const year = Number(props.getProperty('WEEKLY_BACKFILL_YEAR') || '2018');
  const currentYear = new Date().getFullYear();

  if (year > currentYear) {
    removeWeeklyBackfillTriggers_();
    props.deleteProperty('WEEKLY_BACKFILL_YEAR');
    Logger.log('✅ Weekly attendance backfill complete through ' + currentYear + '.');
    return;
  }

  const endDate = year === currentYear
    ? Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : year + '-12-31';

  Logger.log('Weekly backfill: processing year ' + year + ' (' + year + '-01-01 → ' + endDate + ')');
  backfillWeeklyAttendanceRange_(year + '-01-01', endDate);

  props.setProperty('WEEKLY_BACKFILL_YEAR', String(year + 1));
  removeWeeklyBackfillTriggers_();
  ScriptApp.newTrigger('continueWeeklyAttendanceBackfill').timeBased().after(90 * 1000).create();
  Logger.log('Year ' + year + ' done. Scheduled continuation for year ' + (year + 1) + ' in 90 seconds.');
}

function removeWeeklyBackfillTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'continueWeeklyAttendanceBackfill') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function cancelWeeklyAttendanceBackfill() {
  removeWeeklyBackfillTriggers_();
  PropertiesService.getScriptProperties().deleteProperty('WEEKLY_BACKFILL_YEAR');
  Logger.log('Weekly attendance backfill cancelled.');
}

function deduplicateWeeklyAttendance() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.attendanceWeekly);
  if (!sh) { Logger.log('Sheet not found'); return; }
  const allVals = sh.getDataRange().getValues();
  if (allVals.length <= 1) return;
  const headers = allVals[0];
  const seen = {};
  const deduped = [];
  for (let i = 1; i < allVals.length; i++) {
    const raw = allVals[i][1];
    const dateKey = raw instanceof Date ? isoDate_(raw) : String(raw);
    if (!dateKey || seen[dateKey]) continue;
    seen[dateKey] = true;
    deduped.push(allVals[i]);
  }
  deduped.sort((a, b) => {
    const da = a[1] instanceof Date ? isoDate_(a[1]) : String(a[1]);
    const db = b[1] instanceof Date ? isoDate_(b[1]) : String(b[1]);
    return da.localeCompare(db);
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, 5).setValues([headers]);
  if (deduped.length) sh.getRange(2, 1, deduped.length, 5).setValues(deduped);
  sh.setFrozenRows(1);
  Logger.log('Deduplicated: ' + deduped.length + ' unique weekly rows remain.');
}

function backfillWeeklyAttendance2018() {
  backfillWeeklyAttendanceRange_('2018-01-01', '2018-12-31');
}

function backfillWeeklyAttendance2019() {
  backfillWeeklyAttendanceRange_('2019-01-01', '2019-12-31');
}

function backfillWeeklyAttendance2020() {
  backfillWeeklyAttendanceRange_('2020-01-01', '2020-12-31');
}

function backfillWeeklyAttendance2021() {
  backfillWeeklyAttendanceRange_('2021-01-01', '2021-12-31');
}

function backfillWeeklyAttendance2022() {
  backfillWeeklyAttendanceRange_('2022-01-01', '2022-12-31');
}

function backfillWeeklyAttendance2023() {
  backfillWeeklyAttendanceRange_('2023-01-01', '2023-12-31');
}

function backfillWeeklyAttendance2024() {
  backfillWeeklyAttendanceRange_('2024-01-01', '2024-12-31');
}

function backfillWeeklyAttendance2025() {
  backfillWeeklyAttendanceRange_('2025-01-01', '2025-12-31');
}

function backfillWeeklyAttendance2026() {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  backfillWeeklyAttendanceRange_('2026-01-01', today);
}

function backfillWeeklyAttendanceRange_(startDate, endDate) {
  const months = getMonthsBetween_(startDate, endDate);
  Logger.log('Weekly attendance backfill: ' + months.length + ' months (' + startDate + ' → ' + endDate + ')');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);

  safeRun_('Weekly Attendance', () => {
    const rows = getAttendanceWeeklyRowsForMonths_(months);
    upsertWeeklyAttendanceRows_(ss.getSheetByName(SHEETS.attendanceWeekly), rows);
  });

  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);
  Logger.log('Weekly attendance backfill done and JSON pushed to GitHub.');
}

function backfillDashboardRange_(startDate, endDate) {
  const months = getMonthsBetween_(startDate, endDate);
  Logger.log('Backfilling ' + months.length + ' months: ' + startDate + ' → ' + endDate);
  refreshDashboardMonths_(months, startDate + ' → ' + endDate);
}

function getMonthsBetween_(startDate, endDate) {
  const out = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  let cur = new Date(start.getFullYear(), start.getMonth(), 1);

  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);

    out.push({
      key: monthKey_(first),
      label: monthLabel_(first),
      start: isoDate_(first),
      end: isoDate_(last)
    });

    cur = new Date(y, m + 1, 1);
  }

  return out;
}


function rebuildDashboardJsonFromCache() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);
  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);
  Logger.log('Dashboard JSON rebuilt from cached sheet history and pushed to GitHub.');
}

function backfillAllDashboardData() {
  // Start a new full-history backfill from 2018 and let Apps Script continue it in chunks.
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_BACKFILL_NEXT_INDEX', '0');
  props.setProperty('DASHBOARD_BACKFILL_STARTED_AT', new Date().toISOString());

  removeBackfillContinuationTriggers_();
  Logger.log('Starting resumable dashboard backfill from ' + DASHBOARD_CONFIG.FULL_HISTORY_START_DATE + '.');
  Logger.log('This will process ' + DASHBOARD_CONFIG.BACKFILL_MONTHS_PER_RUN + ' months per run and continue automatically.');

  continueBackfillDashboardData();
}

function continueBackfillDashboardData() {
  const props = PropertiesService.getScriptProperties();
  const allMonths = getMonthsFromDateToNow_(DASHBOARD_CONFIG.FULL_HISTORY_START_DATE);
  const chunkSize = Number(DASHBOARD_CONFIG.BACKFILL_MONTHS_PER_RUN || 3);

  let nextIndex = Number(props.getProperty('DASHBOARD_BACKFILL_NEXT_INDEX') || '0');
  if (nextIndex < 0) nextIndex = 0;

  if (nextIndex >= allMonths.length) {
    finishBackfillDashboardData_();
    return;
  }

  const chunk = allMonths.slice(nextIndex, nextIndex + chunkSize);
  Logger.log('=== Resumable backfill chunk ===');
  Logger.log('Processing months ' + (nextIndex + 1) + '–' + (nextIndex + chunk.length) + ' of ' + allMonths.length + ': ' + chunk.map(m => m.label).join(', '));

  refreshDashboardMonths_(chunk, 'backfill chunk');

  nextIndex += chunk.length;
  props.setProperty('DASHBOARD_BACKFILL_NEXT_INDEX', String(nextIndex));

  if (nextIndex >= allMonths.length) {
    finishBackfillDashboardData_();
  } else {
    scheduleBackfillContinuation_();
    Logger.log('Backfill progress saved. Next chunk starts at month #' + (nextIndex + 1) + ' of ' + allMonths.length + '.');
  }
}

function finishBackfillDashboardData_() {
  const props = PropertiesService.getScriptProperties();
  removeBackfillContinuationTriggers_();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);
  cleanMonthlySheet_(ss.getSheetByName(SHEETS.giving), 5);
  cleanMonthlySheet_(ss.getSheetByName(SHEETS.attendance), 4);
  cleanMonthlySheet_(ss.getSheetByName(SHEETS.groups), 4);

  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);

  props.deleteProperty('DASHBOARD_BACKFILL_NEXT_INDEX');
  props.deleteProperty('DASHBOARD_BACKFILL_STARTED_AT');

  Logger.log('✅ Full dashboard backfill complete. Cache cleaned, JSON rebuilt, and GitHub updated.');
}

function scheduleBackfillContinuation_() {
  removeBackfillContinuationTriggers_();
  ScriptApp.newTrigger('continueBackfillDashboardData')
    .timeBased()
    .after(60 * 1000)
    .create();
}

function removeBackfillContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction && t.getHandlerFunction() === 'continueBackfillDashboardData') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function cancelBackfillDashboardData() {
  removeBackfillContinuationTriggers_();
  PropertiesService.getScriptProperties().deleteProperty('DASHBOARD_BACKFILL_NEXT_INDEX');
  PropertiesService.getScriptProperties().deleteProperty('DASHBOARD_BACKFILL_STARTED_AT');
  Logger.log('Backfill continuation cancelled.');
}


function cleanAndRebuildDashboardCache() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);
  cleanMonthlySheet_(ss.getSheetByName(SHEETS.giving), 5);
  cleanMonthlySheet_(ss.getSheetByName(SHEETS.attendance), 4);
  cleanMonthlySheet_(ss.getSheetByName(SHEETS.groups), 4);
  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);
  Logger.log('Cache cleaned, dashboard JSON rebuilt, and GitHub updated.');
}

function refreshDashboardMonths_(months, label) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);

  Logger.log('=== Dashboard ' + label + ' ===');
  Logger.log('Months: ' + months.map(m => m.label).join(', '));

  safeRun_('Giving', () => {
    const rows = getGivingRowsForMonths_(months);
    upsertMonthlyRows_(ss.getSheetByName(SHEETS.giving), rows, 5);
  });

  safeRun_('Attendance', () => {
    const rows = getAttendanceRowsForMonths_(months);
    upsertMonthlyRows_(ss.getSheetByName(SHEETS.attendance), rows, 4);
  });

  safeRun_('Community Groups', () => {
    const rows = getCommunityGroupRowsForMonths_(months);
    upsertMonthlyRows_(ss.getSheetByName(SHEETS.groups), rows, 4);
  });

  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);

  Logger.log('Dashboard JSON generated from cache and pushed to GitHub.');
}

function safeRun_(label, fn) {
  try {
    Logger.log('▶  ' + label + ' — starting');
    fn();
    Logger.log('✓  ' + label + ' — done');
  } catch (err) {
    Logger.log('✗  ' + label + ' FAILED: ' + err.message + '\n' + (err.stack || ''));
  }
}

/* =========================================================
   SHEET CACHE SETUP + BUILD JSON
========================================================= */

function setupCacheSheets_(ss) {
  ensureSheet_(ss, SHEETS.giving, ['MonthKey', 'Month', 'General Giving', 'Building', 'Total']);
  ensureSheet_(ss, SHEETS.attendance, ['MonthKey', 'Month', 'Adults', 'Kids']);
  ensureSheet_(ss, SHEETS.attendanceWeekly, ['MonthKey', 'DateKey', 'Week', 'Adults', 'Kids']);
  ensureSheet_(ss, SHEETS.groups, ['MonthKey', 'Month', 'Groups', 'Members']);
  ensureSheet_(ss, SHEETS.servicesTeams, ['Team ID', 'Team Name', 'Volunteer Count', 'Source', 'Last Updated']);
  ensureSheet_(ss, SHEETS.baptisms,      ['Month Key', 'Month Label', 'Count', 'Last Updated']);
  ensureSheet_(ss, SHEETS.members,       ['Year', 'New Members', 'Total Current', 'Last Updated']);
  ensureSheet_(ss, SHEETS.json, ['Last Updated', 'JSON']);
  ensureSheet_(ss, SHEETS.cgAttendance,  ['GroupName', 'Members', 'Leaders', 'Schedule', 'FillPct', 'AvgAttendance']);
  ensureSheet_(ss, SHEETS.cgPipeline,    ['Type', 'Phase', 'Label', 'Name', 'AddedIn2026']);
  ensureSheet_(ss, SHEETS.cgFunnel,      ['MonthKey', 'Month', 'Applied', 'Joined']);
  ensureSheet_(ss, SHEETS.cgOutsiders,   ['MonthKey', 'Month', 'Count']);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeaders = headers.some((h, i) => current[i] !== h);
  if (needsHeaders) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function upsertMonthlyRows_(sh, rows, columnCount) {
  if (!rows.length) return;

  const existing = sh.getDataRange().getValues();
  const rowByKey = {};
  for (let i = 1; i < existing.length; i++) {
    const key = existing[i][0];
    if (key) rowByKey[key] = i + 1;
  }

  rows.forEach(row => {
    const key = row[0];
    if (!key) return;
    const rowNum = rowByKey[key];
    const values = row.slice(0, columnCount);
    values[1] = monthLabelFromKey_(String(key));
    if (rowNum) {
      sh.getRange(rowNum, 1, 1, columnCount).setValues([values]);
    } else {
      sh.appendRow(values);
    }
  });

  cleanMonthlySheet_(sh, columnCount);
}

function cleanMonthlySheet_(sh, columnCount) {
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return;

  const headers = values[0].slice(0, columnCount);
  const byKey = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i].slice(0, columnCount);
    const key = normalizeMonthKey_(row[0], row[1]);
    if (!key) continue;
    row[0] = key;
    row[1] = monthLabelFromKey_(key);
    byKey[key] = row;
  }

  const rows = Object.keys(byKey).sort().map(k => byKey[k]);
  sh.clearContents();
  sh.getRange(1, 1, 1, columnCount).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, columnCount).setValues(rows);
  sh.setFrozenRows(1);
}

/* =========================================================
   CG DETAILED SYNC — Group Attendance, Join Funnel, Outsiders, Leader Pipeline
   All pull from PCO Groups / People APIs and write to their respective sheets.
========================================================= */

function syncCGGroupAttendance_() {
  Logger.log('▶  CG Group Attendance — starting');
  let groups = pcoGetAll_(
    '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
    '/groups?per_page=100&where[archive_status]=all'
  ) || [];
  if (!groups.length) {
    groups = pcoGetAll_(
      '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
      '/groups?per_page=100'
    ) || [];
  }
  Logger.log('   Groups fetched: ' + groups.length);

  const TARGET_SIZE = 10; // from goals2026.groupSize
  // rows: [name, memberCount, leaderCount, schedule, fillPct]
  // groupIds: parallel array so we can call attendance sub-resources later
  const rows = [];
  const groupIds = [];

  groups.forEach(function(g) {
    try {
      const attr = g.attributes || {};
      const name = attr.name || 'Unknown';
      const schedule = attr.schedule || attr.meeting_time || '';

      const memberships = pcoGetAll_(
        '/groups/v2/groups/' + g.id + '/memberships?per_page=100'
      ) || [];

      let memberCount = 0;
      let leaderCount = 0;
      memberships.forEach(function(m) {
        const ma = m.attributes || {};
        if (ma.left_at || ma.removed_at) return;
        memberCount++;
        if (ma.role === 'leader') leaderCount++;
      });

      const fillPct = Math.round((memberCount / TARGET_SIZE) * 100);
      rows.push([name, memberCount, leaderCount, schedule, fillPct]);
      groupIds.push(g.id);
    } catch (e) {
      Logger.log('   ! Group health for ' + g.id + ': ' + e.message);
    }
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hdrs = ['GroupName', 'Members', 'Leaders', 'Schedule', 'FillPct', 'AvgAttendance'];
  const sh = ensureSheet_(ss, SHEETS.cgAttendance, hdrs);

  // ----------------------------------------------------------------
  // Preserve manually-entered AvgAttendance values from previous sync
  // ----------------------------------------------------------------
  const existingAvgByName = {};
  try {
    if (sh.getLastRow() >= 2 && sh.getLastColumn() >= 6) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function(row) {
        const name = String(row[0] || '').trim();
        const avg  = Number(row[5]) || 0;
        if (name && avg > 0) existingAvgByName[name] = avg;
      });
      Logger.log('   Preserved manual avg for ' + Object.keys(existingAvgByName).length + ' groups');
    }
  } catch (e) {
    Logger.log('   ! Could not read existing avg: ' + e.message);
  }

  // ----------------------------------------------------------------
  // PCO Groups Attendance
  // Strategy 1: GET /groups/v2/groups/{id}/attendances
  //   → Each record has a "headcount" integer (requires Attendance feature in PCO)
  // Strategy 2: GET /groups/v2/groups/{id}/events → events/{id}/attendances
  //   → Count attended=true records per event as the headcount
  // ----------------------------------------------------------------
  const pcoAvgByGroupName = {};
  const SIX_MO_AGO = new Date();
  SIX_MO_AGO.setMonth(SIX_MO_AGO.getMonth() - 6);
  const cutoffDate = SIX_MO_AGO.toISOString().substring(0, 10); // YYYY-MM-DD

  // ── Strategy 1: direct group attendances (headcount per meeting) ──
  let strategy1Works = null; // null = untested, true/false after first attempt
  rows.forEach(function(row, idx) {
    const groupId = groupIds[idx];
    const name = row[0];
    if (!groupId) return;

    try {
      const atts = pcoTryGetAll_(
        '/groups/v2/groups/' + groupId + '/attendances?per_page=25'
      );
      if (atts === null) {
        // 404 — feature not enabled for this org; stop trying strategy 1
        if (strategy1Works !== false) {
          Logger.log('   Strategy 1 (direct attendances): 404 — feature not enabled');
          strategy1Works = false;
        }
        return;
      }
      strategy1Works = true;

      // Filter to recent records only
      const recent = atts.filter(function(a) {
        const d = (a.attributes || {}).attended_at || '';
        return d >= cutoffDate;
      });
      const usedAtts = recent.length > 0 ? recent : atts;

      let total = 0, count = 0;
      usedAtts.forEach(function(a) {
        const hc = Number((a.attributes || {}).headcount) || 0;
        if (hc > 0) { total += hc; count++; }
      });
      if (count > 0) {
        pcoAvgByGroupName[name] = Math.round(total / count);
        Logger.log('   S1 "' + name + '": ' + atts.length + ' att records, avg=' + pcoAvgByGroupName[name]);
      }
    } catch (e) {
      Logger.log('   ! S1 att for "' + name + '": ' + e.message);
    }
  });

  // ── Strategy 2: events → per-event attendance count ──
  if (strategy1Works === false) {
    Logger.log('   Strategy 2: fetching events per group...');
    rows.forEach(function(row, idx) {
      const groupId = groupIds[idx];
      const name = row[0];
      if (!groupId) return;

      try {
        const events = pcoTryGetAll_(
          '/groups/v2/groups/' + groupId + '/events?per_page=20'
        ) || [];

        // Only past events within the last 6 months
        const pastEvents = events.filter(function(ev) {
          const startsAt = (ev.attributes || {}).starts_at || '';
          const endsAt   = (ev.attributes || {}).ends_at   || startsAt;
          const now = new Date().toISOString();
          return startsAt >= cutoffDate && endsAt <= now;
        });

        if (events.length > 0 && idx === 0) {
          // Log first group's event structure once so we can see available fields
          Logger.log('   S2 sample event attrs: ' + JSON.stringify((events[0].attributes || {})));
        }

        let total = 0, count = 0;
        pastEvents.forEach(function(ev) {
          try {
            // Some orgs track via event#headcounts; others via event#attendances (per-person)
            const evAtts = pcoTryGetAll_(
              '/groups/v2/events/' + ev.id + '/attendances?per_page=100'
            );
            if (evAtts && evAtts.length > 0) {
              // Per-person records: count attended=true
              const attended = evAtts.filter(function(a) {
                return (a.attributes || {}).attended === true;
              }).length;
              total += attended;
              count++;
            } else {
              // Try headcount attribute directly on the event
              const hc = Number((ev.attributes || {}).headcount || (ev.attributes || {}).attendance_count || 0);
              if (hc > 0) { total += hc; count++; }
            }
          } catch (e) {}
        });

        if (count > 0) {
          pcoAvgByGroupName[name] = Math.round(total / count);
          Logger.log('   S2 "' + name + '": ' + pastEvents.length + ' events, avg=' + pcoAvgByGroupName[name]);
        }
      } catch (e) {
        Logger.log('   ! S2 events for "' + name + '": ' + e.message);
      }
    });
  }

  const pcoHits = Object.keys(pcoAvgByGroupName).length;
  Logger.log('   PCO attendance data found for ' + pcoHits + ' of ' + rows.length + ' groups');

  // Merge: PCO data wins → manual entry → 0
  rows.forEach(function(row) {
    const name = row[0];
    const avg = pcoAvgByGroupName[name] || existingAvgByName[name] || 0;
    row.push(avg);
  });

  // Sort by members descending
  rows.sort(function(a, b) { return (b[1] || 0) - (a[1] || 0); });

  sh.clearContents();
  sh.getRange(1, 1, 1, hdrs.length).setValues([hdrs]);
  if (rows.length) sh.getRange(2, 1, rows.length, hdrs.length).setValues(rows);
  sh.setFrozenRows(1);
  Logger.log('   CG Group Health done: ' + rows.length + ' groups, ' + pcoHits + ' with PCO attendance data');
}

function syncCGJoinFunnel_() {
  Logger.log('▶  CG Join Funnel — starting');
  const START_DATE = '2024-01-01';
  const groups = pcoGetAll_(
    '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
    '/groups?per_page=100&where[archive_status]=all'
  ) || [];

  const appliedByMonth = {}, joinedByMonth = {};
  groups.forEach(function(g) {
    try {
      const memberships = pcoGetAll_(
        '/groups/v2/groups/' + g.id + '/memberships?per_page=100'
      ) || [];
      memberships.forEach(function(m) {
        const a = m.attributes || {};
        const role = a.role || 'member';
        if (role !== 'member' && role !== 'leader') return;

        // "Applied" = created_at (first request / auto-add)
        const createdAt = a.created_at;
        if (createdAt && createdAt >= START_DATE) {
          const mk = createdAt.substring(0, 7);
          appliedByMonth[mk] = (appliedByMonth[mk] || 0) + 1;
        }
        // "Joined" = joined_at (approved / became active member)
        const joinedAt = a.joined_at;
        if (joinedAt && joinedAt >= START_DATE) {
          const mk = joinedAt.substring(0, 7);
          joinedByMonth[mk] = (joinedByMonth[mk] || 0) + 1;
        }
      });
    } catch (e) {
      Logger.log('   ! Join funnel group ' + g.id + ': ' + e.message);
    }
  });

  // Merge month keys from both buckets
  const allMonthKeys = Object.keys(
    Object.assign({}, appliedByMonth, joinedByMonth)
  ).sort();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hdrs = ['MonthKey', 'Month', 'Applied', 'Joined'];
  const sh = ensureSheet_(ss, SHEETS.cgFunnel, hdrs);
  sh.clearContents();
  sh.getRange(1, 1, 1, hdrs.length).setValues([hdrs]);
  const rows = allMonthKeys.map(function(mk) {
    return [mk, monthLabelFromKey_(mk), appliedByMonth[mk] || 0, joinedByMonth[mk] || 0];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, hdrs.length).setValues(rows);
  sh.setFrozenRows(1);
  Logger.log('   CG Join Funnel done: ' + rows.length + ' months');
}

function syncCGOutsiders_() {
  Logger.log('▶  CG Outsiders — starting');
  const START_DATE = '2024-01-01';

  // Build set of person IDs who are formal church Members in PCO People
  Logger.log('   Fetching church members from PCO People...');
  const memberSet = new Set();
  try {
    const members = pcoGetAll_(
      '/people/v2/people?where[membership]=Member&fields[Person]=id&per_page=100'
    ) || [];
    members.forEach(function(p) { memberSet.add(p.id); });
    Logger.log('   Church Members in PCO: ' + memberSet.size);
  } catch (e) {
    Logger.log('   ! Could not fetch church members: ' + e.message);
  }

  const groups = pcoGetAll_(
    '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
    '/groups?per_page=100&where[archive_status]=all'
  ) || [];

  const outsidersByMonth = {};
  const membersInCGSet = new Set(); // tracks church members currently in any CG
  groups.forEach(function(g) {
    try {
      const memberships = pcoGetAll_(
        '/groups/v2/groups/' + g.id + '/memberships?per_page=100'
      ) || [];
      memberships.forEach(function(m) {
        const personId = m.relationships && m.relationships.person &&
                         m.relationships.person.data && m.relationships.person.data.id;
        if (!personId) return;
        // FM in Groups: count ALL current members who are formal church members
        if (memberSet.has(personId)) {
          membersInCGSet.add(personId);
        }
        // Outsiders: only people who joined recently and aren't church members
        const joinedAt = (m.attributes && m.attributes.joined_at) || null;
        if (!joinedAt || joinedAt < START_DATE) return;
        if (!memberSet.has(personId)) {
          const mk = joinedAt.substring(0, 7);
          outsidersByMonth[mk] = (outsidersByMonth[mk] || 0) + 1;
        }
      });
    } catch (e) {
      Logger.log('   ! Outsiders group ' + g.id + ': ' + e.message);
    }
  });

  // Calculate and persist FM in Groups %
  const fmInGroupsPct = memberSet.size > 0
    ? Math.round(membersInCGSet.size / memberSet.size * 100)
    : 0;
  Logger.log('   FM in Groups: ' + membersInCGSet.size + ' / ' + memberSet.size + ' church members = ' + fmInGroupsPct + '%');
  PropertiesService.getScriptProperties().setProperty('FM_IN_GROUPS_PCT', String(fmInGroupsPct));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hdrs = ['MonthKey', 'Month', 'Count'];
  const sh = ensureSheet_(ss, SHEETS.cgOutsiders, hdrs);
  sh.clearContents();
  sh.getRange(1, 1, 1, hdrs.length).setValues([hdrs]);
  const allMonths = Object.keys(outsidersByMonth).sort();
  const rows = allMonths.map(function(mk) {
    return [mk, monthLabelFromKey_(mk), outsidersByMonth[mk]];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, hdrs.length).setValues(rows);
  sh.setFrozenRows(1);
  Logger.log('   CG Outsiders done: ' + rows.length + ' months');
}

function syncCGLeaderPipeline_() {
  Logger.log('▶  CG Leader Pipeline — starting');

  const NOW_YEAR = new Date().getFullYear();
  const allRows = []; // [Type, Phase, Label, Name, AddedThisYear]

  // ----------------------------------------------------------------
  // Part 1 — ALWAYS: pull current active group leaders (roster)
  // These are real current leaders, categorised by tenure
  // ----------------------------------------------------------------
  try {
    const groups = pcoGetAll_(
      '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
      '/groups?per_page=100&where[archive_status]=all'
    ) || [];

    const leaderEntries = []; // { personId, joinedYear }
    groups.forEach(function(g) {
      const leaders = pcoGetAll_(
        '/groups/v2/groups/' + g.id + '/memberships?where[role]=leader&per_page=100'
      ) || [];
      leaders.forEach(function(l) {
        const attr = l.attributes || {};
        if (attr.left_at || attr.removed_at) return; // skip departed
        const joinedAt = attr.joined_at || '';
        const joinedYear = joinedAt ? new Date(joinedAt).getFullYear() : 0;
        const personId = l.relationships && l.relationships.person &&
                         l.relationships.person.data && l.relationships.person.data.id;
        if (personId) leaderEntries.push({ personId: personId, joinedYear: joinedYear });
      });
    });

    // Resolve names
    const rosterIds = Array.from(new Set(leaderEntries.map(function(e) { return e.personId; })));
    const nameById = {};
    const BATCH = 50;
    for (let i = 0; i < rosterIds.length; i += BATCH) {
      const chunk = rosterIds.slice(i, i + BATCH);
      const people = pcoGetAll_(
        '/people/v2/people?where[id]=' + chunk.join(',') +
        '&fields[Person]=first_name,last_name&per_page=' + chunk.length
      ) || [];
      people.forEach(function(p) {
        const fn = (p.attributes && p.attributes.first_name) || '';
        const ln = (p.attributes && p.attributes.last_name) || '';
        nameById[p.id] = (fn + ' ' + ln).trim() || ('Person ' + p.id);
      });
      Utilities.sleep(250);
    }

    // Deduplicate (may lead multiple groups) — all go into single "Current Leader" category
    const seen = new Set();
    leaderEntries.forEach(function(e) {
      if (seen.has(e.personId)) return;
      seen.add(e.personId);
      allRows.push(['roster', '1', 'Current Leader', nameById[e.personId] || e.personId,
                    e.joinedYear === NOW_YEAR ? 'Yes' : '']);
    });
    Logger.log('   Roster rows: ' + allRows.length);
  } catch (e) {
    Logger.log('   ! Roster pull failed: ' + e.message);
  }

  // ----------------------------------------------------------------
  // Part 2 — OPTIONAL: find a PCO People workflow for leader development
  // These are pipeline candidates (not yet leaders)
  // ----------------------------------------------------------------
  try {
    const workflows = pcoGetAll_('/people/v2/workflows?per_page=100') || [];
    Logger.log('   PCO workflows found: ' + workflows.length);
    workflows.forEach(function(w) {
      Logger.log('     workflow: ' + (w.attributes && w.attributes.name));
    });

    const leaderWf = workflows.find(function(w) {
      const nm = ((w.attributes && w.attributes.name) || '').toLowerCase();
      return nm.includes('leader') && (nm.includes('cg') || nm.includes('community') ||
             nm.includes('group') || nm.includes('training') || nm.includes('develop'));
    }) || workflows.find(function(w) {
      const nm = ((w.attributes && w.attributes.name) || '').toLowerCase();
      return nm.includes('pipeline') || nm.includes('apprentice') || nm.includes('intern') ||
             nm.includes('in training') || (nm.includes('leader') && nm.includes('develop'));
    });

    if (leaderWf) {
      Logger.log('   Using workflow for pipeline: ' + leaderWf.attributes.name);
      const steps = pcoGetAll_(
        '/people/v2/workflows/' + leaderWf.id + '/steps?per_page=100'
      ) || [];
      const stepNames = {};
      steps.forEach(function(s) {
        stepNames[s.id] = (s.attributes && s.attributes.name) || s.id;
      });

      const cards = pcoGetAll_(
        '/people/v2/workflows/' + leaderWf.id + '/cards?filter=assigned&per_page=100'
      ) || [];

      const personIds = [];
      const cardsByPerson = {};
      cards.forEach(function(card) {
        const stepId = card.relationships && card.relationships.current_step &&
                       card.relationships.current_step.data && card.relationships.current_step.data.id;
        const personId = card.relationships && card.relationships.person &&
                         card.relationships.person.data && card.relationships.person.data.id;
        const createdAt = (card.attributes && card.attributes.created_at) || '';
        if (!personId) return;
        personIds.push(personId);
        cardsByPerson[personId] = { stepId: stepId, createdAt: createdAt };
      });

      const wfNameById = {};
      const BATCH2 = 50;
      for (let i = 0; i < personIds.length; i += BATCH2) {
        const chunk = personIds.slice(i, i + BATCH2);
        const people = pcoGetAll_(
          '/people/v2/people?where[id]=' + chunk.join(',') +
          '&fields[Person]=first_name,last_name&per_page=' + chunk.length
        ) || [];
        people.forEach(function(p) {
          const fn = (p.attributes && p.attributes.first_name) || '';
          const ln = (p.attributes && p.attributes.last_name) || '';
          wfNameById[p.id] = (fn + ' ' + ln).trim() || ('Person ' + p.id);
        });
        Utilities.sleep(250);
      }

      let pipeCount = 0;
      steps.forEach(function(s, idx) {
        const phaseNum = String(idx + 1);
        const phaseLabel = stepNames[s.id];
        personIds.forEach(function(pid) {
          if (cardsByPerson[pid] && cardsByPerson[pid].stepId === s.id) {
            const addedThisYear = (cardsByPerson[pid].createdAt || '').startsWith(String(NOW_YEAR));
            allRows.push(['pipeline', phaseNum, phaseLabel, wfNameById[pid] || pid,
                          addedThisYear ? 'Yes' : '']);
            pipeCount++;
          }
        });
      });
      Logger.log('   Pipeline workflow rows: ' + pipeCount);
    } else {
      Logger.log('   No leader development workflow found in PCO');
    }
  } catch (e) {
    Logger.log('   ! Pipeline workflow lookup failed: ' + e.message);
  }

  // NOTE: Exhaustive search found no pipeline-specific tracking in PCO for this org:
  // - No leader development workflow (only "Joy Bombs" and "New Family Member" exist)
  // - No People List specifically for pipeline candidates
  // - No pipeline group type
  // If pipeline tracking is added to PCO in the future, add it to Parts 3/4 here.
  Logger.log('   No pipeline data found in PCO — only roster rows will be written');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hdrs = ['Type', 'Phase', 'Label', 'Name', 'AddedThisYear'];
  const sh = ensureSheet_(ss, SHEETS.cgPipeline, hdrs);
  sh.clearContents();
  sh.getRange(1, 1, 1, hdrs.length).setValues([hdrs]);
  if (allRows.length) sh.getRange(2, 1, allRows.length, hdrs.length).setValues(allRows);
  sh.setFrozenRows(1);
  Logger.log('   CG Leader Pipeline done: ' + allRows.length + ' total rows');
}

function buildDashboardDataFromSheet_(ss) {
  setupCacheSheets_(ss);

  // Export ALL cached history. The dashboard will make the charts horizontally scrollable.
  const givingRows = readRows_(ss.getSheetByName(SHEETS.giving), 5);
  const attendanceRows = readRows_(ss.getSheetByName(SHEETS.attendance), 4);
  const groupRows = readRows_(ss.getSheetByName(SHEETS.groups), 4);

  const pledgeRaised = calculatePledgeFromGivingRows_(readRows_(ss.getSheetByName(SHEETS.giving), 5));
  const baptismRows = readRows_(ss.getSheetByName(SHEETS.baptisms), 3);
  const memberRows  = readMembersRows_(ss.getSheetByName(SHEETS.members));

  const weeklyRows = readWeeklyAttendanceRows_(ss.getSheetByName(SHEETS.attendanceWeekly));

  // Build attendanceWeekly as { "2025-01": [{week, adults, kids}, ...], ... }
  const attendanceWeekly = {};
  weeklyRows.forEach(r => {
    const monthKey = r[0]; // YYYY-MM
    if (!attendanceWeekly[monthKey]) attendanceWeekly[monthKey] = [];
    attendanceWeekly[monthKey].push({
      week: r[2],   // e.g. "Jan 5"
      adults: Number(r[3]) || 0,
      kids: Number(r[4]) || 0
    });
  });

  return {
    lastUpdated: new Date().toISOString(),
    giving: {
      months: givingRows.map(r => r[1]),
      amounts: givingRows.map(r => Number(r[2]) || 0) // General Giving only; Building still counts toward pledge
    },
    pledge: {
      target: DASHBOARD_CONFIG.PLEDGE_TARGET,
      raised: Math.round(pledgeRaised)
    },
    attendance: {
      months: attendanceRows.map(r => r[0]), // use YYYY-MM keys so dashboard can look up weekly data
      adults: attendanceRows.map(r => Number(r[2]) || 0),
      kids: attendanceRows.map(r => Number(r[3]) || 0)
    },
    attendanceWeekly: attendanceWeekly,
    serveTeams: getServeTeams_(),
    budget: getBudgetData_(),
    missions: getMissionsData_(),
    teamsLeaderForms: getTeamsLeaderFormsDetailed_(),
    teamsVolunteers: getTeamsVolunteers_(),
    teamsPlans: getTeamsPlans_(),
    teamsMeta: {
      refreshed: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      lookback: 'Last 90 days',
      source: 'Planning Center Online'
    },
    communityGroups: {
      months: groupRows.map(r => r[1]),
      counts: groupRows.map(r => Number(r[2]) || 0)
    },
    communityGroupMembers: {
      months: groupRows.map(r => r[1]),
      counts: groupRows.map(r => Number(r[3]) || 0)
    },
    baptisms: {
      months: baptismRows.map(r => r[1]),
      counts: baptismRows.map(r => Number(r[2]) || 0),
      total:  baptismRows.reduce((s, r) => s + (Number(r[2]) || 0), 0)
    },
    members: {
      years:   memberRows.map(r => r[0]),
      counts:  memberRows.map(r => Number(r[1]) || 0),
      current: memberRows.length ? (Number(memberRows[memberRows.length - 1][2]) || 0) : 0
    },
    communityGroupsDetailed: buildCGDetailed_(ss, groupRows),
    sundayPlans: getSundayPlans_()
  };
}

function buildCGDetailed_(ss, groupRows) {
  // Build multi-year trend arrays from existing CommunityGroupsMonthly data
  const groupCountsByYear = {};
  const peopleInGroupsByYear = {};
  groupRows.forEach(r => {
    const key = r[0];
    if (!key || key.length < 7) return;
    const yr = key.substring(0, 4);
    const mo = parseInt(key.substring(5, 7), 10) - 1;
    if (mo < 0 || mo > 11) return;
    if (!groupCountsByYear[yr])    groupCountsByYear[yr]    = new Array(12).fill(null);
    if (!peopleInGroupsByYear[yr]) peopleInGroupsByYear[yr] = new Array(12).fill(null);
    groupCountsByYear[yr][mo]    = Number(r[2]) || null;
    peopleInGroupsByYear[yr][mo] = Number(r[3]) || null;
  });

  const latestRow = groupRows.length ? groupRows[groupRows.length - 1] : null;
  const latestGroups  = latestRow ? (Number(latestRow[2]) || 0) : 0;
  const latestMembers = latestRow ? (Number(latestRow[3]) || 0) : 0;
  const avgSize = latestGroups > 0 ? Math.round(latestMembers / latestGroups) : 0;

  // Per-group health from CGGroupAttendance sheet
  // Columns: GroupName | Members | Leaders | Schedule | FillPct | AvgAttendance
  const groupAttendance = [];
  const cgAttSh = ss.getSheetByName(SHEETS.cgAttendance);
  if (cgAttSh && cgAttSh.getLastRow() >= 2) {
    const colCount = Math.min(cgAttSh.getLastColumn(), 6);
    cgAttSh.getRange(2, 1, cgAttSh.getLastRow() - 1, colCount).getValues().forEach(r => {
      if (!r[0]) return;
      const members     = Number(r[1]) || 0;
      const avgAttended = colCount >= 6 ? (Number(r[5]) || 0) : 0;
      const attPct      = members > 0 && avgAttended > 0
                          ? Math.round((avgAttended / members) * 100) : 0;
      groupAttendance.push({
        name:        String(r[0]),
        members:     members,
        leaders:     Number(r[2]) || 0,
        schedule:    String(r[3] || ''),
        avgAttended: avgAttended,
        attPct:      attPct
      });
    });
  }

  // Leader data from CGLeaderPipeline sheet (Type, Phase, Label, Name, AddedThisYear)
  // type='roster'   → current active group leaders (by tenure)
  // type='pipeline' → candidates in a PCO leadership development workflow
  const leaderRoster   = [];
  const leaderPipeline = [];
  let leadersAdded2026 = 0;
  const cgPipSh = ss.getSheetByName(SHEETS.cgPipeline);
  if (cgPipSh && cgPipSh.getLastRow() >= 2) {
    const rosterPhaseMap   = {};
    const pipelinePhaseMap = {};
    cgPipSh.getRange(2, 1, cgPipSh.getLastRow() - 1, 5).getValues().forEach(r => {
      const type  = String(r[0]||'').trim().toLowerCase();
      const phase = String(r[1]||'').trim();
      const label = String(r[2]||'').trim();
      const name  = String(r[3]||'').trim();
      if (!phase || !name) return;
      if (r[4]) leadersAdded2026++;

      if (type === 'pipeline') {
        if (!pipelinePhaseMap[phase]) pipelinePhaseMap[phase] = { phase, label, names: [], count: 0 };
        pipelinePhaseMap[phase].names.push(name);
        pipelinePhaseMap[phase].count++;
      } else {
        // 'roster' or legacy rows without type
        if (!rosterPhaseMap[phase]) rosterPhaseMap[phase] = { phase, label, names: [], count: 0 };
        rosterPhaseMap[phase].names.push(name);
        rosterPhaseMap[phase].count++;
      }
    });
    Object.values(rosterPhaseMap).sort((a, b) => b.phase.localeCompare(a.phase)).forEach(p => leaderRoster.push(p));
    Object.values(pipelinePhaseMap).sort((a, b) => a.phase.localeCompare(b.phase)).forEach(p => leaderPipeline.push(p));
  }

  // Join funnel from CGJoinFunnel sheet (MonthKey, Month, Applied, Joined)
  const appliedToJoin = {};
  const joinedGroup = {};
  const cgFunnelSh = ss.getSheetByName(SHEETS.cgFunnel);
  if (cgFunnelSh && cgFunnelSh.getLastRow() >= 2) {
    cgFunnelSh.getRange(2, 1, cgFunnelSh.getLastRow() - 1, 4).getValues().forEach(r => {
      // Sheets may auto-parse "2024-01" as a Date object — convert back to YYYY-MM
      const rawKey = r[0];
      const key = (Object.prototype.toString.call(rawKey) === '[object Date]')
          ? Utilities.formatDate(rawKey, Session.getScriptTimeZone(), 'yyyy-MM')
          : String(rawKey||'').trim();
      if (key.length < 7) return;
      const yr = key.substring(0, 4);
      const mo = parseInt(key.substring(5, 7), 10) - 1;
      if (mo < 0 || mo > 11) return;
      if (!appliedToJoin[yr]) appliedToJoin[yr] = new Array(12).fill(null);
      if (!joinedGroup[yr])   joinedGroup[yr]   = new Array(12).fill(null);
      appliedToJoin[yr][mo] = r[2] !== '' ? (Number(r[2])||0) : null;
      joinedGroup[yr][mo]   = r[3] !== '' ? (Number(r[3])||0) : null;
    });
  }

  // Outsiders becoming insiders from CGOutsiders sheet (MonthKey, Month, Count)
  const outsidersInsiders = {};
  const cgOutSh = ss.getSheetByName(SHEETS.cgOutsiders);
  if (cgOutSh && cgOutSh.getLastRow() >= 2) {
    cgOutSh.getRange(2, 1, cgOutSh.getLastRow() - 1, 3).getValues().forEach(r => {
      // Sheets may auto-parse "2024-01" as a Date object — convert back to YYYY-MM
      const rawKey = r[0];
      const key = (Object.prototype.toString.call(rawKey) === '[object Date]')
          ? Utilities.formatDate(rawKey, Session.getScriptTimeZone(), 'yyyy-MM')
          : String(rawKey||'').trim();
      if (key.length < 7) return;
      const yr = key.substring(0, 4);
      const mo = parseInt(key.substring(5, 7), 10) - 1;
      if (mo < 0 || mo > 11) return;
      if (!outsidersInsiders[yr]) outsidersInsiders[yr] = new Array(12).fill(null);
      outsidersInsiders[yr][mo] = r[2] !== '' ? (Number(r[2])||0) : null;
    });
  }

  return {
    goals2026: { groups: 50, members: 500, groupSize: 10, fmInGroupsPct: 75 },
    current: {
      groups: latestGroups,
      members: latestMembers,
      groupSize: avgSize,
      fmInGroupsPct: parseFloat(PropertiesService.getScriptProperties().getProperty('FM_IN_GROUPS_PCT') || '0'),
      asOfMonth: latestRow ? latestRow[1] : ''
    },
    groupCountsByYear,
    peopleInGroupsByYear,
    appliedToJoin,
    joinedGroup,
    leadersAdded: { total2026: leadersAdded2026 },
    outsidersInsiders,
    leaderRoster,
    leaderPipeline,
    groupAttendance
  };
}

function readRows_(sh, columnCount) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const rows = sh.getRange(2, 1, lastRow - 1, columnCount).getValues();
  const byKey = {};

  rows.forEach(r => {
    const key = normalizeMonthKey_(r[0], r[1]);
    if (!key) return;
    const row = r.slice(0, columnCount);
    row[0] = key;
    row[1] = monthLabelFromKey_(key);
    byKey[key] = row; // last value wins if old duplicate rows exist
  });

  return Object.keys(byKey).sort().map(k => byKey[k]);
}

function calculatePledgeFromGivingRows_(rows) {
  let raised = 0;
  rows.forEach(r => {
    const monthKey = String(r[0]);
    const general = Number(r[2]) || 0;
    const building = Number(r[3]) || 0;

    if (monthKey >= DASHBOARD_CONFIG.GENERAL_FUND_PLEDGE_START.slice(0, 7)) raised += general;
    if (monthKey >= DASHBOARD_CONFIG.BUILDING_FUND_PLEDGE_START.slice(0, 7)) raised += building;
  });
  return raised;
}

function writeDashboardJsonToSheet_(ss, data) {
  const sh = ss.getSheetByName(SHEETS.json) || ss.insertSheet(SHEETS.json);
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([['Last Updated', 'JSON']]);
  sh.setFrozenRows(1);

  const json = JSON.stringify(data, null, 2);
  if (json.length <= 49000) {
    sh.getRange(2, 1, 1, 2).setValues([[new Date(), json]]);
  } else {
    // JSON too large for a single cell (50k char limit) — write a note instead.
    // The full JSON is still pushed to GitHub which has no size limit.
    sh.getRange(2, 1, 1, 2).setValues([[new Date(), '(JSON too large for sheet cell — see GitHub for full data. Size: ' + json.length + ' chars)']]);
    Logger.log('Note: dashboard JSON (' + json.length + ' chars) exceeds sheet cell limit. Only pushed to GitHub.');
  }
}

/* =========================================================
   GIVING CACHE ROWS
   Output rows: [MonthKey, MonthLabel, General, Building, Total]
========================================================= */

function getGivingRowsForMonths_(months) {
  const totals = {};
  months.forEach(m => {
    totals[m.key] = { general: 0, building: 0 };
  });

  let totalDonations = 0;
  let totalMatched = 0;

  // IMPORTANT: query one month at a time. A full-history Giving sweep can exceed
  // PCO/API pagination limits and Apps Script timeouts.
  months.forEach(m => {
    Logger.log('   Giving month: ' + m.label + ' (' + m.start + ' → ' + m.end + ')');

    const { data: donations, included } = pcoGetAllWithIncluded_(
      '/giving/v2/donations' +
      '?where[received_at][gte]=' + m.start +
      '&where[received_at][lte]=' + m.end +
      '&include=designations' +
      '&per_page=100'
    );

    totalDonations += donations.length;

    const includedById = {};
    included.forEach(inc => {
      if (inc.type !== 'Donation') includedById[inc.id] = inc;
    });

    // Pre-count how many designations each donation has (from included data).
    // Used by the fallback tally loop so fee splitting is always correct.
    const designationCountByDonationId = {};
    included.forEach(inc => {
      if (inc.type !== 'Designation') return;
      const donId = relId_(inc, 'donation');
      if (donId) designationCountByDonationId[donId] = (designationCountByDonationId[donId] || 0) + 1;
    });

    const donationDates = {};
    donations.forEach(d => {
      if (!donationCountsForNet_(d)) return;
      const date = d.attributes.received_at || d.attributes.created_at;
      if (date) donationDates[d.id] = { date, monthKey: monthKey_(new Date(date)), attrs: d.attributes || {} };
    });

    const countedIds = {};
    let matched = 0;

    function tally(des, donationMonthKey, donationAttrs, designationCount) {
      if (countedIds[des.id]) return;
      if (!(donationMonthKey in totals)) return;

      const fundId = relId_(des, 'fund');
      const amount = netDesignationAmount_(des.attributes, donationAttrs, designationCount);
      if (!amount) return;

      if (fundId === String(DASHBOARD_CONFIG.GENERAL_FUND_ID)) {
        totals[donationMonthKey].general += amount;
        countedIds[des.id] = true;
        matched++;
      }

      if (fundId === String(DASHBOARD_CONFIG.BUILDING_FUND_ID)) {
        totals[donationMonthKey].building += amount;
        countedIds[des.id] = true;
        matched++;
      }
    }

    donations.forEach(d => {
      const info = donationDates[d.id];
      if (!info) return;

      const refs = (((d.relationships || {}).designations || {}).data) || [];
      const designationCount = refs.length || 1;
      refs.forEach(ref => {
        const des = includedById[ref.id];
        if (des) tally(des, info.monthKey, info.attrs, designationCount);
      });
    });

    // Fallback: catch designations not linked via donation.relationships refs.
    // Use the pre-built count so fee splitting matches the first loop.
    Object.keys(includedById).forEach(id => {
      const des = includedById[id];
      const donationId = relId_(des, 'donation');
      const info = donationDates[donationId];
      if (!info) return;
      const desCount = designationCountByDonationId[donationId] || 1;
      tally(des, info.monthKey, info.attrs, desCount);
    });

    totalMatched += matched;
    Logger.log('     fetched donations=' + donations.length + ', matched designations=' + matched);
  });

  Logger.log('   Total donations fetched: ' + totalDonations + ', total matched designations: ' + totalMatched);

  return months.map(m => {
    const general = Math.round(totals[m.key].general);
    const building = Math.round(totals[m.key].building);
    Logger.log('     ' + m.label + ': general=$' + general.toLocaleString() + ', building=$' + building.toLocaleString());
    return [m.key, monthLabelFromKey_(m.key), general, building, general + building];
  });
}

function moneyAmount_(attrs) {
  // Legacy gross helper kept as a fallback. Giving now uses netDesignationAmount_().
  attrs = attrs || {};
  if (attrs.amount_cents != null)    return Number(attrs.amount_cents) / 100;
  if (attrs.amount_in_cents != null) return Number(attrs.amount_in_cents) / 100;
  if (attrs.amount != null) {
    const cleaned = String(attrs.amount).replace(/[^0-9.-]/g, '');
    return Number(cleaned) || 0;
  }
  return 0;
}

function centsAttr_(attrs, names) {
  attrs = attrs || {};
  for (let i = 0; i < names.length; i++) {
    const v = attrs[names[i]];
    if (v !== null && v !== undefined && v !== '') return Number(v) || 0;
  }
  return null;
}

function netDesignationAmount_(designationAttrs, donationAttrs, designationCount) {
  designationAttrs = designationAttrs || {};
  donationAttrs    = donationAttrs    || {};
  designationCount = Number(designationCount) || 1;

  // Gross amount for this designation in cents.
  const grossCents =
    centsAttr_(designationAttrs, ['amount_cents', 'amount_in_cents']) ??
    Math.round(moneyAmount_(designationAttrs) * 100);

  // PCO stores fee_cents as a NEGATIVE number (e.g., -150 means $1.50 charged).
  // Math.abs converts to a positive fee so we correctly subtract it from gross.
  const donationFeeCents = Math.abs(centsAttr_(donationAttrs, [
    'fee_cents',
    'processing_fee_cents',
    'processing_fees_cents'
  ]) || 0);
  const designationFeeCents = Math.round(donationFeeCents / designationCount);

  // Refunds: use designation-level if present, otherwise donation-level / count.
  let refundCents = centsAttr_(designationAttrs, [
    'refund_amount_cents',
    'refunded_amount_cents',
    'refund_cents'
  ]);
  if (refundCents === null) {
    const donationRefundCents = centsAttr_(donationAttrs, [
      'refund_amount_cents',
      'refunded_amount_cents',
      'refund_cents'
    ]) || 0;
    refundCents = Math.round(donationRefundCents / designationCount);
  }

  return (grossCents - designationFeeCents - refundCents) / 100;
}

function debugGivingMonth(monthStart, monthEnd) {
  const { data: donations, included } = pcoGetAllWithIncluded_(
    '/giving/v2/donations' +
    '?where[received_at][gte]=' + monthStart +
    '&where[received_at][lte]=' + monthEnd +
    '&include=designations&per_page=100'
  );

  // Index all included resources by id
  const includedById = {};
  included.forEach(inc => { includedById[inc.id] = inc; });

  // Donation-level status summary
  const statusCounts = {};
  let skipped = 0, donFeeTotal = 0, donGrossTotal = 0;
  donations.forEach(d => {
    const attrs = d.attributes || {};
    const status = String(attrs.status || attrs.payment_status || '').toLowerCase() || '(none)';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (!donationCountsForNet_(d)) { skipped++; return; }
    donGrossTotal += (Number(attrs.amount_cents) || 0) / 100;
    donFeeTotal   += (Number(attrs.fee_cents)    || 0) / 100;  // fee_cents is negative in PCO
  });
  Logger.log('Total donations: ' + donations.length + ' | Status: ' + JSON.stringify(statusCounts));
  Logger.log('Skipped (filtered): ' + skipped);
  Logger.log('Donation-level gross: $' + donGrossTotal.toFixed(2));
  Logger.log('Donation-level fee_cents sum (raw, expected negative): $' + donFeeTotal.toFixed(2));
  Logger.log('Donation-level net (gross + fee): $' + (donGrossTotal + donFeeTotal).toFixed(2));

  // Designation-level totals — use donation→designation traversal (same as sync)
  const fundTotals = {};
  let desGeneral = 0, desBuilding = 0, desOther = 0;
  let matchedDes = 0, currentSyncNet = 0;

  donations.forEach(d => {
    if (!donationCountsForNet_(d)) return;
    const dAttrs = d.attributes || {};
    const refs = (((d.relationships || {}).designations || {}).data) || [];
    const desCount = refs.length || 1;
    refs.forEach(ref => {
      const des = includedById[ref.id];
      if (!des || des.type !== 'Designation') return;
      matchedDes++;
      const grossAmt = (Number((des.attributes || {}).amount_cents) || 0) / 100;
      const fundId = relId_(des, 'fund');
      fundTotals[fundId] = (fundTotals[fundId] || 0) + grossAmt;
      if (fundId === String(DASHBOARD_CONFIG.GENERAL_FUND_ID)) desGeneral += grossAmt;
      else if (fundId === String(DASHBOARD_CONFIG.BUILDING_FUND_ID)) desBuilding += grossAmt;
      else desOther += grossAmt;
      // Simulate what the sync's netDesignationAmount_ does (fee_cents is negative in PCO,
      // so subtracting it ADDS the fee — this is the bug we are diagnosing)
      const rawFeeCents = centsAttr_(dAttrs, ['fee_cents','processing_fee_cents','processing_fees_cents']) || 0;
      const desFee = rawFeeCents / desCount / 100;  // per-designation share (negative)
      currentSyncNet += (grossAmt - desFee);  // current (wrong): subtracting negative = adding
    });
  });

  Logger.log('Matched designations: ' + matchedDes);
  Logger.log('Designation gross — General: $' + desGeneral.toFixed(2) +
             ', Building: $' + desBuilding.toFixed(2) +
             ', Other: $' + desOther.toFixed(2));
  Logger.log('Designation gross — General+Building: $' + (desGeneral + desBuilding).toFixed(2));
  Logger.log('Designation gross — ALL funds: $' + (desGeneral + desBuilding + desOther).toFixed(2));
  Logger.log('Fund ID breakdown: ' + JSON.stringify(fundTotals));
  Logger.log('Current sync net (general+building, wrong fee sign): ~$' + currentSyncNet.toFixed(2) +
             ' (fee subtracted from individual designations, but fee_cents is negative so it actually adds)');
}

function debugGivingMay()   { debugGivingMonth('2026-05-01','2026-05-31'); }
function debugGivingApril() { debugGivingMonth('2026-04-01','2026-04-30'); }
function debugGivingMarch() { debugGivingMonth('2026-03-01','2026-03-31'); }

function donationCountsForNet_(donation) {
  const attrs = (donation && donation.attributes) || {};
  const status = String(attrs.status || attrs.payment_status || attrs.transaction_status || '').toLowerCase();

  // Failed/refunded gifts should not count. Pending (ACH in-flight) ARE included
  // because PCO counts them in their giving totals for the current month.
  if (status.includes('fail')) return false;
  if (status.includes('cancel'))  return false;
  if (status.includes('declin'))  return false;
  if (status === 'refunded')      return false;
  if (status === 'reversed')      return false;

  return true;
}


/* =========================================================
   ATTENDANCE CACHE ROWS
   Working logic preserved:
   - Adults = headcounts included on Sunday Service event_times
   - Kids = direct check-ins attached to those same event_times
   Output rows: [MonthKey, MonthLabel, AdultsAvg, KidsAvg]
========================================================= */

function getAttendanceRowsForMonths_(months) {
  const bucket = {};
  months.forEach(m => {
    bucket[m.key] = { adultTotal: 0, adultDates: {}, kidTotal: 0, kidDates: {} };
  });

  const start = months[0].start;
  const end = months[months.length - 1].end;

  const result = pcoGetAllWithIncluded_(
    '/check-ins/v2/event_times' +
    '?where[starts_at][gte]=' + start +
    '&where[starts_at][lte]=' + end +
    '&include=headcounts' +
    '&per_page=100'
  );

  const allEventTimes = result.data || [];
  const included = result.included || [];

  const startMs = new Date(months[0].start).getTime();
  const endMs   = new Date(months[months.length - 1].end).getTime();

  const eventTimes = allEventTimes.filter(et => {
    if (relId_(et, 'event') !== String(DASHBOARD_CONFIG.CHECKINS_EVENT_ID)) return false;
    const when = et.attributes.starts_at || et.attributes.created_at || et.attributes.shows_at;
    if (!when) return false;
    const t = new Date(when).getTime();
    return t >= startMs && t <= endMs;
  });

  Logger.log('   Sunday Service event times fetched: ' + eventTimes.length + ' of ' + allEventTimes.length + ' total event_times');

  const eventTimeInfo = {};

  eventTimes.forEach(et => {
    const when = et.attributes.starts_at || et.attributes.created_at || et.attributes.shows_at;
    if (!when) return;

    const d = new Date(when);
    const key = monthKey_(d);
    if (!(key in bucket)) return;

    eventTimeInfo[et.id] = {
      monthKey: key,
      dateKey: isoDate_(d)
    };
  });

  let headcountCount = 0;
  included.forEach(inc => {
    if (inc.type !== 'Headcount') return;

    const etId = relId_(inc, 'event_time');
    const info = eventTimeInfo[etId];
    if (!info) return;

    const attrs = inc.attributes || {};
    const total = Number(attrs.total || attrs.count || attrs.quantity || attrs.value || 0);
    if (!total) return;

    bucket[info.monthKey].adultTotal += total;
    bucket[info.monthKey].adultDates[info.dateKey] = true;
    headcountCount++;
  });
  Logger.log('   Adult headcounts counted: ' + headcountCount);

  let kidCheckinsFetched = 0;
  eventTimes.forEach(et => {
    const info = eventTimeInfo[et.id];
    if (!info) return;

    let checkins = [];
    try {
      checkins = pcoGetAll_('/check-ins/v2/event_times/' + et.id + '/check_ins?per_page=100');
    } catch (err) {
      Logger.log('     ! kids check_ins failed for event_time ' + et.id + ': ' + err.message);
      return;
    }

    kidCheckinsFetched += checkins.length;
    bucket[info.monthKey].kidTotal += checkins.length;
    if (checkins.length) bucket[info.monthKey].kidDates[info.dateKey] = true;
  });
  Logger.log('   Kids check-ins counted: ' + kidCheckinsFetched);

  return months.map(m => {
    const adults = avgFromBucket_(bucket[m.key].adultTotal, bucket[m.key].adultDates);
    const kids = avgFromBucket_(bucket[m.key].kidTotal, bucket[m.key].kidDates);
    Logger.log('     ' + m.label + ': adults=' + adults + ', kids=' + kids);
    return [m.key, m.label, adults, kids];
  });
}

function avgFromBucket_(total, datesObj) {
  const dateCount = Object.keys(datesObj || {}).length;
  if (!dateCount) return 0;
  return Math.round(total / dateCount);
}

/* =========================================================
   WEEKLY ATTENDANCE CACHE ROWS
   Stores one row per Sunday per month.
   Output rows: [MonthKey, DateKey, WeekLabel, Adults, Kids]
   e.g. ['2025-01', '2025-01-05', 'Jan 5', 820, 205]
========================================================= */

function getAttendanceWeeklyRowsForMonths_(months) {
  const rows = [];

  const start = months[0].start;
  const end = months[months.length - 1].end;

  const result = pcoGetAllWithIncluded_(
    '/check-ins/v2/event_times' +
    '?where[starts_at][gte]=' + start +
    '&where[starts_at][lte]=' + end +
    '&include=headcounts' +
    '&per_page=100'
  );

  const allEventTimes = result.data || [];
  const included = result.included || [];

  // Only Sunday Service event times
  const startMs = new Date(months[0].start).getTime();
  const endMs   = new Date(months[months.length - 1].end).getTime();

  const eventTimes = allEventTimes.filter(et => {
    if (relId_(et, 'event') !== String(DASHBOARD_CONFIG.CHECKINS_EVENT_ID)) return false;
    const when = et.attributes.starts_at || et.attributes.created_at || et.attributes.shows_at;
    if (!when) return false;
    const t = new Date(when).getTime();
    return t >= startMs && t <= endMs;
  });

  Logger.log('   Weekly attendance: ' + eventTimes.length + ' event_times in window (of ' + allEventTimes.length + ' fetched)');

  // Adults: sum ALL headcounts for each event_time (matches monthly attendance logic).
  // Kids:   direct check-in count per event_time (matches monthly attendance logic).
  // This avoids brittle headcount-name matching that fails for historical data.
  const adultHcByEtId = {};
  const kidCheckinsByEtId = {};

  const headcountNamesFound = {};
  included.forEach(inc => {
    if (inc.type !== 'Headcount') return;
    const etId = relId_(inc, 'event_time');
    if (!etId) return;
    const attrs = inc.attributes || {};
    const name = String(attrs.name || attrs.label || attrs.headcount_type || '').toLowerCase();
    const total = Number(attrs.total || attrs.count || attrs.quantity || attrs.value || 0);

    if (!headcountNamesFound[name]) headcountNamesFound[name] = 0;
    headcountNamesFound[name] += total;

    if (!total) return;
    adultHcByEtId[etId] = (adultHcByEtId[etId] || 0) + total;
  });
  Logger.log('   Headcount names found: ' + JSON.stringify(headcountNamesFound));

  // Fetch kids check-ins per event_time (same API call monthly attendance uses).
  let totalKidCheckins = 0;
  eventTimes.forEach(et => {
    try {
      const checkins = pcoGetAll_('/check-ins/v2/event_times/' + et.id + '/check_ins?per_page=100');
      kidCheckinsByEtId[et.id] = checkins.length;
      totalKidCheckins += checkins.length;
    } catch (err) {
      Logger.log('     ! kids check_ins failed for event_time ' + et.id + ': ' + err.message);
      kidCheckinsByEtId[et.id] = 0;
    }
  });
  Logger.log('   Kids check-ins fetched across all event_times: ' + totalKidCheckins);

  // Aggregate by date — sum all event_times on the same Sunday
  const byDate = {};

  eventTimes.forEach(et => {
    const when = et.attributes.starts_at || et.attributes.created_at || et.attributes.shows_at;
    if (!when) return;

    const d = new Date(when);
    const monthKey = monthKey_(d);
    const dateKey = isoDate_(d);

    if (!byDate[dateKey]) {
      byDate[dateKey] = { monthKey: monthKey, dateKey: dateKey, date: d, adults: 0, kids: 0 };
    }

    byDate[dateKey].adults += adultHcByEtId[et.id]      || 0;
    byDate[dateKey].kids   += kidCheckinsByEtId[et.id]   || 0;
  });

  // Convert to sorted rows — one row per date, skip days with no data
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  Object.keys(byDate).sort().forEach(dateKey => {
    const day = byDate[dateKey];
    if (!day.adults && !day.kids) return; // skip zero rows (non-Sunday event times)
    const d = day.date;
    const weekLabel = monthNames[d.getMonth()] + ' ' + d.getDate();
    // Normalize monthKey to always be YYYY-MM (zero-padded)
    const normalizedMonthKey = day.monthKey.replace(/^(\d{4})-(\d)$/, '$1-0$2');
    rows.push([normalizedMonthKey, dateKey, weekLabel, day.adults, day.kids]);
  });

  Logger.log('   Weekly attendance rows generated: ' + rows.length);
  return rows;
}

function upsertWeeklyAttendanceRows_(sh, rows) {
  if (!rows || !rows.length) return;

  const existing = sh.getDataRange().getValues();
  const rowByDateKey = {};
  for (let i = 1; i < existing.length; i++) {
    const raw = existing[i][1]; // column B = DateKey (Sheets may return a Date object)
    const dateKey = raw instanceof Date ? isoDate_(raw) : String(raw);
    if (dateKey) rowByDateKey[dateKey] = i + 1;
  }

  rows.forEach(row => {
    const dateKey = row[1];
    if (!dateKey) return;
    const rowNum = rowByDateKey[dateKey];
    if (rowNum) {
      sh.getRange(rowNum, 1, 1, 5).setValues([row]);
    } else {
      sh.appendRow(row);
    }
  });

  // Re-sort by dateKey (column B).
  // Sheets may return Date objects for YYYY-MM-DD strings, so normalize to ISO before comparing.
  const allVals = sh.getDataRange().getValues();
  if (allVals.length <= 2) return;
  const headers = allVals[0];
  const dataRows = allVals.slice(1).filter(r => r[1]);
  dataRows.sort((a, b) => {
    const da = a[1] instanceof Date ? isoDate_(a[1]) : String(a[1]);
    const db = b[1] instanceof Date ? isoDate_(b[1]) : String(b[1]);
    return da.localeCompare(db);
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, 5).setValues([headers]);
  if (dataRows.length) sh.getRange(2, 1, dataRows.length, 5).setValues(dataRows);
  sh.setFrozenRows(1);
}

function readWeeklyAttendanceRows_(sh) {
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return sh.getRange(2, 1, lastRow - 1, 5).getValues()
    .filter(r => r[0] && r[1] && (Number(r[3]) || Number(r[4])))
    .map(r => {
      // Sheets auto-converts date-like strings to Date objects — normalize each column back.
      // Column A: MonthKey → YYYY-MM
      r[0] = r[0] instanceof Date
        ? isoDate_(r[0]).slice(0, 7)
        : String(r[0]).replace(/^(\d{4})-(\d)$/, '$1-0$2');
      // Column B: DateKey → YYYY-MM-DD
      r[1] = r[1] instanceof Date ? isoDate_(r[1]) : String(r[1]);
      // Column C: Week label → "Jan 5"
      r[2] = r[2] instanceof Date
        ? monthNames[r[2].getMonth()] + ' ' + r[2].getDate()
        : String(r[2]);
      return r;
    });
}

/* =========================================================
   COMMUNITY GROUP CACHE ROWS
   Output rows: [MonthKey, MonthLabel, Groups, Members]
========================================================= */

function getCommunityGroupRowsForMonths_(months) {
  let groups = pcoGetAll_(
    '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
    '/groups?per_page=100&where[archive_status]=all'
  );

  if (!groups || !groups.length) {
    groups = pcoGetAll_(
      '/groups/v2/group_types/' + DASHBOARD_CONFIG.COMMUNITY_GROUP_TYPE_ID +
      '/groups?per_page=100'
    );
  }

  Logger.log('   Groups fetched: ' + groups.length);

  const membershipsByGroup = {};
  groups.forEach(g => {
    try {
      membershipsByGroup[g.id] = pcoGetAll_(
        '/groups/v2/groups/' + g.id + '/memberships?per_page=100'
      );
    } catch (err) {
      Logger.log('     ! memberships failed for group ' + g.id + ': ' + err.message);
      membershipsByGroup[g.id] = [];
    }
  });

  return months.map(m => {
    const monthStart = new Date(m.start);
    const monthEnd = new Date(m.end);

    const activeGroups = groups.filter(g => isActiveInRange_(g.attributes, monthStart, monthEnd));

    // Use a Set to deduplicate — people in multiple groups are counted only once
    const uniquePersonIds = new Set();
    activeGroups.forEach(g => {
      const mems = membershipsByGroup[g.id] || [];
      mems.forEach(mem => {
        if (isActiveInRange_(mem.attributes, monthStart, monthEnd)) {
          const personId = mem.relationships && mem.relationships.person &&
                           mem.relationships.person.data && mem.relationships.person.data.id;
          if (personId) uniquePersonIds.add(personId);
        }
      });
    });
    const memberCount = uniquePersonIds.size;

    Logger.log('     ' + m.label + ': groups=' + activeGroups.length + ', unique members=' + memberCount);
    return [m.key, m.label, activeGroups.length, memberCount];
  });
}

function isActiveInRange_(attrs, monthStart, monthEnd) {
  attrs = attrs || {};
  const createdStr  = attrs.created_at || attrs.joined_at || attrs.enrollment_open_at;
  const archivedStr = attrs.archived_at || attrs.left_at || attrs.removed_at;

  const created  = createdStr  ? new Date(createdStr)  : null;
  const archived = archivedStr ? new Date(archivedStr) : null;

  if (!created || created > monthEnd) return false;
  if (archived && archived < monthStart) return false;
  return true;
}

/* =========================================================
   MISSIONS — reads the "Missions" tab.
   Column A = name/title, Column B = location, Column C = amount given ($)
   A row with "total" in column A is treated as the grand total.
========================================================= */

function getMissionsData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Try exact name first, then case-insensitive fuzzy match
  let sh = ss.getSheetByName(SHEETS.missions);
  if (!sh) {
    sh = ss.getSheets().find(function(s) {
      return s.getName().toLowerCase().indexOf('mission') >= 0;
    }) || null;
    if (sh) Logger.log('   Missions tab found by fuzzy match: "' + sh.getName() + '"');
  }
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('   Missions tab not found or empty — skipping');
    return null;
  }

  // Sheet layout: Col A = name/description, Col B = monthly amount OR Col C = annual amount.
  // Detect which column holds the primary dollar amount by checking first data row.
  const rows = sh.getDataRange().getValues();
  const missions = [];
  let total = 0;
  let totalFound = false;

  rows.slice(1).forEach(function(r) {
    const name   = String(r[0] || '').trim();
    if (!name) return;

    // Parse amount — strip currency formatting ($, commas, spaces) before converting
    function parseAmt(v) {
      if (typeof v === 'number') return v;
      return Number(String(v || '').replace(/[$,\s]/g, '')) || 0;
    }
    // Amounts are in col D (index 3); fall back to col B/C if D is empty
    const colD = parseAmt(r[3]);
    const colB = parseAmt(r[1]);
    const colC = parseAmt(r[2]);
    const amount = colD > 0 ? colD : (colB > 0 ? colB : colC);

    // "Total" row — only skip if name is literally "total" or "grand total"
    if (name.toLowerCase() === 'total' || name.toLowerCase() === 'grand total') {
      total = amount || total;
      totalFound = true;
      return;
    }

    missions.push({ name: name, amount: amount });
  });

  if (!totalFound) total = missions.reduce(function(s, m) { return s + m.amount; }, 0);

  Logger.log('   Missions: ' + missions.length + ' entries, total $' + Math.round(total).toLocaleString());
  return { items: missions, total: total };
}


/* =========================================================
   SERVE TEAMS
   current  = volunteer count from PCO Services (ServeTeams tab)
   needed   = (form current) + (form additional needed) from Leader Forms tab
========================================================= */

function normTeamName_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getServeTeams_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── PCO volunteer counts from ServeTeams tab ──────────────────────────────
  // Store as normName → { name: originalPCOName, count: number }
  const pcoByNorm = {};
  const serveSh = ss.getSheetByName(SHEETS.servicesTeams);
  if (serveSh && serveSh.getLastRow() >= 2) {
    serveSh.getRange(2, 1, serveSh.getLastRow() - 1, 3).getValues().forEach(function(r) {
      const name = String(r[1] || '').trim();
      const count = Number(r[2]) || 0;
      if (name) pcoByNorm[normTeamName_(name)] = { name: name, count: count };
    });
    Logger.log('   PCO team counts loaded: ' + Object.keys(pcoByNorm).length + ' teams from ServeTeams tab');
  } else {
    Logger.log('   ServeTeams tab empty — current counts will fall back to Leader Forms');
  }

  function lookupPco(teamName) {
    const key = normTeamName_(teamName);
    if (pcoByNorm[key]) return pcoByNorm[key];
    const match = Object.keys(pcoByNorm).find(function(k) {
      return k.length >= 4 && (k.includes(key) || key.includes(k));
    });
    return match ? pcoByNorm[match] : null;
  }

  // ── Needed totals from Leader Forms tab ───────────────────────────────────
  const sh = ss.getSheetByName(SHEETS.teams);
  if (!sh) throw new Error('Could not find tab named "' + SHEETS.teams + '" in this Google Sheet.');

  const rows = sh.getDataRange().getValues();
  const teams = [];

  rows.slice(1).forEach(function(r) {
    const name = String(r[2] || '').trim();
    const formCurrent    = Number(r[4]) || 0;
    const formAddlNeeded = Number(r[5]) || 0;
    const needed         = formCurrent + formAddlNeeded;

    const skip = ['service type', 'services', ''];
    if (!name || skip.indexOf(name.toLowerCase()) >= 0) return;
    if (!formCurrent && !needed) return;

    const normKey = normTeamName_(name);

    // ── Special case: "Worship & Tech" submitted as one leader form ──────────
    // Split into two separate teams using their individual PCO counts.
    if (normKey === 'worship tech' || normKey === 'worship and tech') {
      const worshipPco = Object.values(pcoByNorm).find(function(t) {
        const n = normTeamName_(t.name);
        return n.includes('worship') && !n.includes('tech');
      });
      const techPco = Object.values(pcoByNorm).find(function(t) {
        const n = normTeamName_(t.name);
        return (n.includes('tech') || n.includes('production')) && !n.includes('worship');
      });

      const halfNeeded = Math.round(needed / 2);
      teams.push({
        name:    worshipPco ? worshipPco.name : 'Worship Team',
        current: worshipPco ? worshipPco.count : Math.round(formCurrent / 2),
        needed:  halfNeeded
      });
      teams.push({
        name:    techPco ? techPco.name : 'Tech Team',
        current: techPco ? techPco.count : Math.floor(formCurrent / 2),
        needed:  needed - halfNeeded
      });
      return;
    }

    const pco     = lookupPco(name);
    const current = pco ? pco.count : formCurrent;
    teams.push({ name: name, current: current, needed: needed });
  });

  Logger.log('   Teams loaded: ' + teams.length + ' (current from PCO, needed from Leader Forms)');
  return teams;
}


/* =========================================================
   BUDGET — reads the "Budget" tab and aggregates into 5 pie-chart categories.
   Column A = line item, Column B = annual $, Column C = % of income
========================================================= */

function getBudgetData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.budget);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('   Budget tab not found or empty — skipping');
    return null;
  }

  const BUCKETS = [
    { label: 'Network & Missions', color: '#4a9ede',
      keywords: ['network', 'church planting', 'mission'] },
    { label: 'Ministry',  color: '#2fb774', keywords: ['ministry'] },
    { label: 'Operations', color: '#c9a227', keywords: ['operation'] },
    { label: 'Staffing',  color: '#e05a5a', keywords: ['staff'] },
    { label: 'Facilities', color: '#9b59b6', keywords: ['facilit'] }
  ];

  const totals = BUCKETS.map(function(b) {
    return { label: b.label, color: b.color, pct: 0, amount: 0 };
  });

  const rows = sh.getDataRange().getValues();
  const unmatched = [];

  rows.slice(1).forEach(function(r) {
    const lineItem = String(r[0] || '').trim();
    if (!lineItem) return;

    // Column B: annual dollar amount — use this as the source of truth for proportions.
    // Column C (% of income) is skipped because sheets with sub-rows would double-count
    // if both a category header and its sub-line items all match the same keyword.
    const amount = Number(r[1]) || 0;
    if (!amount) return;

    const itemLower = lineItem.toLowerCase();
    let matched = false;
    for (var i = 0; i < BUCKETS.length; i++) {
      if (BUCKETS[i].keywords.some(function(kw) { return itemLower.indexOf(kw) >= 0; })) {
        totals[i].amount += amount;
        matched = true;
        break;
      }
    }
    if (!matched) unmatched.push(lineItem + ' ($' + Math.round(amount).toLocaleString() + ')');
  });

  if (unmatched.length) {
    Logger.log('   Budget rows not matched to a category: ' + unmatched.join(', '));
  }

  // Calculate each category's % from the dollar totals so slices always sum to 100%
  const grandTotal = totals.reduce(function(s, t) { return s + t.amount; }, 0);
  totals.forEach(function(t) {
    t.pct = grandTotal > 0 ? Math.round((t.amount / grandTotal) * 1000) / 10 : 0;
  });

  const result = totals.filter(function(t) { return t.amount > 0; });
  Logger.log('   Budget: ' + result.length + ' categories, total $' + Math.round(grandTotal).toLocaleString());
  return result;
}


/* =========================================================
   SERVICES TEAMS → ServeTeams TAB
   Pulls all Planning Center Services teams and counts people on each team.
   Public function: refreshServicesTeams()
========================================================= */

function syncServicesTeamsData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEETS.servicesTeams, ['Team ID', 'Team Name', 'Volunteer Count', 'Source', 'Last Updated']);

  const teams = pcoGetAll_('/services/v2/teams?per_page=100');
  Logger.log('   Services teams fetched: ' + teams.length);

  const rows = [];
  const updatedAt = new Date().toISOString();

  teams.forEach(team => {
    const teamId = String(team.id);
    const teamName = String((team.attributes && team.attributes.name) || '').trim();
    if (!teamName) return;

    const result = countServicesTeamVolunteers_(teamId);
    rows.push([
      teamId,
      teamName,
      result.count,
      result.source,
      updatedAt
    ]);

    Logger.log('     ' + teamName + ': ' + result.count + ' volunteers (' + result.source + ')');
  });

  rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])));

  sh.clearContents();
  sh.getRange(1, 1, 1, 5).setValues([['Team ID', 'Team Name', 'Volunteer Count', 'Source', 'Last Updated']]);
  if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
  sh.setFrozenRows(1);

  Logger.log('ServeTeams tab updated with ' + rows.length + ' Services teams.');
}

function countServicesTeamVolunteers_(teamId) {
  // Planning Center Services accounts/API versions vary slightly, so this tries
  // the likely team membership endpoints and uses the first one that works.
  const candidates = [
    { source: 'teams/{id}/people', path: '/services/v2/teams/' + teamId + '/people?per_page=100' },
    { source: 'teams/{id}/team_members', path: '/services/v2/teams/' + teamId + '/team_members?per_page=100' },
    { source: 'teams/{id}/members', path: '/services/v2/teams/' + teamId + '/members?per_page=100' },
    { source: 'teams/{id}/people with inactive=false', path: '/services/v2/teams/' + teamId + '/people?where[inactive]=false&per_page=100' }
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const data = pcoTryGetAll_(c.path);
    if (data === null) continue;

    const uniqueIds = {};
    data.forEach(item => {
      // If the endpoint returns People, item.id is fine.
      // If it returns TeamMember records, try person relationship first.
      const personId = relId_(item, 'person') || relId_(item, 'people') || String(item.id || '');
      if (personId) uniqueIds[personId] = true;
    });

    return {
      count: Object.keys(uniqueIds).length,
      source: c.source
    };
  }

  Logger.log('     ! Could not count volunteers for Services team id=' + teamId + '. All candidate endpoints failed.');
  return {
    count: 0,
    source: 'not found'
  };
}

function pcoTryGetAll_(path) {
  try {
    return pcoGetAll_(path);
  } catch (err) {
    const msg = String(err.message || '');
    // Expected while probing endpoint names.
    if (msg.indexOf('404') !== -1 || msg.indexOf('403') !== -1) {
      return null;
    }
    throw err;
  }
}

/* =========================================================
   TEAMS DETAIL — Volunteers + Plans from PCO Services
   Aggregates volunteer response stats and service plan history
   across all service types for the last 90 days.
   Writes to Volunteers and Plans tabs in this Google Sheet.
   Public helper: refreshTeamsDetail()
========================================================= */

function syncTeamsDetailData_() {
  const LOOKBACK_DAYS = 90;
  const MAX_PLANS_PER_TYPE = 20;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  const updatedAt = new Date().toISOString();

  const serviceTypes = pcoTryGetAll_('/services/v2/service_types?per_page=100') || [];
  Logger.log('   Service types found: ' + serviceTypes.length);

  const planRows = [];     // for Plans tab
  const personMap = {};    // personId -> { name, teams, confirmed, declined, pending }

  serviceTypes.forEach(function(st) {
    const typeId = String(st.id);
    const typeName = String((st.attributes && st.attributes.name) || 'Unknown').trim();

    const plans = pcoTryGetAll_(
      '/services/v2/service_types/' + typeId +
      '/plans?filter=past&per_page=' + MAX_PLANS_PER_TYPE + '&order=-sort_date'
    ) || [];

    plans.forEach(function(plan) {
      const sortDate = String((plan.attributes && plan.attributes.sort_date) || '');
      if (!sortDate) return;
      if (new Date(sortDate) < cutoff) return;

      const planId = String(plan.id);
      const members = pcoTryGetAll_(
        '/services/v2/service_types/' + typeId +
        '/plans/' + planId +
        '/team_members?per_page=100'
      ) || [];

      if (!members.length) return;

      var scheduled = 0, confirmed = 0, declined = 0, pending = 0;

      members.forEach(function(tm) {
        const attrs = tm.attributes || {};
        // PCO status codes: 'C' = confirmed, 'D' = declined, 'U' = unconfirmed (pending)
        // Some endpoints use full words; handle both
        const rawStatus = String(attrs.status || '').toLowerCase();
        const isConfirmed = rawStatus === 'c' || rawStatus === 'confirmed';
        const isDeclined  = rawStatus === 'd' || rawStatus === 'declined';
        const name = String(attrs.name || '').trim();
        const personId = relId_(tm, 'person') || String(attrs.person_id || tm.id || '');

        scheduled++;
        if (isConfirmed)      confirmed++;
        else if (isDeclined)  declined++;
        else                  pending++;

        if (name && personId) {
          if (!personMap[personId]) {
            personMap[personId] = { name: name, teams: {}, confirmed: 0, declined: 0, pending: 0 };
          } else if (!personMap[personId].name && name) {
            personMap[personId].name = name;
          }
          // Use service type name as team (PCO team_members API doesn't expose team_name as attribute)
          if (typeName) personMap[personId].teams[typeName] = true;
          if (isConfirmed)      personMap[personId].confirmed++;
          else if (isDeclined)  personMap[personId].declined++;
          else                  personMap[personId].pending++;
        }
      });

      // sort_date may be a full ISO string (e.g. "2026-05-24T08:00:00Z") — extract date portion only
      const datePart = sortDate.substring(0, 10);  // 'YYYY-MM-DD'
      const dateObjForDs = new Date(datePart + 'T12:00:00');
      const ds = dateObjForDs.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      // Store plain ISO date string (not full timestamp) to avoid Sheets auto-parsing into Date objects
      planRows.push([datePart, ds, typeName, scheduled, confirmed, declined, pending, updatedAt]);
    });
  });

  // Newest plans first
  planRows.sort(function(a, b) { return String(b[0]).localeCompare(String(a[0])); });

  // Write Plans tab
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const planHeaders = ['Sort Date', 'Service Date', 'Service Type', 'Scheduled', 'Confirmed', 'Declined', 'Pending', 'Last Updated'];
  const planSh = ensureSheet_(ss, SHEETS.plans, planHeaders);
  planSh.clearContents();
  planSh.getRange(1, 1, 1, planHeaders.length).setValues([planHeaders]);
  if (planRows.length) planSh.getRange(2, 1, planRows.length, planHeaders.length).setValues(planRows);
  planSh.setFrozenRows(1);

  // Build volunteer rows
  const volRows = Object.values(personMap)
    .filter(function(p) { return p.name; })
    .map(function(p) {
      const total = p.confirmed + p.declined;
      const reliability = total > 0 ? Math.round((p.confirmed / total) * 100) : 0;
      const primaryTeam = Object.keys(p.teams)[0] || '—';
      return [p.name, primaryTeam, p.confirmed, p.declined, p.pending, reliability, updatedAt];
    });
  volRows.sort(function(a, b) { return String(a[0]).localeCompare(String(b[0])); });

  // Write Volunteers tab
  const volHeaders = ['Volunteer', 'Primary Team', 'Confirmed', 'Declined', 'Pending', 'Reliability', 'Last Updated'];
  const volSh = ensureSheet_(ss, SHEETS.volunteers, volHeaders);
  volSh.clearContents();
  volSh.getRange(1, 1, 1, volHeaders.length).setValues([volHeaders]);
  if (volRows.length) volSh.getRange(2, 1, volRows.length, volHeaders.length).setValues(volRows);
  volSh.setFrozenRows(1);

  Logger.log('   Plans tab: ' + planRows.length + ' plans | Volunteers tab: ' + volRows.length + ' people');
}

function refreshTeamsDetail() {
  // Manual helper: run this to refresh Volunteers and Plans tabs only.
  syncTeamsDetailData_();
}

/* =========================================================
   SUNDAY PLANS — Upcoming service plan details from PCO Services
   Fetches team members (volunteers, captains, preacher) and
   order-of-service items for future Worship Gathering plans.
   Writes to SundayPlans sheet; read back by getSundayPlans_().
   Public helper: refreshSundayPlans()
========================================================= */

function syncSundayPlansData_() {
  const MAX_FUTURE_PLANS = 25; // ~5 months of Sundays per service type

  // ── Find all service types. Treat ANY service type as a candidate so we
  //    don't hard-code naming. We'll group plans by Sunday date and label
  //    them by their service type name. Filter includes ANY type that has
  //    future plans (worship gatherings, liturgy services, etc.).
  const allServiceTypes = pcoTryGetAll_('/services/v2/service_types?per_page=100') || [];
  Logger.log('   All service types: ' + allServiceTypes.map(function(t){
    return '"' + (t.attributes && t.attributes.name) + '"';
  }).join(', '));

  // Prefer types whose names include "worship" or "gathering" or "service"
  // — fall back to ALL types if nothing matches so the function isn't silent.
  var worshipTypes = allServiceTypes.filter(function(st) {
    var n = String((st.attributes && st.attributes.name) || '').toLowerCase();
    return n.includes('worship') || n.includes('gathering') || n.includes('service');
  });
  if (!worshipTypes.length) worshipTypes = allServiceTypes;

  if (!worshipTypes.length) {
    Logger.log('   syncSundayPlansData_: no service types found in PCO');
    return;
  }
  Logger.log('   Sunday plan types (' + worshipTypes.length + '): ' +
    worshipTypes.map(function(t){ return t.attributes.name; }).join(', '));

  const plansByDate = {}; // dateKey -> [serviceObj, ...]
  var orderItemsFetched = false; // fetch items only once per Sunday across all service types

  worshipTypes.forEach(function(st) {
    var typeId   = String(st.id);
    var typeName = String((st.attributes && st.attributes.name) || '').trim();

    var plans = pcoTryGetAll_(
      '/services/v2/service_types/' + typeId +
      '/plans?filter=future&per_page=' + MAX_FUTURE_PLANS + '&order=sort_date'
    ) || [];

    plans.forEach(function(plan) {
      var sortDate = String((plan.attributes && plan.attributes.sort_date) || '');
      if (!sortDate) return;
      var datePart = sortDate.substring(0, 10);

      // Only include Sunday plans (day 0) to stay focused
      var dow = new Date(datePart + 'T12:00:00').getDay();
      if (dow !== 0) return; // skip non-Sundays

      var planId   = String(plan.id);
      var planAttr = plan.attributes || {};

      // ── Team members: include=team,plan_times to resolve team names + service times
      // PCO v2 uses "plan_times" (not "times") as the relationship key for TeamMember
      var tmResult = { data: [], included: [] };
      try {
        tmResult = pcoGetAllWithIncluded_(
          '/services/v2/service_types/' + typeId +
          '/plans/' + planId +
          '/team_members?per_page=100&include=team,plan_times'
        );
      } catch(e) {
        Logger.log('     team_members error for plan ' + planId + ': ' + e.message);
      }

      // DEBUG: log included types and first team member structure to diagnose service time data
      var _incTypes = (tmResult.included || []).map(function(i) { return i.type; });
      Logger.log('     [DEBUG] included types: ' + JSON.stringify([...new Set(_incTypes)]));
      if (tmResult.data && tmResult.data.length > 0) {
        var _first = tmResult.data[0];
        Logger.log('     [DEBUG] first TM attr keys: ' + JSON.stringify(Object.keys(_first.attributes || {})));
        Logger.log('     [DEBUG] first TM rel keys: ' + JSON.stringify(Object.keys(_first.relationships || {})));
        Logger.log('     [DEBUG] first TM sample: ' + JSON.stringify(_first).substring(0, 600));
      }

      // Build team id -> name and plan_time id -> display label lookups from included
      var includedTeams = {};
      var includedTimes = {};
      (tmResult.included || []).forEach(function(inc) {
        if (inc.type === 'Team') {
          includedTeams[String(inc.id)] = String((inc.attributes && inc.attributes.name) || '').trim();
        } else if (inc.type === 'PlanTime' || inc.type === 'ServiceTime' || inc.type === 'Time') {
          // PCO may return service times with different type names depending on API version
          var ta = inc.attributes || {};
          var timeName = String(ta.name || ta.time_name || ta.starts_at_time_of_day || '').trim();
          if (!timeName && ta.starts_at) {
            var d = new Date(ta.starts_at);
            var hh = d.getHours(), mm = d.getMinutes();
            var ap = hh >= 12 ? 'PM' : 'AM';
            var h12 = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
            timeName = h12 + (mm > 0 ? ':' + String(mm).padStart(2,'0') : '') + ' ' + ap;
          }
          includedTimes[String(inc.id)] = timeName;
        }
      });

      // FALLBACK: if no plan times came through the include, fetch plan_times directly
      // and build a teamMemberId -> serviceTime map by fetching per-time team members
      var memberTimeMap = {};
      if (Object.keys(includedTimes).length === 0) {
        try {
          var ptResult = pcoGetAllWithIncluded_(
            '/services/v2/service_types/' + typeId +
            '/plans/' + planId +
            '/plan_times?per_page=100'
          );
          (ptResult.data || []).forEach(function(pt) {
            var pa = pt.attributes || {};
            var tname = String(pa.name || pa.time_name || pa.starts_at_time_of_day || '').trim();
            if (!tname && pa.starts_at) {
              var d = new Date(pa.starts_at);
              var hh = d.getHours(), mm = d.getMinutes();
              var ap = hh >= 12 ? 'PM' : 'AM';
              var h12 = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
              tname = h12 + (mm > 0 ? ':' + String(mm).padStart(2,'0') : '') + ' ' + ap;
            }
            if (!tname) return;
            // Try to get team members for this specific plan time
            try {
              var ptMems = pcoGetAllWithIncluded_(
                '/services/v2/service_types/' + typeId +
                '/plans/' + planId +
                '/plan_times/' + String(pt.id) +
                '/team_members?per_page=100'
              );
              (ptMems.data || []).forEach(function(ptm) {
                memberTimeMap[String(ptm.id)] = tname;
              });
              Logger.log('     [DEBUG] plan_time "' + tname + '" (' + pt.id + '): ' + (ptMems.data || []).length + ' members');
            } catch(e2) {
              Logger.log('     [DEBUG] plan_time team_members not available: ' + e2.message);
            }
          });
        } catch(e) {
          Logger.log('     plan_times fallback error: ' + e.message);
        }
      }

      // Preacher from plan-level attribute (set directly in PCO plan editor)
      var preacher    = String(planAttr.preacher || '').trim();
      var sermonTitle = String(planAttr.title || '').trim();
      var seriesTitle = String(planAttr.series_title || '').trim();
      var captains    = [];
      var volunteers  = [];

      (tmResult.data || []).forEach(function(tm) {
        var a    = tm.attributes || {};
        var name = String(a.name || '').trim();
        if (!name) return;

        var rawSt  = String(a.status || '').toLowerCase();
        var status = rawSt === 'confirmed' || rawSt === 'c' ? 'C'
                   : rawSt === 'declined'  || rawSt === 'd' ? 'D' : 'U';

        // Resolve team name: attribute first (works in newer PCO), then included lookup
        var teamAttr = String(a.team_name || '').trim();
        var teamId   = tm.relationships && tm.relationships.team &&
                       tm.relationships.team.data && String(tm.relationships.team.data.id || '');
        var teamName = teamAttr || (teamId ? (includedTeams[teamId] || '') : '');

        // Resolve position: PCO uses team_position_name (v2 API), fall back to older names
        var pos = String(a.team_position_name || a.position_display_name || a.position || a.notes || '').trim();

        var tl = teamName.toLowerCase();
        var pl = pos.toLowerCase();
        var nl = name.toLowerCase();

        // Preacher detection: team named "preach", "message", "sermon", "teaching"
        var isPreach = tl.includes('preach') || tl.includes('message') ||
                       tl.includes('sermon') || tl.includes('teaching') ||
                       pl.includes('preach') || pl.includes('message') ||
                       pl.includes('sermon');

        // Captain detection: role named "captain", "host", "service leader"
        var isCaptain = tl.includes('captain') || tl.includes('host') ||
                        pl.includes('captain') || pl.includes('service lead') ||
                        pl.includes('host');

        if (isPreach && !preacher) {
          preacher = name;
        } else if (isCaptain && status !== 'D') {
          if (!captains.some(function(c) { return (c.name || c) === name; })) {
            captains.push(name); // kept as string for backwards compat; serviceTime in volunteers array
          }
        }

        // Resolve assigned service time(s):
        // 1. via relationships.plan_times (PCO v2 correct key)
        // 2. via relationships.times (legacy / alternate key)
        // 3. via memberTimeMap built from per-plan-time team member fetch
        // 4. via direct attributes
        // 5. via position name if it looks like a time
        var timeIds = [];
        var relPT = (tm.relationships && tm.relationships.plan_times && tm.relationships.plan_times.data)
                    ? tm.relationships.plan_times.data
                    : null;
        var relT  = (tm.relationships && tm.relationships.times && tm.relationships.times.data)
                    ? tm.relationships.times.data
                    : null;
        if (relPT) {
          timeIds = [].concat(relPT).map(function(t) { return String(t.id || ''); });
        } else if (relT) {
          timeIds = [].concat(relT).map(function(t) { return String(t.id || ''); });
        }
        var serviceTime = timeIds.map(function(id) { return includedTimes[id] || ''; }).filter(Boolean).join(', ')
                       || memberTimeMap[String(tm.id)]
                       || String(a.service_time_name || a.scheduled_time || '').trim();
        // If still empty, check whether the position name looks like a service time
        // (some churches encode shift times as team positions, e.g. "8 AM", "9:30 AM", "10am-1pm")
        if (!serviceTime && pos && /\d/.test(pos) && /am|pm|:\d{2}/i.test(pos)) {
          serviceTime = pos;
        }

        if (status !== 'D') {
          volunteers.push({ name: name, team: teamName, pos: pos, status: status, serviceTime: serviceTime });
        }
      });

      // ── Order-of-service items ─────────────────────────────────────────────
      // Fetch items only once per Sunday (first service type encountered).
      // PCO item `length` is in SECONDS — divide by 60 to get minutes.
      var orderItems = [];
      if (!plansByDate[datePart]) { // first service type for this date → fetch items
        var items = pcoTryGetAll_(
          '/services/v2/service_types/' + typeId +
          '/plans/' + planId +
          '/items?per_page=100'
        ) || [];

        orderItems = items
          .filter(function(i) { return i.attributes && i.attributes.title; })
          .sort(function(a, b) { return (a.attributes.sequence || 0) - (b.attributes.sequence || 0); })
          .map(function(i) {
            var ia     = i.attributes || {};
            var lenSec = Number(ia.length) || 0; // PCO sends seconds
            return {
              seq:         Number(ia.sequence) || 0,
              title:       String(ia.title || '').trim(),
              type:        String(ia.item_type || 'item'),
              lengthMin:   lenSec > 0 ? Math.round(lenSec / 60) : 0,
              description: String(ia.description || '').trim()
            };
          })
          .filter(function(i) { return i.title; });

        Logger.log('     [' + datePart + '] ' + typeName +
          ': ' + (tmResult.data || []).length + ' team members, ' +
          orderItems.length + ' order items, preacher="' + preacher + '"');
      }

      // Temporary debug info — remove after service time issue is resolved
      var _firstRelKeys = tmResult.data && tmResult.data[0]
        ? Object.keys(tmResult.data[0].relationships || {}).join(',') : '';
      var _incTypesUniq = [...new Set((tmResult.included||[]).map(function(i){return i.type;}))].join(',');
      var _volsWithTime = volunteers.filter(function(v){return v.serviceTime;}).length;
      var _memberTimeMapSize = Object.keys(memberTimeMap).length;
      var _debugInfo = {
        incTypes: _incTypesUniq,
        firstRelKeys: _firstRelKeys,
        includedTimesCount: Object.keys(includedTimes).length,
        memberTimeMapCount: _memberTimeMapSize,
        volsWithServiceTime: _volsWithTime,
        totalVols: volunteers.length
      };

      if (!plansByDate[datePart]) plansByDate[datePart] = [];
      plansByDate[datePart].push({
        serviceType: typeName,
        planId:      planId,
        title:       sermonTitle,
        series:      seriesTitle,
        preacher:    preacher,
        captains:    captains,
        volunteers:  volunteers,
        orderItems:  orderItems,
        _debug:      _debugInfo
      });
    });
  });

  // ── Sort services within each date by time (8am → 9:30am → 11am) ──────────
  function svcOrder(name) {
    var n = (name || '').toLowerCase();
    if (n.includes('8am') || n.includes('8 am') || n.includes('8:00')) return 0;
    if (n.includes('9:30') || n.includes('9am') || n.includes('9 am')) return 1;
    if (n.includes('11am') || n.includes('11 am') || n.includes('11:00')) return 2;
    return 3;
  }

  // For each Sunday, promote orderItems from first service to any that have none
  // (so only one service fetches items but all services in the UI can reference them)
  var result = Object.keys(plansByDate).sort().map(function(date) {
    var svcs = plansByDate[date];
    svcs.sort(function(a, b) { return svcOrder(a.serviceType) - svcOrder(b.serviceType); });
    // Ensure at least one service has order items
    var masterItems = svcs.reduce(function(acc, s) { return acc.length ? acc : s.orderItems; }, []);
    svcs.forEach(function(s) { if (!s.orderItems.length) s.orderItems = masterItems; });
    var d = new Date(date + 'T12:00:00');
    return {
      date:     date,
      ds:       d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      services: svcs
    };
  });

  Logger.log('   SundayPlans: ' + result.length + ' upcoming Sundays');

  // ── Write to SundayPlans sheet ─────────────────────────────────────────────
  // Only overwrite the sheet when PCO returned real data — this prevents
  // a race-condition/API-hiccup from clearing previously-good cached plans.
  if (!result.length) {
    Logger.log('⚠  SundayPlans: PCO returned 0 Sundays — keeping existing sheet data');
    return;
  }
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sh  = ensureSheet_(ss, 'SundayPlans', ['Date', 'Display String', 'Service Count', 'JSON']);
  sh.clearContents();
  sh.getRange(1, 1, 1, 4).setValues([['Date', 'Display String', 'Service Count', 'JSON']]);
  var rows = result.map(function(p) {
    return [p.date, p.ds, p.services.length, JSON.stringify(p)];
  });
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
  sh.setFrozenRows(1);
  Logger.log('✓  SundayPlans sheet updated (' + result.length + ' rows)');
}

function getSundayPlans_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('SundayPlans');
  if (!sh || sh.getLastRow() < 2) return [];
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  return rows.map(function(r) {
    try { return JSON.parse(String(r[3])); } catch(e) { return null; }
  }).filter(Boolean);
}

function refreshSundayPlans() {
  syncSundayPlansData_();
}

/* =========================================================
   BAPTISMS SYNC
   - 2021–2025: hardcoded historical counts (verified manually)
   - 2026+: pulled live from PCO using the "Baptism Ready" workflow
     completion dates. Falls back to baptized_at People field if
     no baptism workflow is found in PCO.
========================================================= */
function syncBaptisms_() {
  Logger.log('▶  Baptisms — starting');

  // ── Historical yearly totals (pre-PCO tracking) ──────────────────────────
  // Stored as the January month-key of each year so yearly aggregation works.
  const HISTORICAL = {
    '2021': 30,
    '2022': 51,
    '2023': 74,
    '2024': 53,
    '2025': 75
  };

  const byMonth = {};
  Object.keys(HISTORICAL).forEach(function(year) {
    byMonth[year + '-01'] = HISTORICAL[year];
  });

  // ── PCO live data for 2026+ ──────────────────────────────────────────────
  const PCO_START = '2026-01-01';
  let pcoCount = 0;

  // First: try to find a workflow whose name contains "bapti" (case-insensitive)
  let workflowId = null;
  try {
    const workflows = pcoGetAll_('/people/v2/workflows?per_page=100') || [];
    const bwf = workflows.find(function(w) {
      return ((w.attributes && w.attributes.name) || '').toLowerCase().includes('bapti');
    });
    if (bwf) {
      workflowId = bwf.id;
      Logger.log('   Found baptism workflow: "' + bwf.attributes.name + '" (id=' + workflowId + ')');
    }
  } catch(e) {
    Logger.log('   Warning: could not fetch workflows — ' + e.message);
  }

  if (workflowId) {
    // Use the completed workflow card dates (= baptism event date)
    const cards = pcoGetAll_(
      '/people/v2/workflows/' + workflowId + '/cards?filter=completed&per_page=100'
    ) || [];

    cards.forEach(function(card) {
      const completedAt = (card.attributes && card.attributes.completed_at) || null;
      if (!completedAt || completedAt < PCO_START) return;
      const monthKey = completedAt.substring(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
      byMonth[monthKey] = (byMonth[monthKey] || 0) + 1;
      pcoCount++;
    });

    Logger.log('   Workflow cards completed since 2026: ' + pcoCount);

  } else {
    // Fallback: use baptized_at field on Person for 2026+
    Logger.log('   No baptism workflow found — falling back to baptized_at People field');
    const people = pcoGetAll_(
      '/people/v2/people?where[baptized_at][gte]=' + PCO_START +
      '&fields[Person]=baptized_at&per_page=100'
    ) || [];

    people.forEach(function(person) {
      const baptizedAt = (person.attributes && person.attributes.baptized_at) || null;
      if (!baptizedAt) return;
      const monthKey = String(baptizedAt).substring(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
      byMonth[monthKey] = (byMonth[monthKey] || 0) + 1;
      pcoCount++;
    });

    Logger.log('   PCO people with baptized_at >= 2026: ' + pcoCount);
  }

  // ── Write to Baptisms sheet ───────────────────────────────────────────────
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = ['Month Key', 'Month Label', 'Count', 'Last Updated'];
  const sh = ensureSheet_(ss, SHEETS.baptisms, headers);
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);

  const updatedAt = new Date().toISOString();
  const rows = Object.keys(byMonth).sort().map(function(k) {
    return [k, monthLabelFromKey_(k), byMonth[k], updatedAt];
  });

  if (rows.length) {
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sh.setFrozenRows(1);

  const histTotal = Object.values(HISTORICAL).reduce(function(s, v) { return s + v; }, 0);
  const grandTotal = histTotal + pcoCount;
  Logger.log('✓  Baptisms — done (' + grandTotal + ' total: ' + histTotal + ' historical + ' + pcoCount + ' PCO 2026+)');
}

/* =========================================================
   MEMBERS GROWTH
   Tracks how many people became church members per year.
   Priority:
     1. "Member Since" custom field on Person (most accurate)
     2. Membership workflow completion dates
     3. created_at fallback (least accurate)
========================================================= */
function syncMembersOverTime_() {
  Logger.log('▶  Members Growth — starting');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = ['Year', 'New Members', 'Total Current', 'Last Updated'];
  const sh = ensureSheet_(ss, SHEETS.members, headers);

  const byYear = {};

  // ── 1. Get current "All Family Members" list ──────────────────────────────
  // Includes Member, Pastor, Deacon, Elder, etc.
  let totalCurrent = 0;
  const currentMemberIds = new Set();
  try {
    const lists = pcoGetAll_('/people/v2/lists?per_page=100') || [];
    const allFamilyList = lists.find(function(l) {
      const n = ((l.attributes && l.attributes.name) || '').toLowerCase();
      return n.includes('all family') || n.includes('family member');
    });
    if (allFamilyList) {
      const members = pcoGetAll_('/people/v2/lists/' + allFamilyList.id + '/people?fields[Person]=id&per_page=100') || [];
      members.forEach(function(p) { currentMemberIds.add(p.id); });
      totalCurrent = currentMemberIds.size;
      Logger.log('   "All Family Members" list: ' + totalCurrent + ' people');
    } else {
      Logger.log('   No "All Family Members" list found — using membership=Member');
      const members = pcoGetAll_('/people/v2/people?where[membership]=Member&fields[Person]=id&per_page=100') || [];
      members.forEach(function(p) { currentMemberIds.add(p.id); });
      totalCurrent = currentMemberIds.size;
    }
  } catch(e) {
    Logger.log('   Warning: could not fetch current members — ' + e.message);
  }

  // ── 2. Find membership start date and end date custom fields ─────────────
  try {
    const fieldDefs = pcoGetAll_('/people/v2/field_definitions?per_page=100') || [];
    Logger.log('   Field definitions (' + fieldDefs.length + '):');
    fieldDefs.forEach(function(d) {
      Logger.log('     "' + (d.attributes && d.attributes.name) + '" id=' + d.id);
    });

    // Match: "Membership Start Date", "Member Since", "Member Start", etc.
    const startDef = fieldDefs.find(function(d) {
      const n = ((d.attributes && d.attributes.name) || '').toLowerCase();
      return n.includes('member') && (n.includes('start') || n.includes('since') || n.includes('join') || n.includes('date'));
    });

    // Match: "Membership End Date", "Member End", "Left as Member", etc.
    const endDef = fieldDefs.find(function(d) {
      const n = ((d.attributes && d.attributes.name) || '').toLowerCase();
      return n.includes('member') && (n.includes('end') || n.includes('left') || n.includes('remov') || n.includes('exit'));
    });

    Logger.log('   Start date field: ' + (startDef ? '"' + startDef.attributes.name + '" id=' + startDef.id : 'not found'));
    Logger.log('   End date field:   ' + (endDef   ? '"' + endDef.attributes.name   + '" id=' + endDef.id   : 'not found'));

    if (startDef) {
      // Build set of person IDs who have a non-empty membership end date.
      // Wrapped in its own try/catch — PCO returns 404 when no one has an end date set,
      // which should be treated as "no ended members" rather than a failure.
      const endedIds = new Set();
      if (endDef) {
        try {
          const endData = pcoGetAll_(
            '/people/v2/field_data?where[field_definition_id]=' + endDef.id + '&per_page=100'
          ) || [];
          endData.forEach(function(fd) {
            const val = String((fd.attributes && fd.attributes.value) || '').trim();
            if (!val) return; // empty end date = still a member
            const pid = fd.relationships && fd.relationships.customizable &&
                        fd.relationships.customizable.data && fd.relationships.customizable.data.id;
            if (pid) endedIds.add(pid);
          });
          Logger.log('   People with a membership end date: ' + endedIds.size);
        } catch(endErr) {
          Logger.log('   End date field returned no data (likely no one has an end date yet) — skipping end date filter');
        }
      }

      // Get all start date records.
      // Use the top-level /field_data endpoint with a filter — the scoped
      // /field_definitions/{id}/field_data endpoint returns 404 for some PCO field types.
      const startData = pcoGetAll_(
        '/people/v2/field_data?where[field_definition_id]=' + startDef.id + '&per_page=100'
      ) || [];
      Logger.log('   Start date records found: ' + startData.length);

      let counted = 0, skippedNotMember = 0, skippedEnded = 0;
      startData.forEach(function(fd) {
        const val = String((fd.attributes && fd.attributes.value) || '').trim();
        if (!val) return;

        const pid = fd.relationships && fd.relationships.customizable &&
                    fd.relationships.customizable.data && fd.relationships.customizable.data.id;
        if (!pid) return;

        // Only count people who are currently active members
        if (currentMemberIds.size > 0 && !currentMemberIds.has(pid)) {
          skippedNotMember++;
          return;
        }

        // Skip if they have a membership end date
        if (endedIds.has(pid)) {
          skippedEnded++;
          return;
        }

        // Handle multiple date formats: YYYY-MM-DD, MM/DD/YYYY, M/D/YYYY, etc.
        // Extract any 4-digit year (2000-2099) from the string.
        const yearMatch = val.match(/\b(20\d{2})\b/);
        if (!yearMatch) return;
        const year = yearMatch[1];
        byYear[year] = (byYear[year] || 0) + 1;
        counted++;
      });

      Logger.log('   Counted: ' + counted + ' | Skipped (not current member): ' + skippedNotMember + ' | Skipped (ended): ' + skippedEnded);
    } else {
      Logger.log('   ⚠ No membership start date field found. Chart will be empty. Check field names above.');
    }
  } catch(e) {
    Logger.log('   Warning: field lookup failed — ' + e.message);
  }

  // ── 5. Write to sheet ─────────────────────────────────────────────────────
  sh.clearContents();
  sh.getRange(1, 1, 1, 4).setValues([headers]);

  const updatedAt = new Date().toISOString();
  const years = Object.keys(byYear).sort();
  if (years.length) {
    const lastYear = years[years.length - 1];
    const rows = years.map(function(y) {
      return [y, byYear[y], y === lastYear ? totalCurrent : '', updatedAt];
    });
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
  }
  sh.setFrozenRows(1);

  const totalNew = Object.values(byYear).reduce(function(s, v) { return s + v; }, 0);
  Logger.log('✓  Members Growth — done (membership_start_date field, ' + totalNew + ' recorded, ' + totalCurrent + ' total current)');
}

/* =========================================================
   STAFF OS — FUNNEL + CALENDAR PUSH
   Runs as part of the main PCO sync (which has credentials).
   Merge-writes funnel and calendar into eos-data.json so the
   EOS script's own push (scorecard, boulders, etc.) is preserved.
========================================================= */
function syncStaffOSFunnelAndCalendar_() {
  Logger.log('▶  Staff OS Funnel+Calendar — starting');

  // ── Funnel counts ──────────────────────────────────────────────────────
  const guestCount    = pcoCount1_('/people/v2/people?where[membership]=Guest');
  const attenderCount = pcoCount1_('/people/v2/people?where[membership]=Regular+Attender');
  const memberCount   = pcoCount1_('/people/v2/people?where[membership]=Member');
  const groupCount    = pcoCount1_('/groups/v2/memberships');
  const leaderCount   = pcoCount1_('/groups/v2/memberships?where[role]=leader');

  // Missionaries: look for a group whose name includes "mission"
  let missionaryCount = 0;
  try {
    const groups = pcoGetAll_('/groups/v2/groups?per_page=100') || [];
    const mg = groups.find(g => ((g.attributes && g.attributes.name) || '').toLowerCase().includes('mission'));
    if (mg) {
      missionaryCount = pcoCount1_('/groups/v2/groups/' + mg.id + '/memberships');
      Logger.log('   Mission group "' + mg.attributes.name + '": ' + missionaryCount);
    }
  } catch(e) { Logger.log('   Missionary lookup failed: ' + e.message); }

  const funnel = {
    guest: guestCount, attender: attenderCount, member: memberCount,
    group: groupCount, leader: leaderCount, missionary: missionaryCount,
    asOf: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
  Logger.log('   Funnel: guests=' + guestCount + ' members=' + memberCount +
             ' inGroup=' + groupCount + ' leaders=' + leaderCount);

  // ── Calendar events (next 2 months) ───────────────────────────────────
  const tz   = Session.getScriptTimeZone();
  const now  = new Date();
  const end  = new Date(now); end.setMonth(now.getMonth() + 2);
  const calEvents = [];

  try {
    const result = pcoGetAllWithIncluded_(
      '/calendar/v2/event_instances?order=starts_at&per_page=100' +
      '&where[starts_at][gte]=' + encodeURIComponent(now.toISOString()) +
      '&where[starts_at][lte]=' + encodeURIComponent(end.toISOString()) +
      '&include=event'
    );
    const instances = result.data || [];
    const included  = result.included || [];

    const eventNameById = {};
    included.forEach(function(inc) {
      if (inc.type === 'Event') eventNameById[inc.id] = (inc.attributes && inc.attributes.name) || '';
    });

    instances.forEach(function(inst) {
      const evRel  = inst.relationships && inst.relationships.event && inst.relationships.event.data;
      const name   = evRel ? (eventNameById[evRel.id] || '') : '';
      if (!name) return;
      if (name.toUpperCase().includes('RBD')) return;
      const nl = name.toLowerCase();
      if (nl.includes('community group') || nl.startsWith('cg ') || nl.includes('small group')) return;
      const startsAt = (inst.attributes && inst.attributes.starts_at) || '';
      if (!startsAt) return;
      const d = new Date(startsAt);
      calEvents.push({
        name:      name,
        dateKey:   Utilities.formatDate(d, tz, 'yyyy-MM-dd'),
        dayOfWeek: Utilities.formatDate(d, tz, 'EEE'),
        date:      Utilities.formatDate(d, tz, 'MMM d'),
        time:      Utilities.formatDate(d, tz, 'h:mm a'),
        location:  (inst.attributes && inst.attributes.location) || ''
      });
    });
    Logger.log('   Calendar: ' + calEvents.length + ' events (filtered from ' + instances.length + ')');
  } catch(e) {
    Logger.log('   Calendar sync failed: ' + e.message);
  }

  const calendar = {
    events: calEvents,
    asOf: Utilities.formatDate(now, tz, 'yyyy-MM-dd')
  };

  // ── Merge-push to eos-data.json ────────────────────────────────────────
  // Same owner/repo/token as the main dashboard sync — everything in Church-Dashboard.
  const owner  = getProp_('GITHUB_OWNER');
  const token  = getProp_('GITHUB_TOKEN');
  const repo   = getProp_('GITHUB_REPO');
  const path   = 'eos-data.json';
  const branch = 'main';
  const url    = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  const hdrs   = { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' };

  // Read existing eos-data.json
  const existing = UrlFetchApp.fetch(url + '?ref=' + branch, { method:'get', muteHttpExceptions:true, headers:hdrs });
  let sha = null, currentData = {};
  if (existing.getResponseCode() === 200) {
    const file = JSON.parse(existing.getContentText());
    sha = file.sha;
    try {
      currentData = JSON.parse(Utilities.newBlob(
        Utilities.base64Decode(file.content.replace(/\n/g,'')), 'text/plain', 'UTF-8'
      ).getDataAsString());
    } catch(e) { currentData = {}; }
  }

  // Merge funnel + calendar into existing data
  const merged = Object.assign({}, currentData, { funnel: funnel, calendar: calendar });
  const payload = { message: 'Update funnel & calendar data', branch: branch,
                    content: Utilities.base64Encode(JSON.stringify(merged, null, 2), Utilities.Charset.UTF_8) };
  if (sha) payload.sha = sha;

  const res = UrlFetchApp.fetch(url, { method:'put', contentType:'application/json',
                                        muteHttpExceptions:true, headers:hdrs,
                                        payload:JSON.stringify(payload) });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('EOS merge-push failed: ' + code + ' — ' + res.getContentText().substring(0,200));
  }
  Logger.log('✓  Staff OS Funnel+Calendar pushed to ' + owner + '/' + repo + '/' + path);
}

// Helper: fast count using per_page=1 and meta.total_count
function pcoCount1_(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = UrlFetchApp.fetch(
      'https://api.planningcenteronline.com' + path + sep + 'per_page=1',
      { method:'get', muteHttpExceptions:true, headers: pcoHeaders_() }
    );
    if (res.getResponseCode() !== 200) return 0;
    const j = JSON.parse(res.getContentText());
    return (j.meta && j.meta.total_count) ? j.meta.total_count : (j.data ? j.data.length : 0);
  } catch(e) { return 0; }
}

function readMembersRows_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  return rows.filter(function(r) { return r[0] && /^\d{4}$/.test(String(r[0])); })
             .sort(function(a, b) { return String(a[0]) < String(b[0]) ? -1 : 1; });
}

function getTeamsVolunteers_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.volunteers);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues()
    .filter(function(r) { return String(r[0] || '').trim(); })
    .map(function(r) {
      return {
        n: String(r[0]).trim(),
        t: String(r[1] || '—').trim(),
        c: Number(r[2]) || 0,
        d: Number(r[3]) || 0,
        p: Number(r[4]) || 0,
        r: Number(r[5]) || 0
      };
    });
}

function getTeamsPlans_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.plans);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues()
    .filter(function(r) { return r[0]; })
    .map(function(r) {
      // Sheets may return Date objects for date-like cells — normalise both columns
      var rawDate = r[0];
      var dateObj = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
      var sortIso = (dateObj && !isNaN(dateObj)) ? dateObj.toISOString().substring(0, 10) : String(rawDate).substring(0, 10);
      var rawDs = r[1];
      var ds = rawDs instanceof Date
        ? rawDs.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : String(rawDs).trim();
      return {
        date: sortIso,
        ds:   ds,
        ty:   String(r[2] || '—').trim(),
        s: Number(r[3]) || 0,
        c: Number(r[4]) || 0,
        d: Number(r[5]) || 0,
        p: Number(r[6]) || 0
      };
    });
}

function getTeamsLeaderFormsDetailed_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.teams);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });

  function findCol(keywords) {
    for (var ki = 0; ki < keywords.length; ki++) {
      var kw = keywords[ki].toLowerCase();
      for (var hi = 0; hi < headers.length; hi++) {
        if (headers[hi].indexOf(kw) >= 0) return hi;
      }
    }
    return -1;
  }

  // Positional fallbacks based on typical Leader Forms layout (A=timestamp, C=team, E=members, F=gap)
  const iTeam      = findCol(['team', 'q1'])                                  >= 0 ? findCol(['team', 'q1'])                                  : 2;
  const iPerson    = findCol(['person', 'leader', 'your name', 'submitter', 'name']);
  const iSubmitted = findCol(['timestamp', 'submitted']);
  const iScore     = findCol(['score', 'health', 'q2', 'rate']);
  const iMembers   = findCol(['member', 'current', 'q3', 'how many', 'have']) >= 0 ? findCol(['member', 'current', 'q3', 'how many', 'have']) : 4;
  const iNeeded    = findCol(['needed', 'additional', 'q4', 'gap', 'still need', 'more people']) >= 0 ? findCol(['needed', 'additional', 'q4', 'gap', 'still need', 'more people']) : 5;
  const iIssues    = findCol(['issue', 'challenge', 'q5', 'concern', 'problem', 'obstacle']);
  const iMore      = findCol(['q6', 'more info', 'additional note', 'context']);
  const iResources = findCol(['resource', 'q7', 'supply', 'request']);
  const iSuccession= findCol(['succession', 'q8', 'successor', 'who could']);

  const TEAM_ALIASES = {
    'coffee':'Coffee Team','prayer':'Prayer Team','connect':'Connection Team',
    'connection':'Connection Team','worship':'Worship & Tech','tech':'Worship & Tech',
    'safety':'Safety Team','first impression':'First Impressions',
    'first impressions':'First Impressions','enrichment':'Enrichment',
    'hospitality':'Hospitality','ls students':'LS Students','ls kids':'LS Kids',
    'helps':'HELPS','hands to heart':'Hands to Heart','parking':'Parking',
    'stepping stones':'Stepping Stones','breakfast':'Breakfast Team',
    'service captains':'Service Captains','presiders':'Presiders',
    'preachers':'Preachers','counting':'Counting Team','content':'Content Team'
  };

  function normTeam(v) {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const key = s.toLowerCase();
    return TEAM_ALIASES[key] || s.replace(/\w\S*/g, function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
  }

  const byTeam = {};
  data.slice(1).forEach(function(r) {
    const team = normTeam(String(r[iTeam] || '').trim());
    if (!team) return;

    var subDate = null;
    if (iSubmitted >= 0 && r[iSubmitted]) {
      var d = r[iSubmitted] instanceof Date ? r[iSubmitted] : new Date(r[iSubmitted]);
      if (!isNaN(d.getTime())) subDate = d;
    }

    var scoreRaw = iScore >= 0 ? r[iScore] : null;
    var score = (scoreRaw !== null && scoreRaw !== '') ? (Number(scoreRaw) || null) : null;

    var rec = {
      n:      team,
      l:      iPerson    >= 0 ? String(r[iPerson]    || '').trim() || '—' : '—',
      sub:    subDate         ? subDate.toISOString()                      : null,
      subStr: subDate         ? subDate.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) : '—',
      subC:   subDate         ? subDate.toLocaleDateString('en-US', { month:'short', day:'numeric' })                : '—',
      sc:     score,
      mem:    Number(r[iMembers]) || 0,
      need:   Number(r[iNeeded])  || 0,
      iss:    iIssues     >= 0 ? String(r[iIssues]     || '').trim() : '',
      more:   iMore       >= 0 ? String(r[iMore]       || '').trim() : '',
      res:    iResources  >= 0 ? String(r[iResources]  || '').trim() : '',
      suc:    iSuccession >= 0 ? String(r[iSuccession] || '').trim() : '',
      _sub:   subDate
    };

    var prev = byTeam[team];
    var isNewer = !prev || (subDate && (!prev._sub || subDate > prev._sub));
    if (isNewer) byTeam[team] = rec;
  });

  return Object.values(byTeam).map(function(r) {
    delete r._sub;
    return r;
  });
}

/* =========================================================
   GITHUB
========================================================= */

function pushJsonToGitHub_(data) {
  const owner = getProp_('GITHUB_OWNER');
  const repo = getProp_('GITHUB_REPO');
  const token = getProp_('GITHUB_TOKEN');
  const branch = propOptional_('GITHUB_BRANCH') || 'main';
  const path = propOptional_('GITHUB_FILE_PATH') || 'dashboard-data.json';

  const url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;

  const existing = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(branch), {
    method: 'get',
    muteHttpExceptions: true,
    headers: githubHeaders_(token)
  });

  let sha = null;
  if (existing.getResponseCode() === 200) {
    sha = JSON.parse(existing.getContentText()).sha;
  }

  const payload = {
    message: 'Update dashboard data',
    branch: branch,
    content: Utilities.base64Encode(JSON.stringify(data, null, 2), Utilities.Charset.UTF_8)
  };
  if (sha) payload.sha = sha;

  const res = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: githubHeaders_(token),
    payload: JSON.stringify(payload)
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub update failed: ' + code + ' — ' + res.getContentText());
  }
}

function githubHeaders_(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/* =========================================================
   PCO + HELPERS
========================================================= */

function pcoGetAllWithIncluded_(path) {
  let url = path.indexOf('http') === 0 ? path : 'https://api.planningcenteronline.com' + path;
  const out = { data: [], included: [] };
  let pages = 0;

  while (url) {
    let res = null;
    let attempts = 0;

    while (attempts < 5) {
      attempts++;
      Utilities.sleep(DASHBOARD_CONFIG.PCO_REQUEST_DELAY_MS || 250);

      res = UrlFetchApp.fetch(url, {
        method: 'get',
        muteHttpExceptions: true,
        headers: pcoHeaders_()
      });

      const code = res.getResponseCode();
      if (code !== 429) break;

      Logger.log('PCO rate limit hit. Sleeping before retry #' + attempts + '...');
      Utilities.sleep(DASHBOARD_CONFIG.PCO_RATE_LIMIT_SLEEP_MS || 21000);
    }

    const code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('PCO request failed: ' + code + ' — ' + url + ' — ' + res.getContentText());
    }

    const json = JSON.parse(res.getContentText());
    if (json.data)     out.data.push.apply(out.data, json.data);
    if (json.included) out.included.push.apply(out.included, json.included);

    url = (json.links && json.links.next) ? json.links.next : null;
    pages++;
    if (pages > 200) throw new Error('PCO pagination exceeded 200 pages: ' + path);
  }

  return out;
}

function pcoGetAll_(path) {
  return pcoGetAllWithIncluded_(path).data;
}

function pcoHeaders_() {
  return {
    Authorization: 'Basic ' + Utilities.base64Encode(getProp_('PCO_APP_ID') + ':' + getProp_('PCO_SECRET')),
    Accept: 'application/json'
  };
}

function relId_(item, relName) {
  try {
    return String(item.relationships[relName].data.id || '');
  } catch (e) {
    return '';
  }
}

function getProp_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Missing Script Property: ' + name);
  return v;
}

function propOptional_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

/* =========================================================
   DATES
========================================================= */

function getRecentMonths_(count) {
  const now = new Date();
  const arr = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    arr.push(monthObject_(start));
  }
  return arr;
}

function getMonthsFromDateToNow_(startDateString) {
  const startDate = new Date(startDateString + 'T00:00:00');
  const now = new Date();
  const arr = [];

  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const finalMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  while (cursor <= finalMonth) {
    arr.push(monthObject_(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return arr;
}

function monthObject_(start) {
  const next = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  const end = new Date(next.getTime() - 1);
  return {
    key: monthKey_(start),
    label: monthLabel_(start),
    start: isoDate_(start),
    end: isoDate_(end)
  };
}

function monthKey_(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthLabel_(d) {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return names[d.getMonth()] + " '" + String(d.getFullYear()).slice(-2);
}


function normalizeMonthKey_(key, label) {
  // Preferred cache key format is YYYY-MM.
  if (key instanceof Date && !isNaN(key.getTime())) return monthKey_(key);

  const rawKey = String(key || '').trim();

  // Already YYYY-MM or YYYY-MM-DD
  let m = rawKey.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
  if (m) return m[1] + '-' + String(Number(m[2])).padStart(2, '0');

  // Full JS/Google Sheets date string
  const d1 = new Date(rawKey);
  if (rawKey && !isNaN(d1.getTime())) return monthKey_(d1);

  // Fallback to label like Jan '26 or Jan ’26
  const rawLabel = String(label || '').replace(/[‘’]/g, "'").trim();
  let m2 = rawLabel.match(/^([A-Za-z]{3})\s+'?(\d{2})$/);
  if (m2) {
    const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const mon = months[m2[1].toLowerCase()];
    const yr = Number(m2[2]) + 2000;
    if (mon) return yr + '-' + String(mon).padStart(2, '0');
  }

  return '';
}


function monthLabelFromKey_(key) {
  const parts = String(key).split('-');
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]) - 1;
  if (!year || monthIndex < 0 || monthIndex > 11) return String(key);
  return monthLabel_(new Date(year, monthIndex, 1));
}

function isoDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* =========================================================
   TRIGGER SETUP
========================================================= */

function setupHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncDashboard') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncDashboard').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed for syncDashboard.');
}

/* =========================================================
   OPTIONAL DEBUG HELPERS
========================================================= */

function rebuildDashboardJsonFromCacheOnly() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupCacheSheets_(ss);
  const data = buildDashboardDataFromSheet_(ss);
  writeDashboardJsonToSheet_(ss, data);
  pushJsonToGitHub_(data);
  Logger.log('Dashboard JSON rebuilt from Sheet cache only and pushed to GitHub.');
}

function debugCachePreview() {
  const data = buildDashboardDataFromSheet_(SpreadsheetApp.getActiveSpreadsheet());
  Logger.log(JSON.stringify(data, null, 2));
}
