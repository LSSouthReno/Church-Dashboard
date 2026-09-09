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
  var fsres = shGet_('/people/v2/people/'+pid+'/form_submissions?include=form&per_page=25');
  if (fsres.json && fsres.json.data) {
    var formName = {}; (fsres.json.included||[]).forEach(function(f){ if(f.type==='Form') formName[f.id]=(f.attributes||{}).name; });
    var subs = fsres.json.data.slice(0, 8);
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

  out.workflow = shWorkflowStatus_(pid);
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
  if (!pid || !field) return { error: 'missing pid/field' };

  var map = { health:SH_FIELD.healthAssess, healthDate:SH_FIELD.healthDate, elder:SH_FIELD.assignedElder,
              maturity:SH_FIELD.spiritualMat, pref:SH_FIELD.preferredComm, known:SH_FIELD.known,
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
   WORKFLOW: Baptism Ready (528797)
   params: pid, op (view|add|remove), cardId?
========================================================= */
function shWorkflowStatus_(pid) {
  try {
    var res = pcoGetAllWithIncluded_('/people/v2/people/'+pid+'/workflow_cards?include=current_step,workflow&per_page=50');
    var stepName={};
    (res.included||[]).forEach(function(x){ if (x.type==='WorkflowStep') stepName[x.id]=(x.attributes||{}).name; });
    var cards = (res.data||[]).filter(function(c){ return String((((c.relationships||{}).workflow||{}).data||{}).id)===SH_WF_BAPTISM; });
    var completed = cards.some(function(c){ return String((c.attributes||{}).stage)==='completed'; });
    var active = cards.filter(function(c){ return String((c.attributes||{}).stage)!=='completed'; })[0];
    var out = { workflow:'Baptism Ready', inWorkflow: cards.length>0, completed: completed };
    if (active) {
      var curId=(((active.relationships||{}).current_step||{}).data||{}).id;
      out.cardId=active.id; out.stage=(active.attributes||{}).stage; out.currentStep=stepName[curId]||'';
    } else if (completed) {
      out.completedAt = cards.filter(function(c){return String((c.attributes||{}).stage)==='completed';})[0].attributes.completed_at || '';
    }
    return out;
  } catch (e) { return { error: e.message }; }
}

function shepWorkflow_(params) {
  var pid = String(params.pid||''), op = String(params.op||'view');
  if (!pid) return { error:'missing pid' };
  if (op === 'view') return shWorkflowStatus_(pid);

  if (op === 'add') {
    var w = shWrite_('post', '/people/v2/workflows/'+SH_WF_BAPTISM+'/cards',
      { data:{ relationships:{ person:{ data:{ type:'Person', id:pid } } } } });
    return { op:'add', ok:(w.code>=200&&w.code<300), code:w.code, detail:(w.code>=300?(w.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid) };
  }
  if (op === 'remove') {
    var st = shWorkflowStatus_(pid);
    var cardId = params.cardId || st.cardId;
    if (!cardId) return { error:'no active card', status:st };
    var wr = shWrite_('delete', '/people/v2/workflows/'+SH_WF_BAPTISM+'/cards/'+cardId, {});
    if (wr.code === 404 || wr.code === 405) wr = shWrite_('post', '/people/v2/workflows/'+SH_WF_BAPTISM+'/cards/'+cardId+'/remove', { data:{} });
    return { op:'remove', ok:(wr.code>=200&&wr.code<300), code:wr.code, detail:(wr.code>=300?(wr.raw||'').substring(0,300):null), status: shWorkflowStatus_(pid) };
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
  return { ok:ok, code:w.code, detail: ok?null:(w.raw||'').substring(0,300),
           note: ok && w.json && w.json.data ? { id:w.json.data.id } : null };
}
