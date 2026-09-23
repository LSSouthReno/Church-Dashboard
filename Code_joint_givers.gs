/* =========================================================
   Joint donors (Planning Center Giving "joined" donors)
   =========================================================
   PCO Giving lets two donors be JOINED (usually spouses): they share one
   donation history and one statement, but every gift is still recorded under
   whichever one of them actually gave. So the other spouse looks like a
   non-giver unless we treat the pair as one giving unit.

   Brad's rule (2026-09-23): anyone joined with another donor counts as giving
   whenever EITHER of them gives — on every dashboard (Groups Venn/action lists,
   funnel engagement, /pastors, the CG person drawer).

   Source of truth: GET /giving/v2/donor_summaries?filter=has_joint_giver
   &include=joint_giver — one church-wide list of every donor who has a joint
   giver (a few pages). Cached for 6 hours so every sync can call it freely.
   ========================================================= */

var JG_CACHE_KEY_ = 'JOINT_GIVER_MAP_v1';

/** pid -> joint-giver pid for every joined pair (both directions). {} on failure. */
function pcoJointGiverMap_() {
  var cache = CacheService.getScriptCache();
  try { var hit = cache.get(JG_CACHE_KEY_); if (hit) return JSON.parse(hit); } catch (e) {}
  var map = jgFetchJointGiverMap_();
  if (Object.keys(map).length) { try { cache.put(JG_CACHE_KEY_, JSON.stringify(map), 21600); } catch (e) {} }
  return map;
}

function jgFetchJointGiverMap_() {
  var map = {}, pairs = 0, pages = 0;
  var url = PCO_API + '/giving/v2/donor_summaries?filter=has_joint_giver&include=joint_giver&per_page=100';
  try {
    while (url && pages < 50) {
      pages++;
      var json = pcoGet_(url);
      (json.data || []).forEach(function(s) {
        var jg = s.relationships && s.relationships.joint_giver && s.relationships.joint_giver.data;
        var a = String(s.id || ''), b = jg && jg.id ? String(jg.id) : '';
        if (!a || !b || a === b) return;
        if (!map[a]) pairs++;
        map[a] = b; map[b] = a;
      });
      url = (json.links && json.links.next) || null;
    }
  } catch (e) { Logger.log('   ! joint-giver map failed: ' + e.message); }
  Logger.log('   Joint givers: ' + pairs + ' donors with a joint giver (' + pages + ' page(s))');
  return map;
}

/** The pid's giving unit: [pid] or [pid, jointGiverPid]. */
function jgUnit_(pid, map) {
  pid = String(pid); map = map || pcoJointGiverMap_();
  return map[pid] ? [pid, map[pid]] : [pid];
}

/** Adds every giver's joint giver to a Set of giver person ids (in place) and returns it. */
function jgExpandGiverSet_(ids, map) {
  map = map || pcoJointGiverMap_();
  var add = [];
  ids.forEach(function(id) { var p = map[String(id)]; if (p && !ids.has(p)) add.push(p); });
  add.forEach(function(p) { ids.add(p); });
  Logger.log('   Joint givers credited: +' + add.length + ' people');
  return ids;
}

/** Read-only check for the joint-giver link (no amounts): counts + a few sample pairs. */
function jgProbe_() {
  CacheService.getScriptCache().remove(JG_CACHE_KEY_);
  var first = pcoGet_(PCO_API + '/giving/v2/donor_summaries?filter=has_joint_giver&include=joint_giver&per_page=5');
  var shape = (first.data || []).slice(0, 2).map(function(s) {
    return { type: s.type, id: s.id, name: (s.attributes || {}).name, rel: s.relationships };
  });
  var inc = (first.included || []).slice(0, 2).map(function(p) { return { type: p.type, id: p.id, name: [(p.attributes||{}).first_name, (p.attributes||{}).last_name].join(' ') }; });
  var map = pcoJointGiverMap_();
  return { ok: true, people: Object.keys(map).length, sampleShape: shape, sampleIncluded: inc, meta: first.meta };
}
