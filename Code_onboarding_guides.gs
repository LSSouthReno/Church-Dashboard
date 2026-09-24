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

/**
 * og_team_contact — prefill a team's leader + secondary contact for the generator.
 *   GET ?action=og_team_contact&team=<PCO team name>&leader=<point leader name>[&pw=<sha256>|&verify=<last4>]
 * Only returns phone/email for (a) the team's Point Leader on the Leader Forms tab and
 * (b) another PCO Services team leader of that same team — never an arbitrary person.
 * Contact details come back only with the admin hash OR when `verify` matches the last
 * 4 digits of the point leader's own phone (same light-identity idea as the staff PIN).
 * Without either it returns { locked:true } plus the names.
 */
function ogTeamContact_(p) {
  p = p || {};
  var team = String(p.team || '').trim(), leader = String(p.leader || '').trim(), pcoTeam = String(p.pcoTeam || p.team || '').trim();
  if (!team) return { ok: false, error: 'missing team' };
  var norm = function(s) { return String(s || '').toLowerCase().replace(/\(kids\)/g, '').replace(/teams?/g, '').replace(/[^a-z]/g, '').replace(/^connection$/, 'connect'); };
  var cache = CacheService.getScriptCache(), ck = 'OG_TC4_' + norm(team) + '_' + norm(pcoTeam) + '_' + norm(leader);
  var info = null;
  try { var hit = cache.get(ck); if (hit) info = JSON.parse(hit); } catch (x) {}
  if (!info) {
    info = { primary: null, secondary: null };
    // (a) Point leader must be on the Leader Forms tab for this team.
    var lf = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Leader Forms');
    var rows = lf ? lf.getDataRange().getValues() : [];
    var isPointLeader = rows.some(function(r) { return norm(r[2]) === norm(team) && String(r[1] || '').trim().toLowerCase() === leader.toLowerCase(); });
    if (isPointLeader && leader) info.primary = ogPcoPersonByName_(leader);
    // (b) Another PCO Services team leader of the same team → secondary contact.
    try {
      var teams = pcoGetAll_('/services/v2/teams?per_page=100');
      var t = teams.filter(function(x) { return norm((x.attributes || {}).name) === norm(pcoTeam); })[0];
      if (t) {
        var tl = pcoGetAllWithIncluded_('/services/v2/teams/' + t.id + '/team_leaders?include=people&per_page=100');
        var ids = [];
        (tl.data || []).forEach(function(r) { var d = (((r.relationships || {}).people || {}).data) || (((r.relationships || {}).person || {}).data); if (d && d.id) ids.push(d.id); });
        if (!info.primary && !leader && ids.length) info.primary = ogPcoPersonById_(ids[0]);   // no Leader Form (e.g. Presiders) → first PCO team leader
        for (var i = 0; i < ids.length && !info.secondary; i++) {
          if (info.primary && String(ids[i]) === String(info.primary.id)) continue;
          var sp = ogPcoPersonById_(ids[i]);
          if (sp && (!info.primary || sp.name.toLowerCase() !== info.primary.name.toLowerCase())) info.secondary = sp;
        }
      }
    } catch (x) { info.teamLeaderError = String(x && x.message || x); }
    try { cache.put(ck, JSON.stringify(info), 21600); } catch (x) {}
  }
  var digits = function(s) { return String(s || '').replace(/\D/g, ''); };
  var verify = digits(p.verify);
  var authed = ogAuth_(p.pw) || (!!verify && verify.length === 4 && !!info.primary && (info.primary.phones || []).some(function(ph) { return digits(ph).slice(-4) === verify; }));
  var pub = function(c) { return c ? (authed ? { name: c.name, phone: c.phone || '', email: c.email || '' } : { name: c.name }) : null; };
  return { ok: true, locked: !authed, verified: authed, primary: pub(info.primary), secondary: pub(info.secondary),
           canVerify: !!(info.primary && (info.primary.phones || []).length) };
}
function ogPcoPerson_(json) {
  var d = json && json.data; if (!d) return null;
  if (Object.prototype.toString.call(d) === '[object Array]') d = d[0]; if (!d) return null;
  var a = d.attributes || {}, inc = json.included || [];
  var emails = inc.filter(function(x) { return x.type === 'Email'; }).map(function(x) { return x.attributes || {}; });
  var phones = inc.filter(function(x) { return x.type === 'PhoneNumber'; }).map(function(x) { return x.attributes || {}; });
  var pick = function(list, key) { var pr = list.filter(function(x) { return x.primary; })[0] || list[0]; return pr ? String(pr[key] || '') : ''; };
  return { id: d.id, name: a.name || ((a.first_name || '') + ' ' + (a.last_name || '')).trim(),
           email: pick(emails, 'address'), phone: pick(phones, 'number'),
           phones: phones.map(function(x) { return String(x.number || ''); }) };
}
function ogPcoGetJson_(path) {
  var res = UrlFetchApp.fetch('https://api.planningcenteronline.com' + path, { method: 'get', muteHttpExceptions: true, headers: pcoHeaders_() });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) return null;
  return JSON.parse(res.getContentText());
}
function ogPcoPersonById_(id) { return ogPcoPerson_(ogPcoGetJson_('/people/v2/people/' + encodeURIComponent(id) + '?include=emails,phone_numbers')); }
function ogPcoPersonByName_(name) {
  var fold = function(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); };
  var want = fold(name), parts = want.split(' ');
  var match = function(d) { var a = d.attributes || {}; return fold(a.name) === want || fold((a.first_name || '') + ' ' + (a.last_name || '')) === want || fold((a.nickname || '') + ' ' + (a.last_name || '')) === want; };
  var json = ogPcoGetJson_('/people/v2/people?where[search_name]=' + encodeURIComponent(name) + '&include=emails,phone_numbers&per_page=25');
  var pick = json && json.data && json.data.filter(match)[0];
  if (!pick && parts.length > 1) {
    // Accents / nicknames: search by first name and compare accent-insensitively.
    json = ogPcoGetJson_('/people/v2/people?where[first_name]=' + encodeURIComponent(parts[0]) + '&include=emails,phone_numbers&per_page=100');
    pick = json && json.data && json.data.filter(match)[0];
    if (!pick) { json = ogPcoGetJson_('/people/v2/people?where[search_name]=' + encodeURIComponent(parts[parts.length - 1]) + '&include=emails,phone_numbers&per_page=100'); pick = json && json.data && json.data.filter(function(d) { var a = d.attributes || {}; return fold(a.last_name) === parts[parts.length - 1] && fold(a.first_name || a.nickname).indexOf(parts[0].slice(0, 3)) === 0; })[0]; }
  }
  if (!pick) return null;
  // Keep only this person's included rows.
  var relIds = {};
  ['emails', 'phone_numbers'].forEach(function(k) { (((pick.relationships || {})[k] || {}).data || []).forEach(function(r) { relIds[r.type + ':' + r.id] = 1; }); });
  var inc = (json.included || []).filter(function(x) { return relIds[x.type + ':' + x.id]; });
  return ogPcoPerson_({ data: pick, included: inc });
}
