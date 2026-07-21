/**
 * Team Onboarding Guides — central store
 * ======================================
 * The onboarding generator (team-onboarding-generator.html) is a static page,
 * so guides normally live only in the author's own browser. This module gives
 * them a shared home: every time someone generates a guide it is POSTed here
 * and upserted into the "OnboardingGuides" tab, one row per team (the team's
 * CURRENT doc). Staff can then unlock the generator's Admin panel and view or
 * load any team's guide.
 *
 * Actions (wired in Code_eos_webapp.gs):
 *   POST { action:'og_save', team, leader, data }   → ogSaveGuide_
 *   GET  ?action=og_list&pw=<sha256>                → ogListGuides_
 *   GET  ?action=og_get&pw=<sha256>&team=<name>     → ogGetGuide_
 *
 * Auth note: reads require the same SHA-256 admin hash the dashboard's Admin
 * tab already uses. That hash is public in the dashboard source, so this is a
 * light gate (keeps casual eyes out), NOT real authentication.
 */

var OG = {
  TAB: 'OnboardingGuides',
  // Same admin password hash the Team Dashboard admin tab uses.
  PW_HASH: 'b89b95790b740ffc4317734a8c456eb680d6a19dea09131b0b513943794e9fa6',
  MAX_JSON: 45000 // Sheets cell cap is 50k chars; stay under it.
};

function ogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(OG.TAB);
  if (!sh) {
    sh = ss.insertSheet(OG.TAB);
    sh.appendRow(['Saved', 'Team', 'Leader', 'Team Key', 'Guide JSON']);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  return sh;
}

function ogAuth_(pw) {
  return String(pw || '').toLowerCase() === OG.PW_HASH;
}

function ogTeamKey_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Upsert one guide, keyed by team (a team's current onboarding doc).
function ogSaveGuide_(body) {
  var team = String((body && body.team) || '').trim();
  if (!team) return { ok: false, error: 'missing team' };

  var json = JSON.stringify((body && body.data) || {});
  if (json.length > OG.MAX_JSON) {
    return { ok: false, error: 'guide too large (' + json.length + ' chars)' };
  }

  var sh  = ogSheet_();
  var key = ogTeamKey_(team);
  var row = [new Date().toISOString(), team, String((body && body.leader) || '').trim(), key, json];

  var last = sh.getLastRow();
  var keys = last > 1 ? sh.getRange(2, 4, last - 1, 1).getValues().map(function(r) { return String(r[0]); }) : [];
  var idx  = keys.indexOf(key);
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, 5).setValues([row]);
  else          sh.appendRow(row);

  return { ok: true, team: team, updated: idx >= 0 };
}

// List saved guides (metadata only — no payloads).
function ogListGuides_(pw) {
  if (!ogAuth_(pw)) return { ok: false, error: 'unauthorized' };
  var sh = ogSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, guides: [] };
  var vals = sh.getRange(2, 1, last - 1, 5).getValues();
  var out = vals.map(function(r) {
    return {
      saved:  String(r[0] instanceof Date ? r[0].toISOString() : r[0]),
      team:   String(r[1]),
      leader: String(r[2]),
      key:    String(r[3]),
      size:   String(r[4] || '').length
    };
  }).filter(function(g) { return g.team; });
  out.sort(function(a, b) { return b.saved.localeCompare(a.saved); });
  return { ok: true, guides: out };
}

// Remove a team's saved guide (admin only).
function ogDeleteGuide_(pw, team) {
  if (!ogAuth_(pw)) return { ok: false, error: 'unauthorized' };
  var sh = ogSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'not found' };
  var key  = ogTeamKey_(team);
  var keys = sh.getRange(2, 4, last - 1, 1).getValues().map(function(r) { return String(r[0]); });
  var idx  = keys.indexOf(key);
  if (idx < 0) return { ok: false, error: 'not found' };
  sh.deleteRow(idx + 2);
  return { ok: true, deleted: team };
}

// Return one guide's full payload so the generator can load it into the form.
function ogGetGuide_(pw, team) {
  if (!ogAuth_(pw)) return { ok: false, error: 'unauthorized' };
  var sh = ogSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'not found' };
  var key  = ogTeamKey_(team);
  var vals = sh.getRange(2, 1, last - 1, 5).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][3]) === key) {
      var data = {};
      try { data = JSON.parse(vals[i][4] || '{}'); } catch (e) { return { ok: false, error: 'corrupt payload' }; }
      return {
        ok: true,
        team:   String(vals[i][1]),
        leader: String(vals[i][2]),
        saved:  String(vals[i][0] instanceof Date ? vals[i][0].toISOString() : vals[i][0]),
        data:   data
      };
    }
  }
  return { ok: false, error: 'not found' };
}
