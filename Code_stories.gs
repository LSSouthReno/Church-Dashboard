/**
 * Stories — "Share a Community Group Story" PCO People form → Staff dashboard.
 * ==========================================================================
 * Pulls submissions of PCO form 1324853 into a private "Stories" tab of the bound
 * spreadsheet (never into the public dashboard JSON), optionally tidies each one into
 * a story card with Claude (title, summary, lightly edited story, pull quote, tags,
 * suggested follow-up), and serves them to the Staff area:
 *   • Stories tab (sp-stories)            → GET  story_list
 *   • Staff Sync "New stories" block       → same data, filtered to since last Monday
 *   • status / notes / edits from staff    → POST story_update
 *
 * Reads/writes require k = the staff password hash (STAFF_HASH in index.html).
 * Sync runs on a 15-minute trigger (storySyncTick, self-installed on the first sync)
 * and on demand (GET story_sync). Claude formatting is optional: Script Property
 * ANTHROPIC_API_KEY. Without it the story is stored as written.
 *
 * Isolated file: dispatched from Code_eos_webapp.gs doGet/doPost via STORY_*_ACTIONS_.
 * Reuses lfsGetAll_ / lfsFetchJson_ (Code_leader_forms_sync.gs) and eosWaJson_.
 */

var STORY_ = {
  FORM_ID: '1324853',
  TAB: 'Stories',
  SS_ID: '1kueJyrRjDQHZ6vAuipltf1AYKsn_hjOlPtjwNmG9psA',   // bound "Church Dashboard auto" sheet
  KEY: 'ac7f5a10683437edf6618ad90f38b43db60dd2b43a4e23fbae0dc9d58bda56f8',
  MODEL: 'claude-opus-5',
  MAX_PER_RUN: 10
};
var STORY_GET_ACTIONS_  = ['story_list', 'story_sync', 'story_inspect'];
var STORY_POST_ACTIONS_ = ['story_update'];
var STORY_HDRS_ = ['id', 'submittedAt', 'person', 'personId', 'email', 'cgLeader', 'doNotShare', 'title', 'summary',
                   'story', 'pullQuote', 'tags', 'followUp', 'raw', 'status', 'notes', 'aiFormatted', 'updatedAt', 'updatedBy'];
var STORY_EDITABLE_ = ['status', 'title', 'summary', 'story', 'pullQuote', 'notes', 'followUp'];
var STORY_STATUSES_ = ['new', 'reviewed', 'shared', 'archived'];

function storyDoGet_(e) {
  var p = (e && e.parameter) || {};
  if (String(p.k || '') !== STORY_.KEY) return eosWaJson_({ ok: false, error: 'Not authorized' });
  if (p.action === 'story_list') return eosWaJson_(storyList_());
  if (p.action === 'story_sync') { var r = syncStories_(); r.list = storyList_(); return eosWaJson_(r); }
  if (p.action === 'story_inspect') return eosWaJson_(storyInspect_());
  return eosWaJson_({ ok: false, error: 'Unknown story action' });
}

function storyDoPost_(body) {
  if (String(body.k || '') !== STORY_.KEY) return eosWaJson_({ ok: false, error: 'Not authorized' });
  if (body.action === 'story_update') return eosWaJson_(storyUpdate_(body));
  return eosWaJson_({ ok: false, error: 'Unknown story action' });
}

/** Trigger handler (public name so the time trigger can call it). */
function storySyncTick() { syncStories_(); }

function storyEnsureTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'storySyncTick'; });
  if (!has) ScriptApp.newTrigger('storySyncTick').timeBased().everyMinutes(15).create();
  return !has;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet
// ─────────────────────────────────────────────────────────────────────────────
function storySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(STORY_.SS_ID);
  var sh = ss.getSheetByName(STORY_.TAB);
  if (!sh) {
    sh = ss.insertSheet(STORY_.TAB);
    sh.appendRow(STORY_HDRS_);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), STORY_HDRS_.length).setNumberFormat('@');
  }
  return sh;
}

function storyRows_() {
  var sh = storySheet_(), data = sh.getDataRange().getValues(), out = [];
  for (var r = 1; r < data.length; r++) {
    var o = {};
    STORY_HDRS_.forEach(function (h, i) { var v = data[r][i]; o[h] = v instanceof Date ? v.toISOString() : String(v); });
    if (!o.id) continue;
    try { o.tags = JSON.parse(o.tags || '[]'); } catch (x) { o.tags = []; }
    o.doNotShare = o.doNotShare === 'yes';
    out.push(o);
  }
  return out;
}

function storyList_() {
  var rows = storyRows_();
  rows.sort(function (a, b) { return a.submittedAt < b.submittedAt ? 1 : -1; });
  var props = PropertiesService.getScriptProperties();
  return { ok: true, stories: rows, lastSync: props.getProperty('STORY_LAST_SYNC') || '',
           aiOn: !!props.getProperty('ANTHROPIC_API_KEY'),
           formUrl: 'https://lssr.churchcenter.com/people/forms/' + STORY_.FORM_ID };
}

// Writes only the changed cells, so a running sync (append-only) never collides with an edit.
function storyUpdate_(body) {
  var sh = storySheet_(), ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var r = 1; r < ids.length; r++) {
    if (String(ids[r][0]) !== String(body.id)) continue;
    var set = function (h, v) { sh.getRange(r + 1, STORY_HDRS_.indexOf(h) + 1).setValue(v); };
    STORY_EDITABLE_.forEach(function (h) {
      if (body[h] == null) return;
      var v = String(body[h]).substring(0, 40000);
      if (h === 'status' && STORY_STATUSES_.indexOf(v) < 0) return;
      set(h, v);
    });
    set('updatedAt', new Date().toISOString());
    set('updatedBy', String(body.by || 'staff').substring(0, 80));
    return { ok: true };
  }
  return { ok: false, error: 'Story not found' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PCO → sheet
// ─────────────────────────────────────────────────────────────────────────────
// Field ids are resolved by label, so the form can be renamed or re-ordered freely.
function storyFormFields_() {
  var res = lfsGetAll_('/people/v2/forms/' + STORY_.FORM_ID + '/fields?per_page=100');
  if (!res.ok) throw new Error('form fields: ' + res.code + ' ' + res.error);
  var map = { leader: '', story: '', noShare: '', all: [] };
  (res.data || []).forEach(function (f) {
    var a = f.attributes || {}, label = String(a.label || ''), type = String(a.field_type || '');
    map.all.push({ id: f.id, label: label, type: type });
    if (!map.noShare && /(not|n't)\s+want|do not share|don.t share|keep (it )?private/i.test(label)) map.noShare = f.id;
    else if (!map.leader && /leader/i.test(label)) map.leader = f.id;
    else if (!map.story && /story/i.test(label) && !/share/i.test(label)) map.story = f.id;
  });
  return map;
}

function syncStories_() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (x) { return { ok: true, skipped: 'busy' }; }
  try {
    var installed = storyEnsureTrigger_();
    var sh = storySheet_(), have = {};
    storyRows_().forEach(function (s) { have[s.id] = 1; });
    var fields = storyFormFields_();
    if (!fields.story) return { ok: false, error: 'Could not find the story field on form ' + STORY_.FORM_ID, fields: fields.all };

    var listed = lfsGetAll_('/people/v2/forms/' + STORY_.FORM_ID + '/form_submissions?per_page=100&include=person');
    if (!listed.ok) return { ok: false, step: 'list submissions', error: listed.error, code: listed.code };
    var people = {};
    (listed.included || []).forEach(function (inc) {
      if (String(inc.type).toLowerCase() !== 'person') return;
      var a = inc.attributes || {};
      people[inc.id] = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ');
    });
    var subs = (listed.data || []).filter(function (s) { return !have['fs_' + s.id]; })
      .sort(function (a, b) { return String((a.attributes || {}).created_at) < String((b.attributes || {}).created_at) ? -1 : 1; });

    var added = 0, pending = 0;
    for (var i = 0; i < subs.length; i++) {
      if (added >= STORY_.MAX_PER_RUN) { pending = subs.length - i; break; }
      var s = subs[i];
      var vals = lfsFetchJson_('/people/v2/forms/' + STORY_.FORM_ID + '/form_submissions/' + s.id + '/form_submission_values?per_page=100');
      if (!vals.ok) continue;
      var by = {};
      (vals.body.data || []).forEach(function (v) {
        var fid = ((((v.relationships || {}).form_field || {}).data) || {}).id;
        var a = v.attributes || {};
        by[fid] = (a.display_value != null && a.display_value !== '') ? a.display_value : a.value;
      });
      var pid = ((((s.relationships || {}).person || {}).data) || {}).id || '';
      var noShare = String(by[fields.noShare] || '').trim();
      var row = {
        id: 'fs_' + s.id,
        submittedAt: (s.attributes || {}).created_at || '',
        person: people[pid] || '', personId: pid, email: storyEmailOf_(vals.body.data),
        cgLeader: String(by[fields.leader] || '').trim(),
        doNotShare: (noShare && !/^(false|no|0)$/i.test(noShare)) ? 'yes' : 'no',
        raw: String(by[fields.story] || '').trim(), status: 'new', notes: '',
        updatedAt: new Date().toISOString(), updatedBy: 'pco'
      };
      var f = storyFormat_(row);
      row.title = f.title; row.summary = f.summary; row.story = f.story; row.pullQuote = f.pullQuote;
      row.tags = JSON.stringify(f.tags || []); row.followUp = f.followUp; row.aiFormatted = f.ai ? 'yes' : 'no';
      sh.appendRow(STORY_HDRS_.map(function (h) { return row[h] == null ? '' : String(row[h]); }));
      have[row.id] = 1; added++;
    }
    PropertiesService.getScriptProperties().setProperty('STORY_LAST_SYNC', new Date().toISOString());
    return { ok: true, added: added, pending: pending, total: (listed.data || []).length, triggerInstalled: installed };
  } finally {
    lock.releaseLock();
  }
}

function storyEmailOf_(values) {
  var hit = '';
  (values || []).some(function (v) {
    var a = v.attributes || {};
    var m = String(a.display_value || a.value || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (m) { hit = m[0]; return true; }
    return false;
  });
  return hit;
}

/** Read-only: resolved form fields + the latest submission's values, for checking the mapping. */
function storyInspect_() {
  var fields = storyFormFields_();
  var listed = lfsFetchJson_('/people/v2/forms/' + STORY_.FORM_ID + '/form_submissions?per_page=3&order=-created_at');
  var sample = [];
  if (listed.ok && listed.body.data && listed.body.data[0]) {
    var v = lfsFetchJson_('/people/v2/forms/' + STORY_.FORM_ID + '/form_submissions/' + listed.body.data[0].id + '/form_submission_values?per_page=100');
    if (v.ok) sample = (v.body.data || []).map(function (x) {
      var a = x.attributes || {};
      return { field: ((((x.relationships || {}).form_field || {}).data) || {}).id,
               value: String(a.display_value != null ? a.display_value : a.value).substring(0, 60) };
    });
  }
  return { ok: true, fields: fields, submissions: listed.ok ? (listed.body.meta || {}).total_count : listed.error, sample: sample,
           aiOn: !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude formatting (optional)
// ─────────────────────────────────────────────────────────────────────────────
var STORY_SCHEMA_ = {
  type: 'object',
  properties: {
    title:     { type: 'string' },
    summary:   { type: 'string' },
    story:     { type: 'string' },
    pullQuote: { type: 'string' },
    tags:      { type: 'array', items: { type: 'string' } },
    followUp:  { type: 'string' }
  },
  required: ['title', 'summary', 'story', 'pullQuote', 'tags', 'followUp'],
  additionalProperties: false
};

var STORY_SYSTEM_ =
  'You help the staff of Living Stones Church South Reno (Reno, NV) collect stories of what God is doing through their ' +
  'Community Groups (small groups that meet in homes). Members submit these through a "Share a Community Group Story" form. ' +
  'Turn each submission into a story card the staff can read in a few seconds and later share with the church.\n\n' +
  'Fields:\n' +
  '- title: a warm headline of 3–8 words, no quotation marks, no emoji.\n' +
  '- summary: 1–2 plain sentences a busy pastor can scan.\n' +
  '- story: the story itself, lightly edited — keep the writer\'s voice and point of view (first person stays first person), ' +
  'fix spelling, grammar and run-on formatting, and split it into short paragraphs separated by a blank line. ' +
  'Never add details, quotes, feelings or Scripture that are not in the submission.\n' +
  '- pullQuote: one short sentence copied word-for-word from the submission that captures its heart, or an empty string.\n' +
  '- tags: 0–4 short lowercase themes (e.g. "prayer", "new members", "meals", "baptism", "serving together").\n' +
  '- followUp: one short suggested next step for staff (e.g. "Thank the group leader; ask to share on a Sunday"), or an empty string.';

function storyFormat_(row) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (key && row.raw) {
    try { var out = storyClaude_(key, row); out.ai = true; return out; }
    catch (e) { Logger.log('Story format failed: ' + e); }
  }
  var body = String(row.raw || '').trim();
  var first = (body.match(/^[\s\S]{20,240}?[.!?](\s|$)/) || [body.substring(0, 200)])[0].trim();
  return { title: body.split(/\s+/).slice(0, 7).join(' ').replace(/[.,;:!?]+$/, '') || 'A new story', summary: first,
           story: body, pullQuote: '', tags: [], followUp: '', ai: false };
}

function storyClaude_(key, row) {
  var user = 'Submitted by: ' + (row.person || 'unknown') + '\nCommunity Group leader: ' + (row.cgLeader || 'unknown') +
             '\n\n<submission>\n' + String(row.raw).substring(0, 30000) + '\n</submission>';
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    payload: JSON.stringify({
      model: STORY_.MODEL, max_tokens: 16000, fallbacks: 'default', system: STORY_SYSTEM_,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: STORY_SCHEMA_ } },
      messages: [{ role: 'user', content: user }]
    })
  });
  var code = resp.getResponseCode(), txt = resp.getContentText();
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + txt.substring(0, 300));
  var j = JSON.parse(txt);
  if (j.stop_reason === 'refusal' || j.stop_reason === 'max_tokens') throw new Error('stop_reason ' + j.stop_reason);
  var block = (j.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!block) throw new Error('no text block');
  return JSON.parse(block.text);
}
