/**
 * EOS Rocks & Boulders Web App
 *
 * Handles rock resolve/add and boulder status updates from the Staff OS dashboard.
 * Writes directly to the EOS Google Sheet, then re-pushes eos-data.json to GitHub.
 *
 * After deploying: Apps Script → Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Copy the /exec URL and set EOS_WEBAPP_URL in index.html.
 */

var EOS_WA_SS_ID_    = '1aSZXObUWGmo_zsyJmlocoodyiozC_SNwnqqpUcAPHU8';
// lssr-staff-os was archived (June 2026) — eos-data.json now lives at the root of Church-Dashboard.
// These are only fallbacks; GITHUB_REPO / GITHUB_OWNER / GITHUB_TOKEN script properties (shared
// with the rest of the sync scripts) are used first and already point at Church-Dashboard.
var EOS_WA_GH_REPO_  = 'Church-Dashboard';
var EOS_WA_GH_FILE_  = 'eos-data.json';
var EOS_WA_GH_BRANCH_= 'main';

// ── Entry points ─────────────────────────────────────────────────────────────

// NOTE: Code_ids_joy_webapp.gs also needs doGet/doPost (IDS Log, Joy Bombs, Absences) but Apps
// Script only allows ONE global doGet/doPost per project. It exposes idsJoyDoGet_/idsJoyDoPost_
// instead, and this file dispatches to them so both feature sets share one deployed web app
// (the URL set as EOS_WEBAPP_URL / IDS_WEBAPP_URL in index.html).
var EOS_IDSJOY_GET_ACTIONS_  = ['ids', 'joy_bombs', 'joy_bomb_backfill', 'jb_diag'];
var EOS_IDSJOY_POST_ACTIONS_ = ['ids_add', 'ids_update', 'joy_bomb_add', 'joy_bomb_mark', 'joy_bomb_dismiss', 'absence_add', 'absence_remove'];

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    if (EOS_IDSJOY_GET_ACTIONS_.indexOf(action) !== -1) return idsJoyDoGet_(e);
    if (action === 'rocks') {
      var ss = SpreadsheetApp.openById(EOS_WA_SS_ID_);
      return eosWaJson_({ rocks: eosWaReadRocks_(ss), boulders: eosWaReadBoulders_(ss) });
    }
    if (action === 'run_json_rebuild') {
      // Fast rebuild+push of dashboard-data.json from cached sheets (no PCO
      // pulls) — used to publish SectionDescriptions edits on demand.
      var ssJr = SpreadsheetApp.getActiveSpreadsheet();
      var dataJr = buildDashboardDataFromSheet_(ssJr);
      writeDashboardJsonToSheet_(ssJr, dataJr);
      pushJsonToGitHub_(dataJr);
      return eosWaJson_({ ok: true, ran: 'json_rebuild' });
    }
    if (action === 'run_donor_backfill') {
      // Kicks off the resumable donor-count backfill (2018 → now). It processes
      // one year, then self-schedules continuation triggers every 90s.
      backfillAllDonorCounts();
      return eosWaJson_({ ok: true, ran: 'backfillAllDonorCounts' });
    }
    if (action === 'run_calendar_sync') {
      // On-demand refresh of funnel+calendar in eos-data.json (clasp run is
      // unavailable in this project, so this is the remote trigger).
      syncStaffOSFunnelAndCalendar_();
      return eosWaJson_({ ok: true, ran: 'syncStaffOSFunnelAndCalendar_' });
    }
    if (action === 'run_inspect_forms') {
      // Read-only: dump PCO People forms + the Point Leader form's fields and
      // recent submissions, so the Leader Forms importer can be mapped exactly.
      return eosWaJson_(inspectPeopleForms_());
    }
    if (action === 'run_dump_leader_tab') {
      // Read-only: dump the Leader Forms tab's headers + recent rows.
      return eosWaJson_(dumpLeaderFormsTab_());
    }
    if (action === 'run_import_leader_forms') {
      // Pulls Point Leader Update Form submissions into the Leader Forms tab.
      // dry=1 (default) reports what it WOULD write without writing.
      var lfDry = !(e && e.parameter && e.parameter.dry === '0');
      return eosWaJson_(importLeaderFormsFromPCO_(lfDry));
    }
    return eosWaJson_({ ok: true, service: 'EOS Staff OS Webapp' });
  } catch(err) {
    return eosWaJson_({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    var body   = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action || '';

    if (EOS_IDSJOY_POST_ACTIONS_.indexOf(action) !== -1) return idsJoyDoPost_(e);

    // Rock resolve, add, and boulder status now write lightweight overlay fields
    // directly into eos-data.json rather than reading from the EOS sheet (a different
    // spreadsheet than the one the Staff OS Sheet script manages) and overwriting the
    // Staff OS Sheet script's rocks/boulders data on every action.
    if (action === 'rock_resolve') {
      var ctx = eosWaFetchEosData_();
      if (ctx) {
        var cr = Object.assign({}, ctx.data.closedRocks || {});
        cr[String(body.rock || '')] = { ts: Date.now(), resolution: String(body.resolution || ''), owner: String(body.owner || '') };
        eosWaPushFields_(ctx, { closedRocks: cr });
      }

    } else if (action === 'rock_add') {
      var ctx = eosWaFetchEosData_();
      if (ctx) {
        var ar = (ctx.data.addedRocks || []).slice();
        // Dedup: don't add the same rock text twice
        var rock = String(body.rock || '').trim();
        if (rock && !ar.find(function(r) { return r.rock === rock; })) {
          ar.push({ rock: rock, addedBy: String(body.addedBy || 'Staff').trim(),
                    priority: String(body.priority || 'med').trim(), ts: Date.now() });
          eosWaPushFields_(ctx, { addedRocks: ar });
        }
      }

    } else if (action === 'boulder_status') {
      var ctx = eosWaFetchEosData_();
      if (ctx) {
        var bs = Object.assign({}, ctx.data.boulderStatuses || {});
        var bk = String(body.title || '').trim() + '|' + String(body.owner || '').trim();
        bs[bk] = String(body.status || 'tbd').trim();
        eosWaPushFields_(ctx, { boulderStatuses: bs });
      }

    } else if (action === 'rock_unresolve') {
      // Removes a rock from the closedRocks overlay (undo an accidental resolve).
      var ctx = eosWaFetchEosData_();
      if (ctx && body.rock) {
        var cr = Object.assign({}, ctx.data.closedRocks || {});
        delete cr[String(body.rock || '')];
        eosWaPushFields_(ctx, { closedRocks: cr });
      }

    } else if (action === 'staffdev_save') {
      var ss = SpreadsheetApp.openById(EOS_WA_SS_ID_);
      eosWaSaveStaffDevNote_(ss, String(body.note || ''));
      eosWaPushStaffDevToGitHub_(ss);

    } else if (action === 'tlh_save') {
      // Team Leader Hub checklist + message templates. Stored as overlay fields in
      // eos-data.json (survives the merge-safe funnel/calendar sync), so leaders' shared
      // lists persist across devices. Each list carries a ts for last-write-wins on the client.
      var ctx = eosWaFetchEosData_();
      if (ctx) {
        var f = {};
        if (body.checklist) { f.tlhChecklist = body.checklist; f.tlhChecklistTs = Number(body.checklistTs) || Date.now(); }
        if (body.templates) { f.tlhTemplates = body.templates; f.tlhTemplatesTs = Number(body.templatesTs) || Date.now(); }
        if (Object.keys(f).length) eosWaPushFields_(ctx, f);
      }
    }

    return eosWaJson_({ ok: true });
  } catch(err) {
    Logger.log('doPost error: ' + err.message);
    return eosWaJson_({ ok: false, error: err.message });
  }
}

// ── eos-data.json overlay helpers ─────────────────────────────────────────────
// Fetch current eos-data.json, parse it, return context object with sha + data.
function eosWaFetchEosData_() {
  var props  = PropertiesService.getScriptProperties();
  var owner  = props.getProperty('GITHUB_OWNER');
  var token  = props.getProperty('EOS_GITHUB_TOKEN') || props.getProperty('GITHUB_TOKEN');
  var repo   = props.getProperty('EOS_GITHUB_REPO')  || EOS_WA_GH_REPO_;
  var path   = props.getProperty('EOS_GITHUB_FILE_PATH') || EOS_WA_GH_FILE_;
  var branch = props.getProperty('EOS_GITHUB_BRANCH')    || EOS_WA_GH_BRANCH_;
  if (!owner || !token) { Logger.log('eosWaFetchEosData_: missing credentials'); return null; }
  var url  = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  var hdrs = { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'GoogleAppsScript' };
  var res  = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(branch), { method: 'get', muteHttpExceptions: true, headers: hdrs });
  if (res.getResponseCode() !== 200) { Logger.log('eosWaFetchEosData_: GET failed ' + res.getResponseCode()); return null; }
  var file = JSON.parse(res.getContentText());
  var data = {};
  try { data = JSON.parse(Utilities.newBlob(Utilities.base64Decode(file.content), 'application/json').getDataAsString()); } catch(e) {}
  return { sha: file.sha, data: data, url: url, hdrs: hdrs, branch: branch };
}

// Merge `fields` into ctx.data and write back to GitHub (safe: uses the sha we just read).
function eosWaPushFields_(ctx, fields) {
  Object.assign(ctx.data, fields);
  var payload = { message: 'Update EOS overlay from Staff OS dashboard', branch: ctx.branch, sha: ctx.sha,
                  content: Utilities.base64Encode(JSON.stringify(ctx.data, null, 2), Utilities.Charset.UTF_8) };
  var res = UrlFetchApp.fetch(ctx.url, { method: 'put', contentType: 'application/json',
                                          muteHttpExceptions: true, headers: ctx.hdrs, payload: JSON.stringify(payload) });
  Logger.log('eosWaPushFields_: PUT ' + res.getResponseCode());
  return res.getResponseCode() >= 200 && res.getResponseCode() < 300;
}

// ── Sheet readers ─────────────────────────────────────────────────────────────

function eosWaReadRocks_(ss) {
  var sh = ss.getSheetByName('EOS_Rocks');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .filter(function(r) { return String(r[0]).trim(); })
    .map(function(r) {
      return { rock: String(r[0]).trim(), addedBy: String(r[1]).trim(),
               priority: String(r[2]).trim() || 'med', status: String(r[3]).trim() || 'open' };
    });
}

function eosWaReadBoulders_(ss) {
  var sh = ss.getSheetByName('EOS_Boulders');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter(function(r) { return String(r[0]).trim(); })
    .map(function(r) {
      return { title: String(r[0]).trim(), owner: String(r[1]).trim(),
               quarter: String(r[2]).trim(), status: String(r[3]).trim() || 'tbd',
               type: String(r[4]).trim() || 'company' };
    });
}

function eosWaReadMeta_(ss) {
  var sh = ss.getSheetByName('EOS_Meta');
  if (!sh || sh.getLastRow() < 2) return { quarter: 'Q3 2026', lastUpdated: '' };
  var row = sh.getRange(2, 1, 1, 2).getValues()[0];
  return { quarter: String(row[0] || 'Q3 2026').trim(), lastUpdated: String(row[1] || '').trim() };
}

function eosWaReadScorecard_(ss) {
  var sh = ss.getSheetByName('EOS_Scorecard');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues()
    .filter(function(r) { return String(r[0]).trim(); })
    .map(function(r) {
      return { metric: String(r[0]).trim(), owner: String(r[1]).trim(),
               goal: String(r[2]).trim(), current: String(r[3]).trim(),
               status: String(r[4]).trim() || 'grey', notes: String(r[5]).trim() };
    });
}

// ── Staff Development note (persisted separately, not part of weekly L10 notes) ──

var EOS_STAFFDEV_SHEET_ = 'EOS_StaffDev';

function eosWaReadStaffDevNote_(ss) {
  var sh = ss.getSheetByName(EOS_STAFFDEV_SHEET_);
  if (!sh || sh.getLastRow() < 2) return '';
  return String(sh.getRange(2, 1).getValue() || '');
}

function eosWaSaveStaffDevNote_(ss, note) {
  var sh = ss.getSheetByName(EOS_STAFFDEV_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(EOS_STAFFDEV_SHEET_);
    sh.appendRow(['note', 'updated_at']);
    sh.getRange(1, 1, 1, 2).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.appendRow(['', '']);
  }
  sh.getRange(2, 1).setValue(note);
  sh.getRange(2, 2).setValue(new Date().toISOString());
}

// ── Sheet writers ─────────────────────────────────────────────────────────────

function eosWaResolveRock_(ss, rockName) {
  var sh   = ss.getSheetByName('EOS_Rocks');
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === rockName) {
      sh.getRange(i + 1, 4).setValue('resolved');
      Logger.log('Rock resolved: ' + rockName);
      return;
    }
  }
  Logger.log('Rock not found: ' + rockName);
}

function eosWaAddRock_(ss, rock, addedBy, priority) {
  var sh = ss.getSheetByName('EOS_Rocks');
  sh.appendRow([rock, addedBy, priority, 'open']);
  Logger.log('Rock added: ' + rock);
}

function eosWaUpdateBoulder_(ss, title, owner, status) {
  var sh   = ss.getSheetByName('EOS_Boulders');
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === title && String(rows[i][1]).trim() === owner) {
      sh.getRange(i + 1, 4).setValue(status);
      Logger.log('Boulder updated: ' + title + ' → ' + status);
      return;
    }
  }
  Logger.log('Boulder not found: ' + title + ' / ' + owner);
}

// ── GitHub push ───────────────────────────────────────────────────────────────

// Merge-push: fetches the CURRENT eos-data.json and patches only meta/scorecard/boulders/rocks,
// preserving vto/culture/meetings/funnel/calendar/etc. written by the separate Staff OS sheet
// script. A full-file overwrite here would silently erase all of that on every rock/boulder edit.
function eosWaPushGitHub_(ss) {
  var props  = PropertiesService.getScriptProperties();
  var owner  = props.getProperty('GITHUB_OWNER');
  var token  = props.getProperty('EOS_GITHUB_TOKEN') || props.getProperty('GITHUB_TOKEN');
  var repo   = props.getProperty('EOS_GITHUB_REPO')  || EOS_WA_GH_REPO_;
  var path   = props.getProperty('EOS_GITHUB_FILE_PATH') || EOS_WA_GH_FILE_;
  var branch = props.getProperty('EOS_GITHUB_BRANCH')    || EOS_WA_GH_BRANCH_;

  if (!owner || !token) { Logger.log('EOS webapp: missing GitHub credentials'); return; }

  var url     = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  var headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GoogleAppsScript'
  };

  var existing = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(branch),
    { method: 'get', muteHttpExceptions: true, headers: headers });
  if (existing.getResponseCode() !== 200) {
    Logger.log('EOS webapp: could not fetch existing eos-data.json (' + existing.getResponseCode() + ') — aborting to avoid data loss');
    return;
  }
  var fileMeta = JSON.parse(existing.getContentText());
  var current = {};
  try {
    current = JSON.parse(Utilities.newBlob(Utilities.base64Decode(fileMeta.content), 'application/json').getDataAsString());
  } catch(e) {
    Logger.log('EOS webapp: could not parse existing eos-data.json — aborting to avoid data loss');
    return;
  }

  current.meta      = Object.assign({}, current.meta, eosWaReadMeta_(ss));
  current.scorecard = eosWaReadScorecard_(ss);
  current.boulders  = eosWaReadBoulders_(ss);
  current.rocks      = eosWaReadRocks_(ss);

  var payload = {
    message: 'Update EOS data from Staff OS dashboard',
    branch:  branch,
    sha:     fileMeta.sha,
    content: Utilities.base64Encode(JSON.stringify(current, null, 2), Utilities.Charset.UTF_8)
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'put', contentType: 'application/json',
    muteHttpExceptions: true, headers: headers,
    payload: JSON.stringify(payload)
  });
  Logger.log('GitHub EOS push: ' + res.getResponseCode());
}

// Merge-push: fetches the CURRENT eos-data.json, patches only staffDevNote, and writes it
// back — unlike eosWaPushGitHub_ (which rebuilds meta/scorecard/boulders/rocks from this
// project's own sheet and would overwrite vto/culture/meetings/etc. written by the separate
// Staff OS sheet script), this never touches any other field.
function eosWaPushStaffDevToGitHub_(ss) {
  var props  = PropertiesService.getScriptProperties();
  var owner  = props.getProperty('GITHUB_OWNER');
  var token  = props.getProperty('EOS_GITHUB_TOKEN') || props.getProperty('GITHUB_TOKEN');
  var repo   = props.getProperty('EOS_GITHUB_REPO')  || EOS_WA_GH_REPO_;
  var path   = props.getProperty('EOS_GITHUB_FILE_PATH') || EOS_WA_GH_FILE_;
  var branch = props.getProperty('EOS_GITHUB_BRANCH')    || EOS_WA_GH_BRANCH_;

  var dbg = { owner: owner, repo: repo, path: path, branch: branch, hasToken: !!token };
  if (!owner || !token) { dbg.error = 'missing GitHub credentials'; return dbg; }

  var url     = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  var headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GoogleAppsScript'
  };

  var existing = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(branch),
    { method: 'get', muteHttpExceptions: true, headers: headers });
  dbg.getCode = existing.getResponseCode();
  if (dbg.getCode !== 200) {
    dbg.error = 'could not fetch existing file';
    dbg.getBody = existing.getContentText().substring(0, 300);
    return dbg;
  }
  var fileMeta = JSON.parse(existing.getContentText());
  var current = {};
  try {
    current = JSON.parse(Utilities.newBlob(Utilities.base64Decode(fileMeta.content), 'application/json').getDataAsString());
  } catch(e) { dbg.error = 'could not parse existing JSON: ' + e.message; return dbg; }

  current.staffDevNote = eosWaReadStaffDevNote_(ss);

  var payload = {
    message: 'Update staff development note from Staff OS dashboard',
    branch:  branch,
    sha:     fileMeta.sha,
    content: Utilities.base64Encode(JSON.stringify(current, null, 2), Utilities.Charset.UTF_8)
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'put', contentType: 'application/json',
    muteHttpExceptions: true, headers: headers,
    payload: JSON.stringify(payload)
  });
  dbg.putCode = res.getResponseCode();
  if (dbg.putCode < 200 || dbg.putCode >= 300) dbg.putBody = res.getContentText().substring(0, 300);
  return dbg;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function eosWaJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
