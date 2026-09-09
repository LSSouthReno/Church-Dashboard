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

var SH_WF_NEW_FAMILY = '528798';                 // "New Family Member" workflow
var SH_NOTE_HIDE = { '286191': 1 };              // "Text In Church Activity" (auto SMS noise)
var SH_NOTE_PRIORITY = { '239853':3, '239854':3, '234652':2, '239856':2 }; // Pastoral Care/Red Flag/Prayer/Leadership

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

  // Forms — recent 8 submissions; fetch their answer sets CONCURRENTLY (fgBatchFetch_)
  out.forms = [];
  var fsres = shGet_('/people/v2/people/'+pid+'/form_submissions?include=form&per_page=25');
  if (fsres.json && fsres.json.data) {
    var formName = {}; (fsres.json.included||[]).forEach(function(f){ if(f.type==='Form') formName[f.id]=(f.attributes||{}).name; });
    var subs = fsres.json.data.slice(0, 8);
    var paths = subs.map(function(sub){ var fid=(((sub.relationships||{}).form||{}).data||{}).id;
      return '/people/v2/forms/'+fid+'/form_submissions/'+sub.id+'/form_submission_values?include=form_field&per_page=100'; });
    var valPages = fgBatchFetch_(paths, new Date().getTime());
    out.forms = subs.map(function(sub, i){
      var fid=(((sub.relationships||{}).form||{}).data||{}).id;
      var page = valPages[i]; var answers = [];
      if (page && page.data) {
        var labelById={}; (page.included||[]).forEach(function(ff){ if(ff.type==='FormField') labelById[ff.id]=(ff.attributes||{}).label; });
        answers = page.data.map(function(v){ var a=v.attributes||{}; var lid=(((v.relationships||{}).form_field||{}).data||{}).id;
          return { label: labelById[lid]||'', value: a.display_value!=null?String(a.display_value):(a.value!=null?String(a.value):'') }; })
          .filter(function(x){ return x.value!==''; });
      }
      return { form: formName[fid]||'Form', date:(sub.attributes||{}).created_at||'', answers: answers };
    });
  }

  out.workflow = shWorkflowStatus_(pid);
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
  if (!pid || !field) return { error: 'missing pid/field' };

  var map = { health:SH_FIELD.healthAssess, healthDate:SH_FIELD.healthDate, elder:SH_FIELD.assignedElder,
              maturity:SH_FIELD.spiritualMat, known:SH_FIELD.known,
              deaconSupport:SH_FIELD.deaconSupport, deaconNotes:SH_FIELD.deaconNotes };
  var defId = map[field];
  if (!defId) return { error: 'unknown field ' + field };

  var r = shSetFieldDatum_(pid, defId, value);
  var result = { field: field, ok: r.ok, code: r.code };

  // Setting health status also stamps Health Assessment Date = today (unless caller sent a date too).
  if (field === 'health' && r.ok && !params.skipDate) {
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var d = shSetFieldDatum_(pid, SH_FIELD.healthDate, today);
    result.healthDateSet = d.ok ? today : false;
  }
  if (!r.ok) result.detail = r.detail;
  return result;
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
   WORKFLOW: New Family Member
   params: pid, op (view|add|advance|back), cardId?
========================================================= */
function shWorkflowStatus_(pid) {
  try {
    var res = pcoGetAllWithIncluded_('/people/v2/people/'+pid+'/workflow_cards?include=current_step,workflow&per_page=50');
    var stepName={}, wfName={};
    (res.included||[]).forEach(function(x){
      if (x.type==='WorkflowStep') stepName[x.id]=(x.attributes||{}).name;
      if (x.type==='Workflow') wfName[x.id]=(x.attributes||{}).name;
    });
    var card = (res.data||[]).filter(function(c){ return String((((c.relationships||{}).workflow||{}).data||{}).id)===SH_WF_NEW_FAMILY; })[0];
    // Steps of the workflow (for the advance UI)
    var steps = (pcoGetAll_('/people/v2/workflows/'+SH_WF_NEW_FAMILY+'/steps?per_page=100')||[])
      .map(function(s){ return { id:s.id, name:(s.attributes||{}).name, seq:(s.attributes||{}).sequence }; })
      .sort(function(a,b){ return (a.seq||0)-(b.seq||0); });
    if (!card) return { inWorkflow:false, steps:steps };
    var curId = (((card.relationships||{}).current_step||{}).data||{}).id;
    return { inWorkflow:true, cardId:card.id, stage:(card.attributes||{}).stage,
             currentStep: stepName[curId]||'', currentStepId:curId, steps:steps };
  } catch (e) { return { error: e.message }; }
}

function shepWorkflow_(params) {
  var pid = String(params.pid||''), op = String(params.op||'view');
  if (!pid) return { error:'missing pid' };
  if (op === 'view') return shWorkflowStatus_(pid);

  if (op === 'add') {
    var w = shWrite_('post', '/people/v2/workflows/'+SH_WF_NEW_FAMILY+'/cards',
      { data:{ relationships:{ person:{ data:{ type:'Person', id:pid } } } } });
    return { op:'add', ok:(w.code>=200&&w.code<300), code:w.code, detail:(w.code>=300?(w.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid) };
  }

  // advance / back / remove need the card id
  var st = shWorkflowStatus_(pid);
  var cardId = params.cardId || st.cardId;
  if (!cardId) return { error:'no workflow card for this person', status:st };
  if (op === 'remove') {
    var wr = shWrite_('delete', '/people/v2/workflows/'+SH_WF_NEW_FAMILY+'/cards/'+cardId, {});
    if (wr.code === 404 || wr.code === 405) wr = shWrite_('post', '/people/v2/workflows/'+SH_WF_NEW_FAMILY+'/cards/'+cardId+'/remove', { data:{} });
    return { op:'remove', ok:(wr.code>=200&&wr.code<300), code:wr.code, detail:(wr.code>=300?(wr.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid) };
  }
  var action = (op === 'back') ? 'go_back' : 'promote';
  // PCO card actions are POSTed to the card's action sub-path.
  var w2 = shWrite_('post', '/people/v2/workflows/'+SH_WF_NEW_FAMILY+'/cards/'+cardId+'/'+action, { data:{} });
  if (w2.code === 404) {
    // Fallback path shape
    w2 = shWrite_('post', '/people/v2/workflow_cards/'+cardId+'/'+action, { data:{} });
  }
  return { op:op, ok:(w2.code>=200&&w2.code<300), code:w2.code, detail:(w2.code>=300?(w2.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid) };
}
