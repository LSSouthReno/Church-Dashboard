/**
 * Pastor Shepherding — live detail + write-back actions (web app)
 *
 * Called from the password-gated Shepherding page:
 *   shepPersonDetail_(pid)  → live notes (by category), all custom fields (by tab),
 *                              form submissions + answers, New Family Member workflow status
 *   shepUpdate_(params)     → write a shepherding field back to PCO (health status +
 *                              auto-date, assigned elder / pastor, spiritual maturity, etc.)
 *   shepWorkflow_(params)   → view / add / advance the New Family Member workflow card
 *
 * All are reached only after the web app verifies the password hash
 * (SHEPHERDING_PW_HASH). Writes go through PCO's API as the deploying user.
 */

var SH_WF_BAPTISM = '528797';                    // "Baptism Ready" workflow
var SH_NOTE_HIDE = { '286191': 1 };              // "Text In Church Activity" (auto SMS noise)
var SH_NOTE_PRIORITY = { '239853':3, '239854':3, '234652':2, '239856':2 }; // Pastoral Care/Red Flag/Prayer/Leadership
// Note categories offered in the drawer's "add note" dropdown (id → label).
var SH_NOTE_CATEGORIES = [
  { id:'239853', name:'Pastoral Care' }, { id:'234652', name:'Prayer Requests' },
  { id:'239854', name:'Red Flag' }, { id:'239856', name:'Leadership Potential' },
  { id:'234651', name:'General' }
];

function shApiBase_() { return 'https://api.planningcenteronline.com'; }

function shGet_(path) {
  var res = UrlFetchApp.fetch(shApiBase_() + path, { method:'get', muteHttpExceptions:true, headers: pcoHeaders_() });
  var code = res.getResponseCode();
  var json = null; try { json = JSON.parse(res.getContentText()); } catch (e) {}
  return { code: code, json: json };
}
function shWrite_(method, path, body) {
  var res = UrlFetchApp.fetch(shApiBase_() + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: pcoHeaders_(), payload: JSON.stringify(body)
  });
  var code = res.getResponseCode();
  var json = null; try { json = JSON.parse(res.getContentText()); } catch (e) {}
  return { code: code, json: json, raw: res.getContentText() };
}

/* =========================================================
   LIVE PERSON DETAIL
========================================================= */
function shepPersonDetail_(pid) {
  pid = String(pid || '');
  if (!pid) return { error: 'missing pid' };
  var out = { pid: pid };

  // Field definition id → {name, tab} — single page each (no 250ms-per-page pagination).
  var defs = {}, tabName = {};
  var t1 = shGet_('/people/v2/tabs?per_page=100');
  ((t1.json&&t1.json.data)||[]).forEach(function(t){ tabName[t.id]=(t.attributes||{}).name; });
  var fdef = shGet_('/people/v2/field_definitions?per_page=100');
  ((fdef.json&&fdef.json.data)||[]).forEach(function(d){
    var a=d.attributes||{}; defs[d.id]={ name:a.name, tab: tabName[(((d.relationships||{}).tab||{}).data||{}).id]||'' };
  });

  // Custom fields grouped by tab (1 call)
  out.fields = {};
  var fdres = shGet_('/people/v2/people/'+pid+'/field_data?per_page=100');
  ((fdres.json&&fdres.json.data)||[]).forEach(function(r){
    var defId=(((r.relationships||{}).field_definition||{}).data||{}).id;
    var v=(r.attributes||{}).value; if (v==null || String(v).trim()==='') return;
    var d=defs[defId]||{name:(r.attributes||{}).label||'Field',tab:'Other'};
    (out.fields[d.tab||'Other']=out.fields[d.tab||'Other']||[]).push({ name:d.name, value:String(v) });
  });

  // Notes — most recent 100 in ONE page, drop auto text-activity, cap 50 (1-2 calls)
  var cats = {};
  var nc = shGet_('/people/v2/note_categories?per_page=100');
  ((nc.json&&nc.json.data)||[]).forEach(function(c){ cats[c.id]=(c.attributes||{}).name; });
  // Person-scoped endpoint — the global /notes?where[person_id] filter is ignored
  // by PCO and returns everyone's notes.
  var nres = shGet_('/people/v2/people/'+pid+'/notes?per_page=100&order=-created_at');
  out.notes = (((nres.json&&nres.json.data)||[]).filter(function(nt){ return !SH_NOTE_HIDE[String((nt.attributes||{}).note_category_id||'')]; })
    .map(function(nt){ var a=nt.attributes||{}; var cid=String(a.note_category_id||'');
      return { category: cats[cid]||'General', priority: SH_NOTE_PRIORITY[cid]||1, note:a.note||'', date:a.display_date||a.created_at||'' }; })
    .sort(function(a,b){ return (b.priority-a.priority) || String(b.date).localeCompare(String(a.date)); })).slice(0, 50);

  // Forms — recent 8 submissions. Question LABELS live on the form's fields
  // (include=form_field returns nothing), so fetch each unique form's fields
  // once (concurrently) to map field id → question label, then the answer sets.
  out.forms = [];
  var fsres = shGet_('/people/v2/people/'+pid+'/form_submissions?include=form&per_page=40');
  if (fsres.json && fsres.json.data) {
    var formName = {}; (fsres.json.included||[]).forEach(function(f){ if(f.type==='Form') formName[f.id]=(f.attributes||{}).name; });
    var allSubs = fsres.json.data.slice();
    // Application forms (esp. Family Member Application) always surface first, then most recent.
    var isApp = function(sub){ var n=formName[(((sub.relationships||{}).form||{}).data||{}).id]||''; return /application/i.test(n); };
    allSubs.sort(function(a,b){ return (isApp(b)?1:0)-(isApp(a)?1:0); });
    var subs = allSubs.slice(0, 10);
    var formIds = subs.map(function(s){ return (((s.relationships||{}).form||{}).data||{}).id; })
      .filter(function(v,i,a){ return v && a.indexOf(v)===i; });
    // Field labels per unique form
    var labelByForm = {};
    var fieldPages = fgBatchFetch_(formIds.map(function(fid){ return '/people/v2/forms/'+fid+'/fields?per_page=100'; }), new Date().getTime());
    formIds.forEach(function(fid, i){ var m={}; ((fieldPages[i]&&fieldPages[i].data)||[]).forEach(function(f){ m[f.id]=(f.attributes||{}).label; }); labelByForm[fid]=m; });
    // Answer values per submission
    var valPages = fgBatchFetch_(subs.map(function(sub){ var fid=(((sub.relationships||{}).form||{}).data||{}).id;
      return '/people/v2/forms/'+fid+'/form_submissions/'+sub.id+'/form_submission_values?per_page=100'; }), new Date().getTime());
    out.forms = subs.map(function(sub, i){
      var fid=(((sub.relationships||{}).form||{}).data||{}).id;
      var labels = labelByForm[fid]||{};
      var page = valPages[i]; var answers = [];
      if (page && page.data) {
        answers = page.data.map(function(v){ var a=v.attributes||{}; var lid=(((v.relationships||{}).form_field||{}).data||{}).id;
          return { label: labels[lid]||'', value: a.display_value!=null?String(a.display_value):(a.value!=null?String(a.value):'') }; })
          .filter(function(x){ return x.value!==''; });
      }
      return { form: formName[fid]||'Form', date:(sub.attributes||{}).created_at||'', answers: answers };
    });
  }

  out.workflow = shWorkflowStatus_(pid, 'baptism');
  out.familyWorkflow = shWorkflowStatus_(pid, 'family');
  out.noteCategories = SH_NOTE_CATEGORIES;
  return out;
}

/* =========================================================
   WRITE-BACK: shepherding fields
   params: pid, field (health|healthDate|elder|maturity|known|deaconSupport|deaconNotes), value
========================================================= */
function shepUpdate_(params) {
  var pid = String(params.pid||'');
  var field = String(params.field||'');
  var value = params.value != null ? String(params.value) : '';
  var by = String(params.by||'');
  if (!pid || !field) return { error: 'missing pid/field' };

  // Membership status is a core Person attribute, not a custom field.
  if (field === 'membership') {
    var wm = shWrite_('patch', '/people/v2/people/'+pid, { data:{ type:'Person', id:pid, attributes:{ membership: value } } });
    var okm = wm.code>=200 && wm.code<300;
    if (okm) { spLogChange_(by, pid, 'membership', value); spUpsertOverride_(pid, 'membership', value, by); }
    return { field:field, ok:okm, code:wm.code, detail: okm?null:(wm.raw||'').substring(0,300) };
  }

  var map = { health:SH_FIELD.healthAssess, healthDate:SH_FIELD.healthDate, elder:SH_FIELD.assignedElder,
              maturity:SH_FIELD.spiritualMat, pref:SH_FIELD.preferredComm, known:SH_FIELD.known,
              deaconSupport:SH_FIELD.deaconSupport, deaconNotes:SH_FIELD.deaconNotes };
  var defId = map[field];
  if (!defId) return { error: 'unknown field ' + field };

  var r = shSetFieldDatum_(pid, defId, value);
  var result = { field: field, ok: r.ok, code: r.code };

  if (r.ok) {
    spLogChange_(by, pid, field, value);
    spUpsertOverride_(pid, field, value, by);   // show instantly + survive reload until next sync
    // Track that Spiritual Maturity was set manually from the dashboard (or clear it).
    if (field === 'maturity') {
      if (value) { spSetManualMaturity_(pid, by); result.maturityManual = { by:by, date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') }; }
      else spClearManualMaturity_(pid);
    }
    // Setting health status also stamps Health Assessment Date = today.
    if (field === 'health' && !params.skipDate) {
      var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      var d = shSetFieldDatum_(pid, SH_FIELD.healthDate, today);
      result.healthDateSet = d.ok ? today : false;
    }
  } else result.detail = r.detail;
  return result;
}

/* ── Pending-edit overlay: one row per (pid, field), newest value wins ── */
function spUpsertOverride_(pid, field, value, by) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SH_OVERRIDES_SHEET) || ss.insertSheet(SH_OVERRIDES_SHEET);
    try { sh.hideSheet(); } catch (e) {}
    var last = sh.getLastRow();
    var rows = last ? sh.getRange(1,1,last,2).getValues() : [];
    var row = 0; for (var i=0;i<rows.length;i++){ if (String(rows[i][0])===String(pid) && String(rows[i][1])===String(field)) { row=i+1; break; } }
    var rec = [String(pid), String(field), String(value), by||'', new Date().toISOString()];
    if (row) sh.getRange(row,1,1,5).setValues([rec]);
    else sh.appendRow(rec);
  } catch (e) {}
}

/* ── Change log + manual-maturity store ── */
function spLogChange_(by, pid, field, value) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SH_CHANGELOG_SHEET) || ss.insertSheet(SH_CHANGELOG_SHEET);
    try { sh.hideSheet(); } catch (e) {}
    sh.appendRow([ new Date().toISOString(), by||'(unknown)', pid, field, String(value).substring(0,200) ]);
  } catch (e) {}
}
function spSetManualMaturity_(pid, by) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SH_MANUAL_SHEET) || ss.insertSheet(SH_MANUAL_SHEET);
    try { sh.hideSheet(); } catch (e) {}
    var last = sh.getLastRow();
    var rows = last ? sh.getRange(1,1,last,1).getValues() : [];
    var row = 0; for (var i=0;i<rows.length;i++){ if (String(rows[i][0])===String(pid)) { row=i+1; break; } }
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (row) sh.getRange(row,1,1,3).setValues([[pid, by||'', today]]);
    else sh.appendRow([pid, by||'', today]);
  } catch (e) {}
}
function spClearManualMaturity_(pid) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_MANUAL_SHEET);
    if (!sh) return;
    var last = sh.getLastRow(); if (!last) return;
    var rows = sh.getRange(1,1,last,1).getValues();
    for (var i=0;i<rows.length;i++){ if (String(rows[i][0])===String(pid)) { sh.deleteRow(i+1); return; } }
  } catch (e) {}
}

// PATCH existing datum or POST-create. Returns {ok, code, detail}.
function shSetFieldDatum_(pid, defId, value) {
  var existing = shGet_('/people/v2/people/'+pid+'/field_data?per_page=100');
  var fdId = null;
  if (existing.json && existing.json.data) {
    existing.json.data.forEach(function(fd){
      if (String((((fd.relationships||{}).field_definition||{}).data||{}).id) === String(defId)) fdId = fd.id;
    });
  }
  // Empty value → clear the field (DELETE the datum). PCO rejects blank on select fields.
  if (value === '' || value == null) {
    if (!fdId) return { ok:true, code:204 };
    var del = shWrite_('delete', '/people/v2/field_data/'+fdId, {});
    var okd = del.code>=200 && del.code<300;
    return { ok:okd, code:del.code, detail: okd?null:(del.raw||'').substring(0,300) };
  }
  var w;
  if (fdId) {
    w = shWrite_('patch', '/people/v2/field_data/'+fdId,
      { data:{ type:'FieldDatum', id:fdId, attributes:{ value:value } } });
  } else {
    w = shWrite_('post', '/people/v2/people/'+pid+'/field_data',
      { data:{ type:'FieldDatum', attributes:{ value:value },
               relationships:{ field_definition:{ data:{ type:'FieldDefinition', id:String(defId) } } } } });
  }
  var ok = w.code>=200 && w.code<300;
  return { ok:ok, code:w.code, detail: ok?null:(w.raw||'').substring(0,300) };
}

/* =========================================================
   WORKFLOWS: Baptism Ready (528797) + New Family Member (528798)
   params: pid, wf (baptism|family), op (view|add|advance|back|remove), cardId?
========================================================= */
var SH_WF_FAMILY = '528798';
function shWfId_(wf) { return wf==='family' ? SH_WF_FAMILY : SH_WF_BAPTISM; }
function shWfLabel_(wf) { return wf==='family' ? 'New Family Member' : 'Baptism Ready'; }

function shWorkflowStatus_(pid, wf) {
  var wfId = shWfId_(wf);
  try {
    var res = pcoGetAllWithIncluded_('/people/v2/people/'+pid+'/workflow_cards?include=current_step,workflow&per_page=50');
    var stepName={};
    (res.included||[]).forEach(function(x){ if (x.type==='WorkflowStep') stepName[x.id]=(x.attributes||{}).name; });
    var cards = (res.data||[]).filter(function(c){ return String((((c.relationships||{}).workflow||{}).data||{}).id)===wfId; });
    var completed = cards.some(function(c){ return String((c.attributes||{}).stage)==='completed'; });
    var active = cards.filter(function(c){ return String((c.attributes||{}).stage)!=='completed'; })[0];
    var steps = (pcoGetAll_('/people/v2/workflows/'+wfId+'/steps?per_page=100')||[])
      .map(function(s){ return { id:s.id, name:(s.attributes||{}).name, seq:(s.attributes||{}).sequence }; })
      .sort(function(a,b){ return (a.seq||0)-(b.seq||0); });
    var out = { workflow: shWfLabel_(wf), wf: (wf||'baptism'), inWorkflow: cards.length>0, completed: completed, steps: steps };
    if (active) {
      var curId=(((active.relationships||{}).current_step||{}).data||{}).id;
      out.cardId=active.id; out.stage=(active.attributes||{}).stage; out.currentStep=stepName[curId]||''; out.currentStepId=curId;
    } else if (completed) {
      out.completedAt = cards.filter(function(c){return String((c.attributes||{}).stage)==='completed';})[0].attributes.completed_at || '';
    }
    return out;
  } catch (e) { return { error: e.message }; }
}

// Are the membership essentials in place to COMPLETE the New Family Member process?
// Reads current PCO values (which already reflect any just-saved dashboard edits).
function shCompletionReady_(pid) {
  var res = shGet_('/people/v2/people/'+pid+'?include=field_data');
  var mt = '', fd = {};
  if (res.json && res.json.data) {
    mt = String((res.json.data.attributes||{}).membership||'');
    (res.json.included||[]).forEach(function(x){
      if (x.type==='FieldDatum') { var def=(((x.relationships||{}).field_definition||{}).data||{}).id; fd[def]=(x.attributes||{}).value; }
    });
  }
  var missing = [];
  if (!fd[SH_FIELD.healthAssess]) missing.push('Health status');
  if (!/member|deacon|pastor/i.test(mt)) missing.push('Membership = Member');
  if (!fd[SH_FIELD.assignedElder]) missing.push('Shepherding pastor');
  if (String(fd[SH_FIELD.known]||'').toLowerCase() !== 'true') missing.push('Known? = Yes');
  return { ready: missing.length===0, missing: missing };
}

function shepWorkflow_(params) {
  var pid = String(params.pid||''), op = String(params.op||'view'), wf = String(params.wf||'baptism');
  var wfId = shWfId_(wf);
  if (!pid) return { error:'missing pid' };
  if (op === 'view') return shWorkflowStatus_(pid, wf);

  if (op === 'add') {
    var w = shWrite_('post', '/people/v2/workflows/'+wfId+'/cards', { data:{ relationships:{ person:{ data:{ type:'Person', id:pid } } } } });
    var oka=(w.code>=200&&w.code<300); if(oka) spLogChange_(String(params.by||''), pid, wf+'-workflow', 'added');
    return { op:'add', ok:oka, code:w.code, detail:(w.code>=300?(w.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid, wf) };
  }
  var st = shWorkflowStatus_(pid, wf);
  var cardId = params.cardId || st.cardId;
  if (!cardId) return { error:'no active card', status:st };
  if (op === 'remove') {
    var wr = shWrite_('delete', '/people/v2/workflows/'+wfId+'/cards/'+cardId, {});
    if (wr.code === 404 || wr.code === 405) wr = shWrite_('post', '/people/v2/workflows/'+wfId+'/cards/'+cardId+'/remove', { data:{} });
    var okr=(wr.code>=200&&wr.code<300); if(okr) spLogChange_(String(params.by||''), pid, wf+'-workflow', 'removed');
    return { op:'remove', ok:okr, code:wr.code, detail:(wr.code>=300?(wr.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid, wf) };
  }
  if (op === 'advance' || op === 'back') {
    // Completing the FINAL step of the New Family Member process requires the
    // membership essentials be filled in first (health, membership, pastor, Known).
    if (op==='advance' && wf==='family') {
      var steps = st.steps||[];
      var curIdx = steps.reduce(function(a,s,i){ return String(s.id)===String(st.currentStepId)?i:a; }, -1);
      if (curIdx>=0 && curIdx >= steps.length-1) {
        var chk = shCompletionReady_(pid);
        if (!chk.ready) return { op:op, ok:false, blocked:true, missing:chk.missing, status:st };
      }
    }
    var action = op==='back' ? 'go_back' : 'promote';
    var w2 = shWrite_('post', '/people/v2/workflows/'+wfId+'/cards/'+cardId+'/'+action, { data:{} });
    if (w2.code === 404) w2 = shWrite_('post', '/people/v2/workflow_cards/'+cardId+'/'+action, { data:{} });
    var ok2=(w2.code>=200&&w2.code<300); if(ok2) spLogChange_(String(params.by||''), pid, wf+'-workflow', op);
    return { op:op, ok:ok2, code:w2.code, detail:(w2.code>=300?(w2.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid, wf) };
  }
  return { error:'unknown op ' + op };
}

/* =========================================================
   ADD NOTE (pastoral care / other) → PCO
   params: pid, category (note_category id), body
========================================================= */
function shepAddNote_(params) {
  var pid = String(params.pid||''), catId = String(params.category||'239853'), body = String(params.body||'').trim();
  if (!pid || !body) return { error:'missing pid/body' };
  var payload = { data:{ attributes:{ note: body },
    relationships:{ note_category:{ data:{ type:'NoteCategory', id: catId } } } } };
  var w = shWrite_('post', '/people/v2/people/'+pid+'/notes', payload);
  var ok = w.code>=200 && w.code<300;
  if (ok) spLogChange_(String(params.by||''), pid, 'note-added', body.substring(0,60));
  return { ok:ok, code:w.code, detail: ok?null:(w.raw||'').substring(0,300),
           note: ok && w.json && w.json.data ? { id:w.json.data.id } : null };
}
