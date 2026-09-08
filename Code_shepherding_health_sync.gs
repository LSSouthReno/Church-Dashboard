/**
 * Pastor Shepherding Health Sync
 *
 * Builds the data behind the (password-gated) Pastor Shepherding page in the
 * dashboard: for every person on an elder's "Shepherding - [Elder]" PCO People
 * list, it pulls their real Planning Center activity and computes a 1–10
 * spiritual-maturity score, a trajectory arrow, contact info (email/phone), and
 * their Shepherding-tab status (healthy / wandering / lost / weak / …). It then
 * rolls those up into per-elder and whole-congregation health metrics and writes
 * everything to shepherding-data.json in the GitHub repo.
 *
 * WHAT FEEDS THE SCORE (see spComputeScore_ for exact weights):
 *   • Giving        — months given in the last 12, whether they give recurring,
 *                     and whether generosity is growing (2nd-half vs 1st-half).
 *   • Community Group — member vs leader of a Community Group.
 *   • Serving       — on a Serve Team, how many, and leader vs member.
 *   • Connection    — membership status / general engagement.
 * The Shepherding-tab status is pulled straight from PCO (not computed) and is
 * used for filtering on the page, shown alongside the computed score.
 *
 * EFFICIENCY / SAFETY (mirrors Code_funnel_groups_sync.gs):
 *   Giving, recurring gifts, group memberships and contact info are all pulled in
 *   BULK (not one call per person) and joined locally by PCO person id. Per-person
 *   field-data (the Shepherding tab) is fanned out with the shared fgBatchFetch_
 *   helper. Every expensive loop respects a hard time budget so an Apps-Script
 *   6-minute kill never loses the whole run — a partial run keeps the previous
 *   shepherding-data.json rather than clobbering it.
 *
 * DEPLOY:
 *   Shares PCO_APP_ID / PCO_SECRET / GITHUB_* script properties and the
 *   pcoHeaders_ / pcoGetAll_ / getProp_ / fgBatchFetch_ helpers already defined
 *   in the other sync files (same Apps Script project). After deploying, run
 *   installShepherdingHealthTrigger() once from the editor to schedule the hourly
 *   run. It can also be kicked on demand via the web app: ?action=run_shepherding_health_sync
 */

const SH_TIME_BUDGET_MS   = 5 * 60 * 1000;   // stop expensive loops after 5 min
const SH_GIVING_MONTHS     = 12;             // giving look-back window
const SH_OUTPUT_FILE       = 'shepherding-data.json';  // PUBLIC repo file — SANITISED (safe fields only)
const SH_PRIVATE_SHEET     = 'ShepherdingData';        // hidden tab holding the FULL sensitive JSON (chunked)
const SH_CELL_CHUNK        = 40000;                     // chars per cell (cell hard-limit is 50k)

// SHA-256 of the shepherding page password ("1peter5"). The web app only returns
// the full sensitive data when a request presents this hash — so the private
// shepherding data never sits in a public file. Keep in sync with PASTOR_HASH in
// index.html. (Client-side gating: the hash lives in the page, so this ties data
// access to the password, not to a Google login — see the deploy notes.)
const SHEPHERDING_PW_HASH  = '19714e8203cc3d5e9f7c4a4499981a5d37448d56e193336b3ed32913abbc3b3d';

// Status vocabulary. Raw PCO values are normalised into one of these buckets so
// the page can filter consistently no matter how an elder typed it.
const SH_STATUS_SYNONYMS = {
  healthy:   ['healthy', 'strong', 'thriving', 'flourishing', 'growing'],
  wandering: ['wandering', 'drifting', 'distant', 'disengaged', 'cooling'],
  weak:      ['weak', 'struggling', 'fragile', 'hurting', 'at risk', 'at-risk'],
  lost:      ['lost', 'gone', 'left', 'far', 'far off', 'inactive'],
  new:       ['new', 'newcomer', 'exploring', 'seeker']
};

function shElapsed_(startMs)   { return new Date().getTime() - startMs; }
function shOverBudget_(startMs) { return shElapsed_(startMs) > SH_TIME_BUDGET_MS; }

/* =========================================================
   MAIN
========================================================= */
function syncShepherdingHealth_() {
  Logger.log('▶ Shepherding Health — starting');
  const startMs = new Date().getTime();

  // ── 1. Elder lists → people (with PCO ids) ──────────────────────────────────
  const lists = spFetchShepherdingLists_();               // [{elder,list,people:[{id,first,last,name,member}]}]
  const allIds = [];
  const idSeen = {};
  lists.forEach(function(l) {
    l.people.forEach(function(p) { if (p.id && !idSeen[p.id]) { idSeen[p.id] = true; allIds.push(p.id); } });
  });
  Logger.log('   Elders: ' + lists.length + ' · unique shepherded people: ' + allIds.length);
  if (!allIds.length) { Logger.log('   ! no shepherded people found — aborting (keeping previous data)'); return; }

  // ── 2. Bulk activity joins (person id → data) ───────────────────────────────
  const giving   = spGivingByPerson_(startMs);            // id → {monthsGiven,total,firstHalf,secondHalf,count,lastGiftAt}
  const recurring = spRecurringDonorIds_();               // Set of ids
  const groups   = spGroupInvolvementByPerson_(startMs);  // id → {cg:[{name,role}], serve:[{name,role}]}
  const contact  = spContactByPerson_(allIds, startMs);   // id → {email,phone,member}
  const fields   = spShepherdingFieldsByPerson_(allIds, startMs); // id → {status, statusRaw, notes, fields:{}}

  // ── 3. Assemble per-person records + score ──────────────────────────────────
  const eldersOut = lists.map(function(l) {
    const people = l.people.map(function(p) {
      return spBuildPerson_(p, giving[p.id], recurring.has(p.id), groups[p.id], contact[p.id], fields[p.id]);
    }).sort(function(a, b) { return (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name); });
    return { elder: l.elder, list: l.list, summary: spSummarize_(people), people: people };
  });

  // Congregation-wide summary is over UNIQUE people (someone on two lists counts once).
  const uniquePeople = [];
  const uSeen = {};
  eldersOut.forEach(function(e) {
    e.people.forEach(function(p) { if (p.id && !uSeen[p.id]) { uSeen[p.id] = true; uniquePeople.push(p); } });
  });

  const out = {
    generatedAt: new Date().toISOString(),
    asOf: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    givingMonths: SH_GIVING_MONTHS,
    statusVocab: ['healthy', 'new', 'wandering', 'weak', 'lost', 'unknown'],
    congregation: spSummarize_(uniquePeople),
    elders: eldersOut
  };
  out.congregation.totalPeople = uniquePeople.length;

  // Full sensitive data → private (hidden sheet), served only by the
  // password-gated web app. A SANITISED copy (names + group/serve involvement,
  // no scores/giving/contact/status/notes) goes to the public repo so the page
  // has a safe first paint before it authenticates.
  spStorePrivate_(out);
  spPushToGitHub_(spBuildPublicSeed_(out));
  Logger.log('✓ Shepherding Health — done in ' + Math.round(shElapsed_(startMs) / 1000) + 's. ' +
             'people=' + uniquePeople.length + ' avgScore=' + out.congregation.avgScore);
}

/* =========================================================
   1. SHEPHERDING LISTS → PEOPLE WITH IDS
========================================================= */
function spFetchShepherdingLists_() {
  const lists = pcoGetAll_('/people/v2/lists?per_page=100') || [];
  const out = [];
  lists.forEach(function(l) {
    const name = String(((l.attributes || {}).name || '')).trim();
    if (!/^shepherding\s*[-–—]/i.test(name)) return;
    const elder = name.replace(/^shepherding\s*[-–—]\s*/i, '').trim() || name;
    let people = [];
    try {
      people = (pcoGetAll_('/people/v2/lists/' + l.id + '/people?per_page=100') || [])
        .map(function(p) {
          const a = p.attributes || {};
          const full = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
          return {
            id: String(p.id),
            first: a.first_name || '',
            last: a.last_name || '',
            name: full || ('Person ' + p.id),
            member: /member/i.test(String(a.membership || ''))
          };
        })
        .filter(function(p) { return !!p.id; });
    } catch (e) {
      Logger.log('   ! people fetch failed for list "' + name + '": ' + e.message);
    }
    out.push({ elder: elder, list: name, people: people });
  });
  out.sort(function(a, b) { return a.elder.localeCompare(b.elder); });
  return out;
}

/* =========================================================
   2a. GIVING (bulk, last N months) → per person
========================================================= */
function spGivingByPerson_(startMs) {
  const now = new Date();
  const since = new Date(now); since.setMonth(since.getMonth() - SH_GIVING_MONTHS);
  const midpoint = new Date(now); midpoint.setMonth(midpoint.getMonth() - Math.round(SH_GIVING_MONTHS / 2));
  const sinceStr = Utilities.formatDate(since, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const byPerson = {};
  let url = 'https://api.planningcenteronline.com/giving/v2/donations?where[received_at][gte]=' +
            sinceStr + '&per_page=100&order=-received_at';
  let pages = 0;
  while (url && pages < 200) {
    if (shOverBudget_(startMs)) { Logger.log('   ! budget hit during giving pull — partial'); break; }
    pages++;
    let json;
    try { json = fgFetchPage_(url); } catch (e) { Logger.log('   ! giving page failed: ' + e.message); break; }
    (json.data || []).forEach(function(d) {
      const a = d.attributes || {};
      if (!spDonationCounts_(a)) return;
      const pid = relId_(d, 'person');
      if (!pid) return;
      const cents = Number(a.amount_cents || 0);
      const received = a.received_at || a.created_at;
      if (!received) return;
      const month = String(received).slice(0, 7);
      let rec = byPerson[pid];
      if (!rec) rec = byPerson[pid] = { monthsSet: {}, total: 0, firstHalf: 0, secondHalf: 0, count: 0, lastGiftAt: null };
      rec.monthsSet[month] = true;
      rec.total += cents;
      rec.count++;
      const when = new Date(received);
      if (when >= midpoint) rec.secondHalf += cents; else rec.firstHalf += cents;
      if (!rec.lastGiftAt || when > new Date(rec.lastGiftAt)) rec.lastGiftAt = received;
    });
    url = (json.links && json.links.next) ? json.links.next : null;
  }
  Object.keys(byPerson).forEach(function(pid) {
    const r = byPerson[pid];
    r.monthsGiven = Object.keys(r.monthsSet).length;
    delete r.monthsSet;
  });
  Logger.log('   Donors in last ' + SH_GIVING_MONTHS + 'mo: ' + Object.keys(byPerson).length);
  return byPerson;
}

// Only count settled, positive donations toward giving consistency.
function spDonationCounts_(a) {
  const status = String(a.payment_status || a.status || '').toLowerCase();
  if (status.indexOf('fail') !== -1 || status.indexOf('cancel') !== -1 ||
      status.indexOf('declin') !== -1 || status === 'refunded' || status === 'reversed') return false;
  if (Number(a.amount_cents || 0) <= 0) return false;
  return true;
}

/* =========================================================
   2b. RECURRING DONORS (bulk) → Set of person ids
========================================================= */
function spRecurringDonorIds_() {
  const ids = new Set();
  try {
    const rows = pcoGetAll_('/giving/v2/recurring_donations?per_page=100') || [];
    rows.forEach(function(r) {
      const a = r.attributes || {};
      const st = String(a.status || '').toLowerCase();
      if (st && st !== 'active') return;      // only active recurring plans
      const pid = relId_(r, 'person');
      if (pid) ids.add(pid);
    });
  } catch (e) { Logger.log('   ! recurring donations fetch failed: ' + e.message); }
  Logger.log('   Active recurring donors: ' + ids.size);
  return ids;
}

/* =========================================================
   2c. GROUP INVOLVEMENT (Community Groups + Serve Teams) → per person
   Reuses the batched-fetch pattern; only the two ministry group types.
========================================================= */
function spGroupInvolvementByPerson_(startMs) {
  const byPerson = {};
  const groupTypes = pcoGetAll_('/groups/v2/group_types?per_page=100') || [];
  const wanted = groupTypes.filter(function(t) {
    const n = String(((t.attributes || {}).name || '')).toLowerCase();
    return n.indexOf('community group') !== -1 || n.indexOf('serve team') !== -1;
  });

  wanted.forEach(function(t) {
    if (shOverBudget_(startMs)) return;
    const typeName = String(((t.attributes || {}).name || '')).toLowerCase();
    const bucket = typeName.indexOf('serve') !== -1 ? 'serve' : 'cg';
    const groups = pcoGetAll_('/groups/v2/group_types/' + t.id + '/groups?per_page=100') || [];
    if (!groups.length) return;
    const membershipPages = fgBatchFetch_(
      groups.map(function(g) { return '/groups/v2/groups/' + g.id + '/memberships?per_page=100'; }),
      startMs
    );
    groups.forEach(function(g, i) {
      const gName = (g.attributes && g.attributes.name) || 'Untitled';
      const memberships = (membershipPages[i] && membershipPages[i].data) || [];
      memberships.forEach(function(m) {
        const attr = m.attributes || {};
        if (attr.left_at || attr.removed_at) return;
        const pid = relId_(m, 'person');
        if (!pid) return;
        let rec = byPerson[pid];
        if (!rec) rec = byPerson[pid] = { cg: [], serve: [] };
        rec[bucket].push({ name: gName, role: attr.role || 'member' });
      });
    });
  });
  return byPerson;
}

/* =========================================================
   2d. CONTACT INFO (email + phone + membership) → per person
   Bulk where[id]=… with emails/phone_numbers included, chunked.
========================================================= */
function spContactByPerson_(ids, startMs) {
  const out = {};
  const CHUNK = 25;
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (shOverBudget_(startMs)) { Logger.log('   ! budget hit during contact pull — partial'); break; }
    const chunk = ids.slice(i, i + CHUNK);
    let res;
    try {
      res = pcoGetAllWithIncluded_(
        '/people/v2/people?where[id]=' + chunk.join(',') +
        '&include=emails,phone_numbers&fields[Person]=first_name,last_name,membership' +
        '&fields[Email]=address,primary&fields[PhoneNumber]=number,primary&per_page=' + chunk.length
      );
    } catch (e) { Logger.log('   ! contact chunk failed: ' + e.message); continue; }

    // Index included emails/phones by their own id, and record which are primary.
    const emailById = {}, phoneById = {};
    (res.included || []).forEach(function(inc) {
      if (inc.type === 'Email') emailById[inc.id] = inc.attributes || {};
      else if (inc.type === 'PhoneNumber') phoneById[inc.id] = inc.attributes || {};
    });
    (res.data || []).forEach(function(p) {
      const a = p.attributes || {};
      const rel = p.relationships || {};
      const email = spPickPrimary_(rel.emails, emailById, 'address');
      const phone = spPickPrimary_(rel.phone_numbers, phoneById, 'number');
      out[String(p.id)] = {
        email: email,
        phone: phone,
        member: /member/i.test(String(a.membership || ''))
      };
    });
  }
  return out;
}

// From a to-many relationship, return the primary item's field (or the first).
function spPickPrimary_(relObj, byId, attrKey) {
  try {
    const list = (relObj && relObj.data) || [];
    let firstVal = '';
    for (let i = 0; i < list.length; i++) {
      const item = byId[list[i].id];
      if (!item) continue;
      const val = item[attrKey] || '';
      if (!firstVal && val) firstVal = val;
      if (item.primary && val) return val;
    }
    return firstVal;
  } catch (e) { return ''; }
}

/* =========================================================
   2e. SHEPHERDING-TAB FIELD DATA (status + notes) → per person
   Per-person field_data fetched in batches; definition id → name/tab resolved once.
========================================================= */
function spShepherdingFieldsByPerson_(ids, startMs) {
  const out = {};
  // Resolve field-definition id → { name, tabName } once.
  const defInfo = spFieldDefinitionInfo_();

  const pages = fgBatchFetch_(
    ids.map(function(id) { return '/people/v2/people/' + id + '/field_data?per_page=100'; }),
    startMs
  );
  ids.forEach(function(id, i) {
    const rows = (pages[i] && pages[i].data) || [];
    const fields = {};
    let status = '', statusRaw = '', notes = '';
    rows.forEach(function(fd) {
      const a = fd.attributes || {};
      const defId = relId_(fd, 'field_definition');
      const info = defInfo[defId] || { name: (a.label || 'Field'), tabName: '' };
      // Only surface fields that live on a "Shepherding"-ish tab (or that clearly
      // carry a shepherding status), so we don't leak unrelated custom fields.
      const onShepTab = /shepherd|care|pastoral|discipleship/i.test(info.tabName || '');
      const value = (a.value == null ? '' : String(a.value)).trim();
      if (!value) return;
      const norm = spNormalizeStatus_(value);
      const looksLikeStatus = norm !== 'unknown' || /status|health|stage/i.test(info.name || '');
      if (!onShepTab && !looksLikeStatus) return;

      fields[info.name] = value;
      if (!statusRaw && norm !== 'unknown') { status = norm; statusRaw = value; }
      else if (/note|comment|prayer|update/i.test(info.name || '')) {
        notes = notes ? (notes + ' · ' + value) : value;
      }
    });
    out[id] = { status: status || 'unknown', statusRaw: statusRaw, notes: notes, fields: fields };
  });
  return out;
}

function spFieldDefinitionInfo_() {
  const info = {};
  // Tab id → tab name
  const tabName = {};
  try {
    (pcoGetAll_('/people/v2/tabs?per_page=100') || []).forEach(function(t) {
      tabName[String(t.id)] = String(((t.attributes || {}).name || ''));
    });
  } catch (e) { Logger.log('   ! tabs fetch failed: ' + e.message); }
  try {
    (pcoGetAll_('/people/v2/field_definitions?per_page=100') || []).forEach(function(d) {
      const a = d.attributes || {};
      const tId = relId_(d, 'tab');
      info[String(d.id)] = { name: a.name || 'Field', tabName: tabName[tId] || '' };
    });
  } catch (e) { Logger.log('   ! field_definitions fetch failed: ' + e.message); }
  return info;
}

function spNormalizeStatus_(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'unknown';
  for (const key in SH_STATUS_SYNONYMS) {
    const syns = SH_STATUS_SYNONYMS[key];
    for (let i = 0; i < syns.length; i++) {
      if (v === syns[i] || v.indexOf(syns[i]) !== -1) return key;
    }
  }
  return 'unknown';
}

/* =========================================================
   3. BUILD PERSON RECORD + SCORE
========================================================= */
function spBuildPerson_(base, g, isRecurring, grp, contact, fld) {
  g = g || { monthsGiven: 0, total: 0, firstHalf: 0, secondHalf: 0, count: 0, lastGiftAt: null };
  grp = grp || { cg: [], serve: [] };
  contact = contact || { email: '', phone: '', member: base.member };
  fld = fld || { status: 'unknown', statusRaw: '', notes: '', fields: {} };

  const cgLeader    = grp.cg.some(function(x) { return /leader/i.test(x.role); });
  const inCG        = grp.cg.length > 0;
  const serveLeader = grp.serve.some(function(x) { return /leader/i.test(x.role); });
  const serveCount  = grp.serve.length;
  const isMember    = !!(contact.member || base.member);

  const givingTrend = spGivingTrend_(g);
  const scored = spComputeScore_({
    monthsGiven: g.monthsGiven, recurring: isRecurring, givingTrend: givingTrend,
    inCG: inCG, cgLeader: cgLeader, serveCount: serveCount, serveLeader: serveLeader,
    isMember: isMember, gaveAny: g.count > 0, status: fld.status
  });

  const flags = [];
  if (!inCG) flags.push('Not in a group');
  if (serveCount === 0) flags.push('Not serving');
  if (g.count === 0) flags.push('No recent giving');
  else if (givingTrend === 'down') flags.push('Giving declined');
  if (!contact.email && !contact.phone) flags.push('No contact info');

  return {
    id: base.id,
    name: base.name,
    first: base.first,
    last: base.last,
    email: contact.email || '',
    phone: contact.phone || '',
    member: isMember,
    status: fld.status,
    statusRaw: fld.statusRaw || '',
    shepherdNotes: fld.notes || '',
    shepherdFields: fld.fields || {},
    score: scored.score,
    trajectory: scored.trajectory,
    pillars: scored.pillars,
    giving: {
      monthsGiven: g.monthsGiven, gifts: g.count, totalCents: g.total,
      recurring: isRecurring, trend: givingTrend,
      lastGiftAt: g.lastGiftAt, lastGiftDaysAgo: spDaysAgo_(g.lastGiftAt)
    },
    groups: grp.cg,
    serveTeams: grp.serve,
    flags: flags
  };
}

function spGivingTrend_(g) {
  if (!g || g.count === 0) return 'none';
  if (g.secondHalf > g.firstHalf * 1.15) return 'up';
  if (g.secondHalf < g.firstHalf * 0.85) return 'down';
  return 'steady';
}

// Weighted rubric → 1..10. Weights: giving 30, group 30, serve 25, connect 15.
function spComputeScore_(x) {
  // Giving (0–30)
  let giving = Math.min(30, (Math.min(x.monthsGiven, 12) / 12) * 22);
  if (x.recurring) giving = Math.max(giving, 22);   // an active recurring plan implies regularity
  if (x.givingTrend === 'up') giving += 5;
  if (x.givingTrend === 'down') giving -= 3;
  giving = Math.max(0, Math.min(30, giving));

  // Community Group (0–30)
  let group = 0;
  if (x.cgLeader) group = 30;
  else if (x.inCG) group = 22;

  // Serving (0–25)
  let serve = 0;
  if (x.serveLeader) serve = 25;
  else if (x.serveCount >= 1) serve = 15 + Math.min(x.serveCount - 1, 2) * 3;

  // Connection (0–15)
  let connect;
  if (x.isMember) connect = 15;
  else if (x.gaveAny || x.inCG || x.serveCount > 0) connect = 8;
  else connect = 3;

  let total = giving + group + serve + connect;   // 0..100
  // Status nudge: a pastor-marked "lost/weak" shouldn't read as thriving, and a
  // "healthy" flag lifts borderline cases — small so activity still dominates.
  if (x.status === 'lost') total -= 12;
  else if (x.status === 'weak') total -= 6;
  else if (x.status === 'wandering') total -= 3;
  else if (x.status === 'healthy') total += 4;
  total = Math.max(0, Math.min(100, total));

  const score = Math.max(1, Math.round(total / 10));

  let trajectory = 'steady';
  if (x.status === 'lost' || x.status === 'weak') trajectory = 'down';
  else if (x.givingTrend === 'up' || x.status === 'healthy') trajectory = 'up';
  else if (x.givingTrend === 'down') trajectory = 'down';

  return {
    score: score,
    trajectory: trajectory,
    pillars: {
      giving: Math.round(giving), group: group, serve: serve, connect: connect
    }
  };
}

function spDaysAgo_(iso) {
  if (!iso) return null;
  try { return Math.floor((new Date().getTime() - new Date(iso).getTime()) / 86400000); }
  catch (e) { return null; }
}

/* =========================================================
   AGGREGATES (per-elder + congregation)
========================================================= */
function spSummarize_(people) {
  const n = people.length || 0;
  const s = {
    totalPeople: n, avgScore: 0,
    inGroup: 0, serving: 0, leading: 0, members: 0,
    givingRegular: 0, recurring: 0, givingGrowing: 0, noRecentGiving: 0,
    statusCounts: { healthy: 0, new: 0, wandering: 0, weak: 0, lost: 0, unknown: 0 },
    scoreBuckets: { low: 0, mid: 0, high: 0 },   // 1-3, 4-7, 8-10
    needsAttention: 0
  };
  if (!n) return s;
  let scoreSum = 0;
  people.forEach(function(p) {
    scoreSum += p.score || 0;
    if (p.groups && p.groups.length) s.inGroup++;
    if (p.serveTeams && p.serveTeams.length) s.serving++;
    const isLeader = (p.groups || []).some(function(x){return /leader/i.test(x.role);}) ||
                     (p.serveTeams || []).some(function(x){return /leader/i.test(x.role);});
    if (isLeader) s.leading++;
    if (p.member) s.members++;
    if (p.giving) {
      if (p.giving.recurring || p.giving.monthsGiven >= 6) s.givingRegular++;
      if (p.giving.recurring) s.recurring++;
      if (p.giving.trend === 'up') s.givingGrowing++;
      if (p.giving.gifts === 0) s.noRecentGiving++;
    }
    const st = (p.status && s.statusCounts.hasOwnProperty(p.status)) ? p.status : 'unknown';
    s.statusCounts[st]++;
    if (p.score <= 3) s.scoreBuckets.low++;
    else if (p.score <= 7) s.scoreBuckets.mid++;
    else s.scoreBuckets.high++;
    if (p.score <= 3 || p.status === 'lost' || p.status === 'weak') s.needsAttention++;
  });
  s.avgScore = Math.round((scoreSum / n) * 10) / 10;
  // Convenience percentages (0..1)
  s.pct = {
    inGroup: n ? s.inGroup / n : 0, serving: n ? s.serving / n : 0,
    leading: n ? s.leading / n : 0, members: n ? s.members / n : 0,
    givingRegular: n ? s.givingRegular / n : 0, recurring: n ? s.recurring / n : 0,
    givingGrowing: n ? s.givingGrowing / n : 0
  };
  return s;
}

/* =========================================================
   PRIVATE STORE (full sensitive data) — hidden sheet, chunked
   Kept in the bound spreadsheet (private), never in the public repo. Read back
   by the web app only after the password hash is verified. Chunked because a
   single cell caps at 50k chars and the full JSON is larger.
========================================================= */
function spStorePrivate_(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SH_PRIVATE_SHEET);
  if (!sh) sh = ss.insertSheet(SH_PRIVATE_SHEET);
  try { sh.hideSheet(); } catch (e) {}
  const json = JSON.stringify(data);
  const chunks = [];
  for (let i = 0; i < json.length; i += SH_CELL_CHUNK) chunks.push([json.substr(i, SH_CELL_CHUNK)]);
  sh.clearContents();
  if (chunks.length) sh.getRange(1, 1, chunks.length, 1).setValues(chunks);
  Logger.log('   Stored private shepherding data: ' + json.length + ' chars in ' + chunks.length + ' cell(s)');
}

// Read + reassemble the full private JSON. Used by the web app (Code_eos_webapp.gs).
function spReadPrivate_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_PRIVATE_SHEET);
  if (!sh) return null;
  const last = sh.getLastRow();
  if (!last) return null;
  const vals = sh.getRange(1, 1, last, 1).getValues();
  const json = vals.map(function(r) { return r[0]; }).join('');
  if (!json) return null;
  try { return JSON.parse(json); } catch (e) { Logger.log('   ! private parse failed: ' + e.message); return null; }
}

/* =========================================================
   PUBLIC SEED (sanitised) — safe fields only for first paint
========================================================= */
function spBuildPublicSeed_(full) {
  const safeFlags = { 'Not in a group': 1, 'Not serving': 1 };
  const sanitizePerson = function(p) {
    return {
      id: null,
      name: p.name, first: p.first, last: p.last,
      email: '', phone: '', member: false,
      status: 'unknown', statusRaw: '', shepherdNotes: '', shepherdFields: {},
      score: null, trajectory: 'steady', pillars: null, giving: null,
      groups: p.groups || [], serveTeams: p.serveTeams || [],
      flags: (p.flags || []).filter(function(f) { return safeFlags[f]; }),
      pending: true
    };
  };
  const elders = (full.elders || []).map(function(e) {
    const people = e.people.map(sanitizePerson);
    return { elder: e.elder, list: e.list, summary: spSummarize_(people), people: people };
  });
  const uniq = [], seen = {};
  elders.forEach(function(e) { e.people.forEach(function(p) {
    if (!seen[p.name]) { seen[p.name] = 1; uniq.push(p); }
  }); });
  const cong = spSummarize_(uniq);
  cong.totalPeople = uniq.length;
  return {
    generatedAt: full.generatedAt, asOf: full.asOf, givingMonths: full.givingMonths,
    statusVocab: full.statusVocab, seed: true,
    congregation: cong, elders: elders
  };
}

/* =========================================================
   PUSH shepherding-data.json (sanitised seed) to the public repo
========================================================= */
function spPushToGitHub_(data) {
  const owner  = getProp_('GITHUB_OWNER');
  const token  = getProp_('GITHUB_TOKEN');
  const repo   = getProp_('GITHUB_REPO');
  const branch = propOptional_('GITHUB_BRANCH') || 'main';
  const url    = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + SH_OUTPUT_FILE;
  const hdrs   = { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' };

  const existing = UrlFetchApp.fetch(url + '?ref=' + branch, { method: 'get', muteHttpExceptions: true, headers: hdrs });
  let sha = null;
  if (existing.getResponseCode() === 200) {
    try { sha = JSON.parse(existing.getContentText()).sha; } catch (e) {}
  }
  const payload = {
    message: 'Update shepherding health data',
    branch: branch,
    content: Utilities.base64Encode(JSON.stringify(data, null, 2), Utilities.Charset.UTF_8)
  };
  if (sha) payload.sha = sha;

  const res = UrlFetchApp.fetch(url, { method: 'put', contentType: 'application/json',
    muteHttpExceptions: true, headers: hdrs, payload: JSON.stringify(payload) });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Shepherding push failed: ' + code + ' — ' + res.getContentText().substring(0, 200));
  }
  Logger.log('✓  Pushed ' + SH_OUTPUT_FILE + ' to ' + owner + '/' + repo);
}

/* =========================================================
   TRIGGER (run once from the editor)
========================================================= */
function installShepherdingHealthTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncShepherdingHealth_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncShepherdingHealth_').timeBased().everyHours(1).create();
  Logger.log('Hourly Shepherding Health trigger installed.');
}

// Runnable from the editor Run menu (syncShepherdingHealth_ ends in "_" so it is
// hidden there). Use this once to populate the page immediately.
function runShepherdingHealthNow() {
  syncShepherdingHealth_();
}

// Install the hourly trigger only if it isn't already there (no churn on repeat
// calls). Used by the web-app setup action so one request wires up everything.
function spEnsureShepherdingTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'syncShepherdingHealth_';
  });
  if (!has) {
    ScriptApp.newTrigger('syncShepherdingHealth_').timeBased().everyHours(1).create();
    Logger.log('   Hourly Shepherding Health trigger installed.');
  }
}
