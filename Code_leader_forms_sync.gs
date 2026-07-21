/**
 * Point Leader Update Forms → Leader Forms tab sync
 * ==================================================
 * Auto-pulls Point Leader Update Form submissions from PCO People Forms and
 * writes them into the "Leader Forms" tab, which feeds the Serve Teams
 * "needed" numbers on the dashboard (see getServeTeams_ in the main sync:
 * needed = current members + additional needed, both from this tab).
 *
 * This file is intentionally isolated so it can be reviewed/removed without
 * touching the main sync. It reuses global helpers pcoHeaders_ / getProp_.
 *
 * Two entry points, exposed as doGet actions in Code_eos_webapp.gs:
 *   run_inspect_forms        → inspectPeopleForms_()          (read-only)
 *   run_import_leader_forms  → importLeaderFormsFromPCO_(dry) (dry-run/live)
 *
 * STATUS: discovery phase. The field→column MAPPING below is filled in after
 * inspecting the real form; the importer stays dry-run until it's verified.
 */

var LFS = {
  // Regex used to auto-detect the Point Leader Update Form by name.
  FORM_NAME_MATCH: /point\s*leader|leader\s*update|update\s*form|serve\s*team\s*update/i,
  // PCO People form id for "Point Leader Update Form" (confirmed via inspection).
  FORM_ID: '892107',
  TAB: 'Leader Forms',

  // Field id → meaning, from the live form. Used to read each submission's answers.
  FIELD: {
    team:       '6981619', // "What Team do you lead?"
    score:      '6981622', // "On a scale of 1-10, how is the team doing?"
    current:    '6981623', // "How many people do you have on the team?"
    needed:     '6981624', // "How many MORE people do you need for the team to thrive?"
    why:        '6981625', // "Explain why you feel this need"
    issues:     '6981628', // "What issues are you currently having…"
    resources:  '6981631', // "Are there any resources or tools…"
    succession: '6986285'  // "Who on the team are you (or can you) train to replace you…"
  },

  // Leader Forms tab column indices (0-based). Column G ("From Services") is
  // populated elsewhere and is never touched by this importer.
  COL: { submitted:0, person:1, team:2, score:3, current:4, needed:5, fromServices:6, why:7, issues:8, resources:9, succession:10 }
};

/* =========================================================
   DISCOVERY — read-only. Lists People forms and dumps the
   Point Leader form's fields + recent submissions so we can
   map answers to the Leader Forms tab columns precisely.
========================================================= */

function inspectPeopleForms_() {
  var out = { ok: true, forms: [], picked: null, fields: [], submissions: [], notes: [] };

  // 1) List all People forms
  var forms = lfsFetchJson_('/people/v2/forms?per_page=100&include=form_category');
  if (!forms.ok) return { ok: false, step: 'list forms', error: forms.error, code: forms.code };

  (forms.body.data || []).forEach(function(f) {
    var a = f.attributes || {};
    out.forms.push({
      id: f.id,
      name: a.name,
      active: a.active,
      archived: a.archived,
      submission_count: a.submission_count,
      created_at: a.created_at,
      attrKeys: Object.keys(a)  // reveal real attribute names for reference
    });
  });

  // 2) Pick the Point Leader form (config override wins, else name match)
  var picked = null;
  if (LFS.FORM_ID) {
    picked = out.forms.find(function(f) { return String(f.id) === String(LFS.FORM_ID); });
  }
  if (!picked) {
    picked = out.forms.find(function(f) { return LFS.FORM_NAME_MATCH.test(f.name || ''); });
  }
  if (!picked) {
    out.notes.push('No form name matched ' + LFS.FORM_NAME_MATCH + '. Review the forms list above and set LFS.FORM_ID.');
    return out;
  }
  out.picked = picked;

  // 3) Fields for the picked form — try both endpoint spellings
  var fields = lfsFetchJson_('/people/v2/forms/' + picked.id + '/fields?per_page=100');
  if (!fields.ok) fields = lfsFetchJson_('/people/v2/forms/' + picked.id + '/form_fields?per_page=100');
  if (fields.ok) {
    (fields.body.data || []).forEach(function(fl) {
      var a = fl.attributes || {};
      out.fields.push({
        id: fl.id,
        label: a.label,
        field_type: a.field_type,
        sequence: a.sequence,
        required: a.required,
        attrKeys: Object.keys(a)
      });
    });
    out.fields.sort(function(x, y) { return (x.sequence || 0) - (y.sequence || 0); });
  } else {
    out.notes.push('Could not read fields: ' + fields.code + ' ' + fields.error);
  }

  // 4) Recent submissions with their values, mapped to field labels
  var labelById = {};
  out.fields.forEach(function(f) { labelById[f.id] = f.label; });

  var subs = lfsFetchJson_('/people/v2/forms/' + picked.id +
    '/form_submissions?per_page=5&order=-created_at&include=form_submission_values');
  if (!subs.ok) {
    out.notes.push('Could not read submissions: ' + subs.code + ' ' + subs.error);
    return out;
  }

  // Index included values by id (if the include worked)
  var included = subs.body.included || [];
  var valById = {};
  included.forEach(function(inc) {
    if (inc.type && inc.type.toLowerCase().indexOf('value') >= 0) valById[inc.id] = inc;
  });

  (subs.body.data || []).forEach(function(s) {
    var sa = s.attributes || {};
    var rec = { id: s.id, created_at: sa.created_at, attrKeys: Object.keys(sa), answers: [] };

    // Preferred: pull values via the submission's own endpoint (reliable shape)
    var vals = lfsFetchJson_('/people/v2/forms/' + picked.id +
      '/form_submissions/' + s.id + '/form_submission_values?per_page=100&include=form_field');
    if (vals.ok) {
      var incLabel = {};
      (vals.body.included || []).forEach(function(inc) {
        if (inc.type && inc.type.toLowerCase().indexOf('field') >= 0) {
          incLabel[inc.id] = (inc.attributes || {}).label;
        }
      });
      (vals.body.data || []).forEach(function(v) {
        var va = v.attributes || {};
        var fieldId = ((((v.relationships || {}).form_field || {}).data) || {}).id;
        rec.answers.push({
          field_id: fieldId,
          label: incLabel[fieldId] || labelById[fieldId] || '(unknown field)',
          value: va.display_value !== undefined ? va.display_value : va.value,
          attrKeys: Object.keys(va)
        });
      });
    } else {
      rec.note = 'value fetch ' + vals.code + ' ' + vals.error;
    }
    out.submissions.push(rec);
  });

  return out;
}

// Read-only: dump the current Leader Forms tab so the importer writes to the
// exact same columns/format the dashboard already reads.
function dumpLeaderFormsTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(LFS.TAB);
  if (!sh) return { ok: false, error: 'No tab named "' + LFS.TAB + '"' };
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1) return { ok: true, headers: [], rows: [], lastRow: 0, lastCol: lastCol };
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function(h, i) { return { col: i, letter: lfsColLetter_(i), header: String(h) }; });
  var body = values.slice(1);
  return {
    ok: true, tab: LFS.TAB, lastRow: lastRow, lastCol: lastCol,
    headers: headers,
    rowCount: body.length,
    sampleRows: body.map(function(r, i) {
      return { rowNum: i + 2, cells: r.map(function(c) { return c instanceof Date ? c.toISOString() : c; }) };
    })
  };
}

function lfsColLetter_(i) {
  var s = '';
  i = i + 1;
  while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/* =========================================================
   IMPORTER — placeholder until discovery confirms the mapping.
   Kept dry-run-only so it can be pushed safely alongside
   discovery without risk of writing bad data.
========================================================= */

function importLeaderFormsFromPCO_(dryRun) {
  dryRun = dryRun !== false; // default to dry-run unless explicitly false
  var formId = LFS.FORM_ID;

  // 1) Pull all submissions with their submitter (person).
  var listed = lfsGetAll_('/people/v2/forms/' + formId +
    '/form_submissions?per_page=100&include=person');
  if (!listed.ok) return { ok: false, step: 'list submissions', error: listed.error, code: listed.code };

  var personName = {};
  (listed.included || []).forEach(function(inc) {
    if (inc.type && inc.type.toLowerCase() === 'person') {
      var a = inc.attributes || {};
      personName[inc.id] = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || '';
    }
  });

  // Newest first.
  var subs = (listed.data || []).slice().sort(function(a, b) {
    return new Date((b.attributes || {}).created_at) - new Date((a.attributes || {}).created_at);
  });

  // 2) For each submission (newest first), read its answers; keep only the
  //    latest submission per team.
  var latestByTeam = {};   // canonKey → parsed submission
  subs.forEach(function(s) {
    var canonPre = null; // we must read values to know the team
    var vals = lfsFetchJson_('/people/v2/forms/' + formId +
      '/form_submissions/' + s.id + '/form_submission_values?per_page=100');
    if (!vals.ok) return;
    var byField = {};
    (vals.body.data || []).forEach(function(v) {
      var fid = ((((v.relationships || {}).form_field || {}).data) || {}).id;
      var a = v.attributes || {};
      byField[fid] = (a.display_value !== undefined && a.display_value !== null) ? a.display_value : a.value;
    });
    var teamRaw = String(byField[LFS.FIELD.team] || '').trim();
    if (!teamRaw) return;
    var canon = lfsCanonTeam_(teamRaw);
    if (latestByTeam[canon]) return; // already have this team's newest (list is desc)

    var pid = ((((s.relationships || {}).person || {}).data) || {}).id;
    latestByTeam[canon] = {
      canon:      canon,
      teamRaw:    teamRaw,
      submitted:  (s.attributes || {}).created_at || '',
      person:     personName[pid] || '',
      score:      lfsNum_(byField[LFS.FIELD.score]),
      current:    lfsNum_(byField[LFS.FIELD.current]),
      needed:     lfsNum_(byField[LFS.FIELD.needed]),
      why:        String(byField[LFS.FIELD.why]        || '').trim(),
      issues:     String(byField[LFS.FIELD.issues]     || '').trim(),
      resources:  String(byField[LFS.FIELD.resources]  || '').trim(),
      succession: String(byField[LFS.FIELD.succession] || '').trim()
    };
  });

  // 3) Read the Leader Forms tab and index existing rows by canonical team.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(LFS.TAB);
  if (!sh) return { ok: false, error: 'No tab named "' + LFS.TAB + '"' };
  var lastRow = Math.max(1, sh.getLastRow());
  var lastCol = Math.max(11, sh.getLastColumn());
  var grid = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var rowByTeam = {};
  for (var i = 1; i < grid.length; i++) {
    var t = lfsCanonTeam_(grid[i][LFS.COL.team]);
    if (t && !rowByTeam[t]) rowByTeam[t] = i; // 0-based grid index (row = i+1)
  }

  // 4) Plan updates. UPDATE-ONLY by design: we refresh teams already on the
  //    curated tab, and only when the PCO submission is newer. New team names
  //    are reported but never auto-inserted — free-typed answers ("Connect
  //    Desk" vs "Connect") make blind inserts unsafe (duplicate/double-count),
  //    and the 13-team tab is intentionally curated. Add new teams by hand.
  var plan = [];
  var updates = [];        // { rowNum, rowArray }
  var newTeamsSeen = [];   // reported, not written
  Object.keys(latestByTeam).forEach(function(canon) {
    var sub = latestByTeam[canon];
    var gi = rowByTeam[canon];
    if (gi === undefined) {
      newTeamsSeen.push({ team: sub.teamRaw, submitted: sub.submitted, person: sub.person,
                          current: sub.current, moreNeeded: sub.needed });
      plan.push({ team: sub.teamRaw, action: 'new team (not added)', submitted: sub.submitted });
      return;
    }
    var existing = grid[gi];
    var existingDate = new Date(existing[LFS.COL.submitted]);
    var subDate = new Date(sub.submitted);
    var isNewer = !existing[LFS.COL.submitted] || (subDate.getTime() > existingDate.getTime());
    if (!isNewer) {
      plan.push({ team: sub.teamRaw, action: 'skip (not newer)', rowNum: gi + 1,
                  submittedExisting: String(existing[LFS.COL.submitted]), submittedPco: sub.submitted });
      return;
    }
    var rowArray = existing.slice();
    lfsFillRow_(rowArray, sub, false); // preserve team label (C) and From Services (G)
    updates.push({ rowNum: gi + 1, rowArray: rowArray });
    plan.push({
      team: sub.teamRaw, action: 'update', rowNum: gi + 1, person: sub.person,
      submittedOld: String(existing[LFS.COL.submitted]), submittedNew: sub.submitted,
      currentOld: existing[LFS.COL.current], currentNew: sub.current,
      neededOld: existing[LFS.COL.needed], neededNew: sub.needed,
      totalNeededOld: (Number(existing[LFS.COL.current]) || 0) + (Number(existing[LFS.COL.needed]) || 0),
      totalNeededNew: sub.current + sub.needed
    });
  });

  var summary = {
    ok: true, dryRun: dryRun, formId: formId,
    submissionsScanned: subs.length,
    teamsFromPco: Object.keys(latestByTeam).length,
    toUpdate: updates.length,
    toSkip: plan.filter(function(p) { return p.action.indexOf('skip') === 0; }).length,
    newTeamsSeen: newTeamsSeen,
    plan: plan
  };

  if (dryRun) return summary;

  // 5) Apply updates in place (whole row, preserving team label C & From Services G).
  updates.forEach(function(u) {
    sh.getRange(u.rowNum, 1, 1, u.rowArray.length).setValues([u.rowArray]);
  });
  summary.applied = true;
  summary.rowsUpdated = updates.length;
  return summary;
}

// Fill a row array from a parsed submission. When isInsert, also set the team
// label (col C); on updates the existing label + From Services (G) are kept.
function lfsFillRow_(row, sub, isInsert) {
  row[LFS.COL.submitted]  = sub.submitted;
  row[LFS.COL.person]     = sub.person;
  if (isInsert) row[LFS.COL.team] = sub.teamRaw;
  row[LFS.COL.score]      = sub.score;
  row[LFS.COL.current]    = sub.current;
  row[LFS.COL.needed]     = sub.needed;
  row[LFS.COL.why]        = sub.why;
  row[LFS.COL.issues]     = sub.issues;
  row[LFS.COL.resources]  = sub.resources;
  row[LFS.COL.succession] = sub.succession;
  return row;
}

function lfsBlankRow_(len) {
  var r = [];
  for (var i = 0; i < len; i++) r.push('');
  return r;
}

function lfsNum_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}

// Canonicalize a team name so free-typed form answers match tab rows.
function lfsCanonTeam_(s) {
  var k = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  var A = {
    'connect': 'connect', 'connection': 'connect', 'connections': 'connect', 'connect team': 'connect',
    'safety': 'safety', 'safety team': 'safety',
    'worship': 'worship and tech', 'tech': 'worship and tech', 'worship tech': 'worship and tech',
    'worship and tech': 'worship and tech', 'production': 'worship and tech', 'tech team': 'worship and tech', 'worship team': 'worship and tech',
    'first impression': 'first impressions', 'first impressions': 'first impressions',
    'ls students': 'ls students', 'students': 'ls students', 'ls student': 'ls students', 'student ministry': 'ls students',
    'ls kids': 'ls kids', 'kids': 'ls kids', 'stepping stones': 'stepping stones',
    'coffee': 'coffee team', 'coffee team': 'coffee team',
    'breakfast': 'breakfast team', 'breakfast team': 'breakfast team',
    'prayer': 'prayer team', 'prayer team': 'prayer team',
    'parking': 'parking', 'parking team': 'parking',
    'hospitality': 'hospitality', 'hospitality team': 'hospitality',
    'enrichment': 'enrichment',
    'presiders': 'presiders', 'presider': 'presiders',
    'service captains': 'service captains', 'service captain': 'service captains'
  };
  return A[k] || k;
}

// Paginating GET that returns { ok, data, included }.
function lfsGetAll_(path) {
  var url = path.indexOf('http') === 0 ? path : 'https://api.planningcenteronline.com' + path;
  var out = { ok: true, data: [], included: [] };
  var pages = 0;
  while (url) {
    var r = lfsFetchJson_(url);
    if (!r.ok) return { ok: false, code: r.code, error: r.error, data: out.data, included: out.included };
    if (r.body.data)     out.data.push.apply(out.data, r.body.data);
    if (r.body.included) out.included.push.apply(out.included, r.body.included);
    url = (r.body.links && r.body.links.next) ? r.body.links.next : null;
    if (++pages > 50) break;
  }
  return out;
}

/* =========================================================
   Small safe JSON fetcher for PCO (captures errors as data
   instead of throwing, so discovery returns partial results).
========================================================= */

function lfsFetchJson_(path) {
  var url = path.indexOf('http') === 0 ? path : 'https://api.planningcenteronline.com' + path;
  try {
    Utilities.sleep(200);
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: pcoHeaders_() });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code < 200 || code >= 300) {
      return { ok: false, code: code, error: text.slice(0, 300) };
    }
    return { ok: true, code: code, body: JSON.parse(text) };
  } catch (e) {
    return { ok: false, code: 0, error: String(e) };
  }
}
