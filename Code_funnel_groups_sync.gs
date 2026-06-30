/**
 * Funnel + Groups Roster Sync
 *
 * Computes the Ministry Funnel auto-metrics and the full "every PCO group and who's in it"
 * roster, then merge-writes them into eos-data.json (funnel.attender/group/leader + allGroups).
 *
 *   Attenders = adults whose PCO profile was created 6-12 months ago, who are NOT currently
 *               in a Community Group or Serve Team, AND who engaged in the last 6 months by
 *               either giving a donation or checking in a child (credited via the child's
 *               household — PCO's Check-In API only records which child was checked in, not
 *               which adult performed the check-in, so household membership is the closest
 *               available proxy).
 *   In a Group  = unique people with a current membership in any "Community Group" type group.
 *   Active Leaders = unique people with role=leader in any Community Group OR Serve Teams group.
 *   Members = NOT computed here — the dashboard pulls that number directly from
 *             dashboard-data.json (members.current) so it always matches the main dashboard badge.
 *
 * This does substantially more PCO work than the hourly sync (group rosters across every group
 * type + 6 months of check-ins/households), so it runs on its own DAILY trigger rather than
 * riding along with syncDashboard(). After deploying, run installFunnelGroupsDailyTrigger() once
 * from the Apps Script editor (Run menu) to schedule it.
 *
 * Shares PCO_APP_ID/PCO_SECRET/GITHUB_* script properties and the pcoGetAll_/pcoHeaders_/getProp_
 * helpers already defined in Code_net_giving_services_every_sync.gs (same Apps Script project).
 */

const FUNNEL_ENGAGE_LOOKBACK_MONTHS = 6;
const FUNNEL_ATTENDER_MIN_MONTHS    = 6;   // profile must be at least this old
const FUNNEL_ATTENDER_MAX_MONTHS    = 12;  // and no older than this

function syncFunnelAndGroups_() {
  Logger.log('▶ Funnel + Groups — starting');
  const startMs = new Date().getTime();

  // ── 1. Every group type → every group → current membership (with role) ────
  const groupTypes = pcoGetAll_('/groups/v2/group_types?per_page=100') || [];
  Logger.log('   Group types found: ' + groupTypes.length);

  const byType = {};
  groupTypes.forEach(function(t) {
    const typeName = (t.attributes && t.attributes.name) || ('Group Type ' + t.id);
    byType[typeName] = fgGroupTypeMembership_(t.id);
    Logger.log('   ' + typeName + ': ' + byType[typeName].groups.length + ' groups, ' +
               byType[typeName].memberIds.size + ' unique members');
  });

  const communityData = byType['Community Group'] || fgEmptyTypeData_();
  const serveData     = byType['Serve Teams']      || fgEmptyTypeData_();

  const excludeFromAttenders = new Set();
  communityData.memberIds.forEach(function(id) { excludeFromAttenders.add(id); });
  serveData.memberIds.forEach(function(id) { excludeFromAttenders.add(id); });

  const leaderIds = new Set();
  communityData.leaderIds.forEach(function(id) { leaderIds.add(id); });
  serveData.leaderIds.forEach(function(id) { leaderIds.add(id); });

  // ── 2. Attenders ────────────────────────────────────────────────────────
  const attenderCount = fgComputeAttenders_(excludeFromAttenders);

  const funnel = {
    attender: attenderCount,
    group: communityData.memberIds.size,
    leader: leaderIds.size,
    asOf: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
  Logger.log('   Funnel — attenders=' + attenderCount + ' inGroup=' + communityData.memberIds.size +
             ' leaders=' + leaderIds.size);

  // ── 3. Resolve names for everyone in any group, build the full roster ─────
  const allPersonIds = new Set();
  Object.keys(byType).forEach(function(tn) {
    byType[tn].groups.forEach(function(g) {
      g.members.forEach(function(m) { allPersonIds.add(m.personId); });
    });
  });
  const nameById = fgResolveNames_(Array.from(allPersonIds));

  const allGroups = [];
  Object.keys(byType).forEach(function(tn) {
    byType[tn].groups.forEach(function(g) {
      allGroups.push({
        type: tn,
        name: g.name,
        members: g.members.map(function(m) {
          return { name: nameById[m.personId] || ('Person ' + m.personId), role: m.role };
        }).sort(function(a, b) { return a.name.localeCompare(b.name); })
      });
    });
  });
  allGroups.sort(function(a, b) {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });

  fgMergePushToGitHub_(funnel, allGroups);

  const elapsedSec = Math.round((new Date().getTime() - startMs) / 1000);
  Logger.log('✓ Funnel + Groups — done in ' + elapsedSec + 's. groupsListed=' + allGroups.length);
}

function fgEmptyTypeData_() {
  return { memberIds: new Set(), leaderIds: new Set(), groups: [] };
}

// One group type → its groups → each group's current (non-departed) membership.
function fgGroupTypeMembership_(groupTypeId) {
  const groups = pcoGetAll_('/groups/v2/group_types/' + groupTypeId + '/groups?per_page=100') || [];
  const memberIds = new Set(), leaderIds = new Set();
  const groupRows = [];
  groups.forEach(function(g) {
    const memberships = pcoGetAll_('/groups/v2/groups/' + g.id + '/memberships?per_page=100') || [];
    const rows = [];
    memberships.forEach(function(m) {
      const attr = m.attributes || {};
      if (attr.left_at || attr.removed_at) return;
      const pid = m.relationships && m.relationships.person &&
                  m.relationships.person.data && m.relationships.person.data.id;
      if (!pid) return;
      memberIds.add(pid);
      if (attr.role === 'leader') leaderIds.add(pid);
      rows.push({ personId: pid, role: attr.role || 'member' });
    });
    groupRows.push({ id: g.id, name: (g.attributes && g.attributes.name) || 'Untitled Group', members: rows });
  });
  return { memberIds: memberIds, leaderIds: leaderIds, groups: groupRows };
}

// Batched name resolution — same proven pattern as syncCGLeaderPipeline_.
function fgResolveNames_(personIds) {
  const nameById = {};
  const BATCH = 50;
  for (let i = 0; i < personIds.length; i += BATCH) {
    const chunk = personIds.slice(i, i + BATCH);
    const people = pcoGetAll_(
      '/people/v2/people?where[id]=' + chunk.join(',') +
      '&fields[Person]=first_name,last_name&per_page=' + chunk.length
    ) || [];
    people.forEach(function(p) {
      const fn = (p.attributes && p.attributes.first_name) || '';
      const ln = (p.attributes && p.attributes.last_name) || '';
      nameById[p.id] = (fn + ' ' + ln).trim() || ('Person ' + p.id);
    });
    Utilities.sleep(DASHBOARD_CONFIG.PCO_REQUEST_DELAY_MS);
  }
  return nameById;
}

// ── Attenders ──────────────────────────────────────────────────────────────────
function fgComputeAttenders_(excludeIds) {
  const now = new Date();
  const olderBoundary = new Date(now); olderBoundary.setMonth(olderBoundary.getMonth() - FUNNEL_ATTENDER_MAX_MONTHS); // 12mo ago
  const newerBoundary = new Date(now); newerBoundary.setMonth(newerBoundary.getMonth() - FUNNEL_ATTENDER_MIN_MONTHS); // 6mo ago
  const engageSince   = new Date(now); engageSince.setMonth(engageSince.getMonth() - FUNNEL_ENGAGE_LOOKBACK_MONTHS);

  const candidates = fgPeopleCreatedInWindow_(olderBoundary, newerBoundary);
  Logger.log('   Attender candidates (adults, created ' + FUNNEL_ATTENDER_MIN_MONTHS + '-' +
             FUNNEL_ATTENDER_MAX_MONTHS + 'mo ago): ' + candidates.length);

  const candidateIds = candidates.filter(function(c) { return !excludeIds.has(c.id); })
                                  .map(function(c) { return c.id; });
  Logger.log('   After excluding current group/serve members: ' + candidateIds.length);
  if (!candidateIds.length) return 0;

  const giverIds = fgDonorIdsSince_(engageSince);
  Logger.log('   Distinct donors in last ' + FUNNEL_ENGAGE_LOOKBACK_MONTHS + 'mo: ' + giverIds.size);

  const checkedInAdultIds = fgAdultsWhoCheckedInChildSince_(engageSince);
  Logger.log('   Adults credited with a child check-in in last ' + FUNNEL_ENGAGE_LOOKBACK_MONTHS +
             'mo: ' + checkedInAdultIds.size);

  let count = 0;
  candidateIds.forEach(function(id) {
    if (giverIds.has(id) || checkedInAdultIds.has(id)) count++;
  });
  return count;
}

// Pages people newest-first, keeps adults created within [olderBoundary, newerBoundary], and
// stops once an entire page predates olderBoundary — PCO doesn't reliably support combining
// where[child] with date-range where[] filters, so this filters client-side instead.
function fgPeopleCreatedInWindow_(olderBoundary, newerBoundary) {
  const out = [];
  let url = 'https://api.planningcenteronline.com/people/v2/people?order=-created_at&per_page=100';
  let pages = 0;
  while (url && pages < 200) {
    pages++;
    const json = fgFetchPage_(url);
    const rows = json.data || [];
    if (!rows.length) break;

    let allOlderThanBoundary = true;
    rows.forEach(function(p) {
      const attrs = p.attributes || {};
      const createdAt = attrs.created_at ? new Date(attrs.created_at) : null;
      if (!createdAt) return;
      if (createdAt >= olderBoundary) allOlderThanBoundary = false;
      if (createdAt >= olderBoundary && createdAt <= newerBoundary && attrs.child !== true) {
        out.push({ id: p.id, createdAt: attrs.created_at });
      }
    });

    if (allOlderThanBoundary) break;
    url = (json.links && json.links.next) ? json.links.next : null;
  }
  return out;
}

function fgFetchPage_(url) {
  let res = null, attempts = 0;
  while (attempts < 5) {
    attempts++;
    Utilities.sleep(DASHBOARD_CONFIG.PCO_REQUEST_DELAY_MS || 250);
    res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: pcoHeaders_() });
    if (res.getResponseCode() !== 429) break;
    Utilities.sleep(DASHBOARD_CONFIG.PCO_RATE_LIMIT_SLEEP_MS || 21000);
  }
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('PCO request failed: ' + code + ' — ' + url);
  return JSON.parse(res.getContentText());
}

// ── Giving engagement ────────────────────────────────────────────────────────
function fgDonorIdsSince_(sinceDate) {
  const sinceStr = Utilities.formatDate(sinceDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const donations = pcoGetAll_('/giving/v2/donations?where[received_at][gte]=' + sinceStr + '&per_page=100') || [];
  const ids = new Set();
  donations.forEach(function(d) {
    const pid = d.relationships && d.relationships.person &&
                d.relationships.person.data && d.relationships.person.data.id;
    if (pid) ids.add(pid);
  });
  return ids;
}

// ── Child check-in engagement (via household — see file header) ─────────────────
function fgAdultsWhoCheckedInChildSince_(sinceDate) {
  const tz = Session.getScriptTimeZone();
  const sinceStr = Utilities.formatDate(sinceDate, tz, 'yyyy-MM-dd');
  const nowStr   = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const eventTimes = pcoGetAll_(
    '/check-ins/v2/event_times?where[starts_at][gte]=' + sinceStr +
    '&where[starts_at][lte]=' + nowStr + '&per_page=100'
  ) || [];
  const kidsEventTimes = eventTimes.filter(function(et) {
    const d = et.relationships && et.relationships.event && et.relationships.event.data;
    return d && String(d.id) === String(DASHBOARD_CONFIG.CHECKINS_EVENT_ID);
  });
  Logger.log('   Kids event times in window: ' + kidsEventTimes.length);

  const childIds = new Set();
  kidsEventTimes.forEach(function(et) {
    const checks = pcoGetAll_('/check-ins/v2/event_times/' + et.id + '/check_ins?per_page=100') || [];
    checks.forEach(function(c) {
      const pid = c.relationships && c.relationships.person &&
                  c.relationships.person.data && c.relationships.person.data.id;
      if (pid) childIds.add(pid);
    });
  });
  Logger.log('   Distinct children checked in: ' + childIds.size);

  const adultIds = new Set();
  let withHousehold = 0;
  Array.from(childIds).forEach(function(childId) {
    try {
      const households = pcoGetAll_('/people/v2/people/' + childId + '/households?per_page=5') || [];
      if (!households.length) return;
      withHousehold++;
      households.forEach(function(h) {
        const members = pcoGetAll_('/people/v2/households/' + h.id + '/people?per_page=20') || [];
        members.forEach(function(p) {
          if (p.id === childId) return;
          if ((p.attributes || {}).child === true) return; // only credit adults
          adultIds.add(p.id);
        });
      });
    } catch (e) {
      Logger.log('   ! household lookup failed for a child: ' + e.message);
    }
  });
  Logger.log('   Children with a resolvable household: ' + withHousehold + ' of ' + childIds.size);
  return adultIds;
}

// ── Merge-safe push to eos-data.json ─────────────────────────────────────────────
function fgMergePushToGitHub_(funnel, allGroups) {
  const owner  = getProp_('GITHUB_OWNER');
  const token  = getProp_('GITHUB_TOKEN');
  const repo   = getProp_('GITHUB_REPO');
  const path   = 'eos-data.json';
  const branch = 'main';
  const url    = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  const hdrs   = { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' };

  const existing = UrlFetchApp.fetch(url + '?ref=' + branch, { method: 'get', muteHttpExceptions: true, headers: hdrs });
  let sha = null, currentData = {};
  if (existing.getResponseCode() === 200) {
    const file = JSON.parse(existing.getContentText());
    sha = file.sha;
    try {
      currentData = JSON.parse(Utilities.newBlob(
        Utilities.base64Decode(file.content.replace(/\n/g, '')), 'text/plain', 'UTF-8'
      ).getDataAsString());
    } catch (e) { currentData = {}; }
  }

  // Sub-merge funnel (preserve fields this job doesn't own, e.g. missionary) + replace allGroups.
  const mergedFunnel = Object.assign({}, currentData.funnel, funnel);
  const merged = Object.assign({}, currentData, { funnel: mergedFunnel, allGroups: allGroups });

  const payload = { message: 'Update funnel metrics & groups roster', branch: branch,
                    content: Utilities.base64Encode(JSON.stringify(merged, null, 2), Utilities.Charset.UTF_8) };
  if (sha) payload.sha = sha;

  const res = UrlFetchApp.fetch(url, { method: 'put', contentType: 'application/json',
                                        muteHttpExceptions: true, headers: hdrs,
                                        payload: JSON.stringify(payload) });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Funnel/Groups push failed: ' + code + ' — ' + res.getContentText().substring(0, 200));
  }
  Logger.log('✓  Pushed funnel + allGroups to ' + owner + '/' + repo + '/' + path);
}

// ── One-time setup: run this once from the Apps Script editor (Run menu) ────────
function installFunnelGroupsDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncFunnelAndGroups_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncFunnelAndGroups_').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Daily Funnel+Groups trigger installed — runs around 3am.');
}
