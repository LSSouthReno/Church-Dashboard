/* =====================================================================================
   ENGAGEMENT — "Know your people. Grow your church."  (North Coast talk, Oct 14 2026)
   - Church › Engagement (public): pathway on a page, engagement score, next steps taken,
     next steps by month, "if you knew, what would you do?" insights, guests + comms.
   - Care › Engagement (pastors): score + opportunities, primed-to-engage lists with
     copy-ready notes, early-warning "drifting" list, donor health by giver stage.
   Reads only data the dashboard already loads (dashboard-data.json, shepherding-data.json,
   the signed-in Care payload). Writes nothing.
   ===================================================================================== */

// One pathway, the same icons everywhere (Church, Care, My Journey, the printed poster).
const ENG_ICONS = {
  worship: '<circle cx="12" cy="13" r="4"/><path d="M12 3v2M4.2 6.2l1.4 1.4M19.8 6.2l-1.4 1.4M2 13h2M20 13h2M3 20h18"/>',
  baptism: '<path d="M12 3c3 4 6 7.5 6 11a6 6 0 01-12 0c0-3.5 3-7 6-11z"/>',
  member: '<path d="M3 11l9-7 9 7M5 10v10h14V10"/>',
  group: '<circle cx="9" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5M14 15.5c3 0 7 1.5 7 4.5"/>',
  serve: '<path d="M12 21s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.5-7 10-7 10z"/>',
  give: '<path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7c-2-4-6-3-6-1s4 1 6 1c2 0 6 1 6-1s-4-3-6 1z"/>',
  lead: '<path d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.7 7.1 18.2 8 12.7 4 8.8 9.5 8z"/>',
  invite: '<path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13"/>'
};
const ENG_STEPS = [
  { k: 'worship', label: 'Worship', line: 'Make Sunday a rhythm' },
  { k: 'baptism', label: 'Baptism', line: 'Go public with your faith' },
  { k: 'member', label: 'Family Member', line: 'Make Living Stones home' },
  { k: 'group', label: 'Group', line: 'Do life with others' },
  { k: 'serve', label: 'Serve', line: 'Use your gifts for others' },
  { k: 'give', label: 'Give', line: 'Live generously' },
  { k: 'lead', label: 'Lead', line: 'Help someone take their next step' }
];
function engIcon(k, cls) { return '<svg class="' + (cls || 'eng-ic') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ENG_ICONS[k] || '') + '</svg>'; }
function engE(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function engN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString(); }
function engPct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function engDate(s) { s = String(s || ''); return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s); }
function engDayOfYear(d) { d = d || new Date(); return Math.max(1, Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5)); }
function engGiveOpen() { try { return typeof mmIsUnlocked === 'function' && mmIsUnlocked(); } catch (e) { return false; } }
function engCopy(text, btn) {
  const label = btn ? (btn.dataset.label || (btn.dataset.label = btn.textContent)) : '';
  const done = () => { if (btn) { if (!/^Copied/.test(btn.textContent)) btn.textContent = 'Copied ✓'; clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = label; }, 2400); } };
  try { navigator.clipboard.writeText(text).then(done, () => { engCopyFallback(text); done(); }); } catch (e) { engCopyFallback(text); done(); }
}
function engCopyFallback(text) { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); }

(function engStyles() {
  const css = `
  .eng { display: grid; gap: 20px; grid-column: 1 / -1; }
  .ch-body .ch-c.eng.on { display: grid; }
  .eng .card { margin: 0; }
  .eng-ic { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .eng-k { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
  .eng-big { font-size: 44px; font-weight: 800; letter-spacing: -.02em; line-height: 1; }
  .eng-muted { color: var(--text-muted); font-size: 13px; line-height: 1.55; }
  .eng-dim { color: var(--text-dim); font-size: 12px; }
  .eng-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
  .eng-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
  @media (max-width: 1000px) { .eng-two, .eng-three { grid-template-columns: 1fr; } }
  .eng-btn { appearance: none; border: 1px solid rgba(212,175,55,.45); background: var(--gold-soft); color: var(--gold); border-radius: 999px; padding: 7px 14px; font: 700 12px 'Montserrat', sans-serif; cursor: pointer; white-space: nowrap; }
  .eng-btn:hover { background: rgba(212,175,55,.22); }
  .eng-btn.g { background: none; border-color: var(--card-border); color: var(--text-muted); }
  .eng-btn.g:hover { color: var(--text); border-color: #444; }
  /* pathway on a page */
  .eng-path { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 440px); gap: 28px; align-items: center; }
  @media (max-width: 1000px) { .eng-path { grid-template-columns: 1fr; } }
  .eng-path h2 { margin-bottom: 6px; }
  .eng-funnel { display: grid; gap: 6px; margin: 16px 0 6px; max-width: 520px; }
  .eng-funnel div { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; background: #191919; border: 1px solid var(--card-border); border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  .eng-funnel div b { font-weight: 700; } .eng-funnel div span { color: var(--text-muted); font-size: 12px; text-align: right; }
  .eng-funnel div:nth-child(2) { margin: 0 14px; } .eng-funnel div:nth-child(3) { margin: 0 28px; } .eng-funnel div:nth-child(4) { margin: 0 42px; border-color: rgba(212,175,55,.35); }
  .eng-wheel { width: 100%; max-width: 440px; height: auto; display: block; margin: 0 auto; }
  .eng-wheel .seg { stroke: var(--bg); stroke-width: 3; cursor: default; transition: opacity .15s; }
  .eng-wheel text { font-family: 'Montserrat', sans-serif; text-anchor: middle; }
  .eng-steps { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
  @media (max-width: 1000px) { .eng-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 560px) {   /* phone: a compact list, not seven tall cards */
    .eng .eng-steps { grid-template-columns: 1fr; gap: 0; margin-top: 8px; }
    .eng .eng-step { display: grid; grid-template-columns: 30px 1fr auto; column-gap: 12px; row-gap: 1px; align-items: center; background: none; border: 0; border-top: 1px solid var(--card-border); border-radius: 0; padding: 11px 2px; text-align: left; justify-items: start; }
    .eng .eng-step .eng-ic { grid-row: 1 / 3; width: 24px; height: 24px; }
    .eng .eng-step b { grid-column: 2; font-size: 14px; } .eng .eng-step .d { grid-column: 2; }
    .eng .eng-step .v { grid-column: 3; grid-row: 1 / 3; font-size: 20px; text-align: right; justify-self: end; }
    .eng .eng-step.lock .v { font-size: 12px; padding-top: 0; }
    .eng button.eng-step { border-style: solid; }
  }
  .eng-step { background: #191919; border: 1px solid var(--card-border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .eng-step .eng-ic { color: var(--gold); width: 24px; height: 24px; }
  .eng-step b { font-size: 13px; } .eng-step .v { font-size: 22px; font-weight: 800; } .eng-step .d { font-size: 11.5px; color: var(--text-muted); line-height: 1.4; }
  button.eng-step { font-family: inherit; color: var(--text); text-align: left; cursor: pointer; border-style: dashed; } button.eng-step:hover { border-color: #555; }
  .eng-strip { display: none; align-items: center; gap: 14px; flex-wrap: wrap; background: linear-gradient(90deg, rgba(212,175,55,.13), rgba(212,175,55,.03)); border: 1px solid rgba(212,175,55,.3); border-radius: 12px; padding: 12px 16px; margin-bottom: 14px; cursor: pointer; font-family: inherit; color: var(--text); text-align: left; width: 100%; }
  .eng-strip.on { display: flex; } .eng-strip:hover { border-color: rgba(212,175,55,.55); }
  .eng-strip .pr { display: inline-flex; align-items: baseline; gap: 7px; margin-right: 10px; }
  .eng-strip b { font-size: 20px; font-weight: 800; } .eng-strip .pr span { color: var(--text-muted); font-size: 13px; } .eng-strip .go { margin-left: auto; color: var(--gold); font-weight: 700; font-size: 13px; }
  @media (max-width: 560px) { .eng-strip { gap: 6px 4px; } .eng-strip .go { width: 100%; margin-left: 0; } .eng-btn { min-height: 40px; padding: 9px 16px; } }
  .eng-step.lock .v { font-size: 13px; color: var(--text-dim); font-weight: 700; padding-top: 6px; }
  /* score */
  .eng-score { display: grid; grid-template-columns: 150px 1fr; gap: 22px; align-items: center; }
  @media (max-width: 560px) { .eng-score { grid-template-columns: 1fr; justify-items: center; } }
  .eng-ring { position: relative; width: 150px; height: 150px; }
  .eng-ring svg { width: 150px; height: 150px; transform: rotate(-90deg); }
  .eng-ring .lbl { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .eng-ring .lbl b { font-size: 36px; font-weight: 800; line-height: 1; } .eng-ring .lbl span { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
  .eng-bar { margin: 6px 0 14px; } .eng-bar .t { display: flex; gap: 10px; justify-content: space-between; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .eng-bar .tr { height: 8px; background: #2a2a2a; border-radius: 99px; overflow: hidden; } .eng-bar .tr i { display: block; height: 100%; background: var(--gold); border-radius: 99px; }
  .eng-opps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
  @media (max-width: 560px) { .eng-opps { grid-template-columns: 1fr; } }
  .eng-opp { background: #191919; border: 1px solid var(--card-border); border-top: 3px solid var(--c, var(--gold)); border-radius: 10px; padding: 12px; text-align: left; font-family: inherit; color: var(--text); }
  button.eng-opp { cursor: pointer; } button.eng-opp:hover { border-color: #444; border-top-color: var(--c, var(--gold)); }
  .eng-opp .k { font-size: 11px; font-weight: 700; color: var(--c, var(--gold)); } .eng-opp .v { font-size: 26px; font-weight: 800; margin: 4px 0 2px; } .eng-opp .d { font-size: 11.5px; color: var(--text-muted); line-height: 1.4; }
  /* next steps */
  .eng-ns { display: grid; gap: 2px; margin-top: 14px; }
  .eng-ns > div { display: grid; grid-template-columns: 26px 1fr auto; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--card-border); }
  .eng-ns .eng-ic { color: var(--gold); } .eng-ns b { font-size: 14px; } .eng-ns small { display: block; color: var(--text-muted); font-size: 12px; margin-top: 2px; }
  .eng-ns .n { font-size: 20px; font-weight: 800; text-align: right; }
  .eng-up { color: var(--green); font-weight: 700; } .eng-dn { color: var(--red); font-weight: 700; } .eng-wn { color: #e0a63c; font-weight: 700; }
  /* insights */
  .eng-ins { background: #191919; border: 1px solid var(--card-border); border-left: 3px solid var(--gold); border-radius: 10px; padding: 14px 16px; }
  .eng-ins .q { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--gold); font-weight: 700; }
  .eng-ins h3 { font-size: 16px; margin: 6px 0 6px; line-height: 1.35; } .eng-ins p { margin: 0 0 10px; }
  /* care view */
  .eng-switch { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--card-border); border-radius: 999px; margin: 0 0 18px; background: #171717; }
  .eng-switch button { appearance: none; border: 0; background: none; color: var(--text-muted); font: 700 12.5px 'Montserrat', sans-serif; padding: 7px 16px; border-radius: 999px; cursor: pointer; }
  .eng-switch button.on { background: var(--gold-soft); color: var(--gold); }
  #pastorModContent.eng-on > :not(.eng-switch):not(#engCare):not(#pastorSeedNote) { display: none !important; }
  #engCare { display: none; } #pastorModContent.eng-on #engCare { display: grid; gap: 20px; }
  #engCare .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px 22px; }
  #engCare h2 { font-size: 18px; font-weight: 700; margin: 0 0 4px; }
  .eng-scope { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: space-between; }
  .eng-scope select { background: #1a1a1a; color: var(--text); border: 1px solid var(--card-border); border-radius: 8px; padding: 7px 10px; font: 600 13px 'Montserrat', sans-serif; }
  .eng-primed { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; margin-top: 14px; }
  .eng-pc { background: #191919; border: 1px solid var(--card-border); border-top: 3px solid var(--c, var(--gold)); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .eng-pc .h { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; } .eng-pc .h .eng-ic { color: var(--c, var(--gold)); }
  .eng-pc .v { font-size: 30px; font-weight: 800; line-height: 1.1; } .eng-pc .why { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .eng-pc .msg { font-size: 12.5px; font-style: italic; color: #cfc8ba; background: #141414; border-radius: 8px; padding: 9px 10px; line-height: 1.5; }
  .eng-pc .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .eng-people { margin-top: 6px; } .eng-people summary { cursor: pointer; font-size: 12.5px; font-weight: 700; color: var(--gold); list-style: none; } .eng-people summary::-webkit-details-marker { display: none; }
  .eng-plist { display: grid; gap: 2px; margin-top: 8px; max-height: 340px; overflow: auto; }
  .eng-prow { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; background: #151515; font-size: 13px; }
  .eng-prow button { appearance: none; border: 0; background: none; color: var(--text); font: 600 13px 'Montserrat', sans-serif; cursor: pointer; padding: 0; text-align: left; } .eng-prow button:hover { color: var(--gold); }
  .eng-chips { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .eng-chip { font-size: 10.5px; font-weight: 700; border-radius: 99px; padding: 2px 7px; background: #262626; color: var(--text-muted); white-space: nowrap; }
  .eng-chip.r { background: rgba(239,68,68,.14); color: #f19a9a; } .eng-chip.y { background: rgba(224,166,60,.14); color: #e9bd6c; } .eng-chip.g { background: rgba(34,197,94,.13); color: #7fd8a0; }
  .eng-donor { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
  @media (max-width: 760px) { .eng-donor { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .eng-stage { display: grid; grid-template-columns: 150px 1fr 54px; gap: 10px; align-items: center; padding: 7px 0; border-top: 1px solid var(--card-border); font-size: 13px; }
  @media (max-width: 560px) { .eng-stage { grid-template-columns: 1fr auto; } .eng-stage > div { grid-column: 1 / -1; order: 3; } }
  .eng-stage .tr { height: 10px; background: #262626; border-radius: 99px; overflow: hidden; } .eng-stage .tr i { display: block; height: 100%; border-radius: 99px; }
  .eng-stage .n { text-align: right; font-weight: 800; }
  .eng-months { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 6px; align-items: end; height: 150px; margin-top: 14px; }
  .eng-months div { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; gap: 4px; font-size: 10.5px; color: var(--text-muted); }
  .eng-months i { display: block; width: 100%; max-width: 34px; background: var(--gold); border-radius: 4px 4px 0 0; min-height: 2px; }
  .eng-months b { font-size: 11px; color: var(--text); }
  `;
  const s = document.createElement('style'); s.id = 'engStyles'; s.textContent = css; document.head.appendChild(s);
})();

/* ─────────────────────────── CHURCH › ENGAGEMENT (public) ─────────────────────────── */
let _engSeedP = null;
function engSeedPeople() {
  // Group + serve memberships (with join dates) for Family Members; public, no names shown here.
  if (!_engSeedP) _engSeedP = fetch((typeof SHEP_DATA_URL !== 'undefined' ? SHEP_DATA_URL : './shepherding-data.json') + '?v=' + Date.now())
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(d => {
      if (!d) return [];
      const seen = new Set(), out = [];
      (d.elders || []).forEach(e => (e.people || []).forEach(p => { const key = p.id || p.name; if (!seen.has(key)) { seen.add(key); out.push(p); } }));
      return out;
    });
  return _engSeedP;
}

function engChurchStats() {
  const D = typeof DASHBOARD_DATA !== 'undefined' ? DASHBOARD_DATA : null; if (!D) return null;
  const now = new Date(), yr = now.getFullYear(), yy = "'" + String(yr).slice(2), mon = now.getMonth();
  const doy = engDayOfYear(now), pace = n => Math.round(n / doy * 365);
  const CG = D.communityGroupsDetailed || {};
  const V = CG.venn4 || {}, R = V.regions || {}, r = k => +R[k] || 0;
  // venn4 regions are a bitmask: 1 Family Member · 2 community group · 4 serving · 8 giving
  const fm = (V.sets || {}).familyMembers || (D.members || {}).current || 0;
  const fmIn = bit => [1, 3, 5, 7, 9, 11, 13, 15].filter(k => k & bit).reduce((a, k) => a + r(k), 0);
  const fm0 = r(1), fm1 = r(3) + r(5) + r(9), fm2 = r(7) + r(11) + r(13), fm3 = r(15);
  const score = fm ? (fm1 + 2 * fm2 + 3 * fm3) / (3 * fm) * 100 : null;
  // weekend attendance, last 4 weeks vs the 4 before
  const wk = []; Object.keys(D.attendanceWeekly || {}).sort().forEach(k => (D.attendanceWeekly[k] || []).forEach(w => wk.push((+w.adults || 0) + (+w.kids || 0))));
  const nz = wk.filter(n => n > 0), mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const att = mean(nz.slice(-4)), attPrev = mean(nz.slice(-8, -4));
  const B = D.baptisms || {};
  const bapMonths = Array(12).fill(0); let bapYtd = 0, bapLast = null;
  (B.months || []).forEach((m, i) => {
    const c = +(B.counts || [])[i] || 0;
    if (String(m).endsWith(yy)) { bapYtd += c; const mi = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(String(m).slice(0, 3)); if (mi >= 0) bapMonths[mi] += c; }
    if (String(m) === "Jan '" + String(yr - 1).slice(2)) bapLast = c;   // earlier years are stored as one yearly total
  });
  const M = D.members || {}, mi = (M.years || []).indexOf(yr), mi1 = (M.years || []).indexOf(yr - 1);
  const memYtd = mi >= 0 ? +M.counts[mi] || 0 : 0, memLast = mi1 >= 0 ? +M.counts[mi1] || 0 : null;
  const J = CG.joinedGroup || {}, jThis = (J[yr] || []).map(n => +n || 0), jLast = (J[yr - 1] || []).map(n => +n || 0);
  const joinYtd = jThis.slice(0, mon + 1).reduce((a, b) => a + b, 0), joinLastSame = jLast.slice(0, mon + 1).reduce((a, b) => a + b, 0);
  const A = CG.appliedToJoin || {}, applyYtd = (A[yr] || []).slice(0, mon + 1).reduce((a, b) => a + (+b || 0), 0);
  const leadersNew = (CG.leadersAdded || {})['total' + yr] || 0;
  const leaders = ((CG.leaderRoster || []).find(x => String(x.phase) === '1') || {}).names || [];
  return {
    D, yr, mon, fm, fm0, fm1, fm2, fm3, score, att, attPrev, bapYtd, bapLast, bapMonths, memYtd, memLast,
    joinYtd, joinLastSame, jThis, applyYtd, leadersNew, leaderCount: leaders.length, pace,
    fmGroup: fmIn(2), fmServe: fmIn(4), fmGive: fmIn(8), cgMembers: (CG.current || {}).members || null,
    cgGoal: (CG.goals2026 || {}).members || null, groups: (CG.current || {}).groups || null,
    serving: D.uniqueVolunteers || null, engagedNotMember: ((V.lists || {}).engagedNotMember || {}).count || r(14),
    known: V.universe || null, newAdults: D.newAdults30d || {}, email: D.emailStats || {}, memberNotInCg: ((V.lists || {}).memberNotInCg || {}).count || null
  };
}

function engWheelSvg(S, open) {
  const segs = [
    ['worship', 'Worship', S.att != null ? engN(S.att) : '—', null],
    ['baptism', 'Baptism', engN(S.bapYtd), null],
    ['member', 'Family', engN(S.fm), 1],
    ['group', 'Group', engPct(S.fmGroup, S.fm) + '%', S.fmGroup / S.fm],
    ['serve', 'Serve', engPct(S.fmServe, S.fm) + '%', S.fmServe / S.fm],
    ['give', 'Give', open ? engPct(S.fmGive, S.fm) + '%' : '🔒', open ? S.fmGive / S.fm : null]
  ];
  const cx = 160, cy = 160, R1 = 150, R0 = 62, n = segs.length, rad = d => d * Math.PI / 180;
  const pt = (r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
  let out = '<svg class="eng-wheel" viewBox="0 0 320 320" role="img" aria-label="Our pathway wheel">';
  segs.forEach((s, i) => {
    const a0 = -90 - 180 / n + i * 360 / n + 1.2, a1 = a0 + 360 / n - 2.4, [x0, y0] = pt(R1, a0), [x1, y1] = pt(R1, a1), [x2, y2] = pt(R0, a1), [x3, y3] = pt(R0, a0);
    const heat = s[3] == null ? .10 : .08 + .34 * Math.max(0, Math.min(1, s[3]));
    out += '<path class="seg" d="M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' A' + R1 + ' ' + R1 + ' 0 0 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' L' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' A' + R0 + ' ' + R0 + ' 0 0 0 ' + x3.toFixed(1) + ' ' + y3.toFixed(1) + 'Z" fill="rgba(212,175,55,' + heat.toFixed(2) + ')"><title>' + engE(s[1] + ': ' + s[2]) + '</title></path>';
    const [ix, iy] = pt((R0 + R1) / 2, (a0 + a1) / 2);
    out += '<g transform="translate(' + (ix - 11).toFixed(1) + ',' + (iy - 30).toFixed(1) + ') scale(.92)" fill="none" stroke="#d4af37" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ENG_ICONS[s[0]] + '</g>';
    out += '<text x="' + ix.toFixed(1) + '" y="' + (iy + 9).toFixed(1) + '" fill="#f3efe6" font-size="11.5" font-weight="700">' + engE(s[1].toUpperCase()) + '</text>';
    out += '<text x="' + ix.toFixed(1) + '" y="' + (iy + 26).toFixed(1) + '" fill="#a39e94" font-size="12.5" font-weight="800">' + engE(s[2]) + '</text>';
  });
  out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (R0 - 8) + '" fill="#191919" stroke="rgba(212,175,55,.5)"/>';
  out += '<g transform="translate(' + (cx - 12) + ',' + (cy - 26) + ')" fill="none" stroke="#d4af37" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ENG_ICONS.lead + '</g>';
  out += '<text x="' + cx + '" y="' + (cy + 13) + '" fill="#f3efe6" font-size="12" font-weight="800">LEAD</text>';
  out += '<text x="' + cx + '" y="' + (cy + 29) + '" fill="#a39e94" font-size="11" font-weight="700">' + engN(S.leaderCount) + ' leaders</text>';
  return out + '</svg>';
}

function engRing(pct, color) {
  const r = 64, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct || 0));
  return '<svg viewBox="0 0 150 150"><circle cx="75" cy="75" r="' + r + '" fill="none" stroke="#2a2a2a" stroke-width="12"/><circle cx="75" cy="75" r="' + r + '" fill="none" stroke="' + (color || '#d4af37') + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + (c * v / 100).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>';
}
function engCmp(now, then, label) {
  if (then == null || !then) return '';
  const d = Math.round((now - then) / then * 100);
  return '<span class="' + (d >= 0 ? 'eng-up' : 'eng-dn') + '">' + (d >= 0 ? '▲ ' : '▼ ') + Math.abs(d) + '%</span> ' + engE(label);
}

// Overview: one line that puts next steps beside attendance and giving ("noses, nickels & next steps")
function engStripRender(tab) {
  let el = document.getElementById('engStrip');
  const tiles = document.getElementById('chTiles');
  if (!el && tiles) { el = document.createElement('button'); el.id = 'engStrip'; el.className = 'eng-strip'; el.onclick = () => chTab('engagement'); tiles.parentNode.insertBefore(el, tiles); }
  if (!el) return;
  el.classList.toggle('on', tab === 'overview');
  if (tab !== 'overview') return;
  const S = engChurchStats(); if (!S) return;
  engSeedPeople().then(seed => {
    let teamYtd = 0; (seed || []).forEach(p => (p.serveTeams || []).forEach(t => { if (new Date(t.joinedAt || '').getFullYear() === S.yr) teamYtd++; }));
    const total = S.bapYtd + S.memYtd + S.joinYtd + teamYtd + S.leadersNew;
    el.innerHTML = engIcon('lead') + '<span class="pr"><b>' + engN(total) + '</b><span>next steps in ' + S.yr + '</span></span><span class="pr"><b>' + (S.score != null ? S.score.toFixed(1) : '—') + '</b><span>engagement score</span></span><span class="go">Engagement →</span>';
  });
}

let _engChart = null;
function engChurchRender() {
  const el = document.getElementById('engChurch'); if (!el) return;
  const S = engChurchStats();
  if (!S) { el.innerHTML = '<div class="card"><div class="eng-muted">Loading…</div></div>'; return; }
  const open = engGiveOpen();
  engSeedPeople().then(seed => engChurchPaint(el, S, open, seed));
}
function engChurchPaint(el, S, open, seed) {
  const yr = S.yr, mon = S.mon;
  // Family Members who joined a serve team this year, by month (from team join dates)
  const teamMonths = Array(12).fill(0); let teamYtd = 0;
  (seed || []).forEach(p => (p.serveTeams || []).forEach(t => { const d = new Date(t.joinedAt || ''); if (d.getFullYear() === yr) { teamMonths[d.getMonth()]++; teamYtd++; } }));
  const totalSteps = S.bapYtd + S.memYtd + S.joinYtd + teamYtd + S.leadersNew;
  const attD = S.att && S.attPrev ? Math.round((S.att - S.attPrev) / S.attPrev * 100) : null;
  const stepCards = [
    ['worship', 'Worship', engN(S.att), 'avg weekend · last 4 weeks' + (attD != null ? ' · ' + (attD >= 0 ? '▲' : '▼') + Math.abs(attD) + '%' : '')],
    ['baptism', 'Baptism', engN(S.bapYtd), 'baptized in ' + yr],
    ['member', 'Family Member', engN(S.fm), '+' + engN(S.memYtd) + ' in ' + yr],
    ['group', 'Group', engPct(S.fmGroup, S.fm) + '%', 'of Family Members · ' + engN(S.cgMembers) + ' people in ' + engN(S.groups) + ' groups'],
    ['serve', 'Serve', engPct(S.fmServe, S.fm) + '%', 'of Family Members · ' + engN(S.serving) + ' serving overall'],
    ['give', 'Give', open ? engPct(S.fmGive, S.fm) + '%' : 'Members only', open ? 'of Family Members gave this year' : 'sign in to see', !open],
    ['lead', 'Lead', engN(S.leaderCount), 'group leaders · +' + engN(S.leadersNew) + ' new in ' + yr]
  ];
  const nsRows = [
    ['group', 'Joined a group', S.joinYtd, engCmp(S.joinYtd, S.joinLastSame, 'vs same months of ' + (yr - 1)) || (engN(S.applyYtd) + ' applied this year')],
    ['baptism', 'Baptized', S.bapYtd, 'on pace for ' + engN(S.pace(S.bapYtd)) + (S.bapLast ? ' · ' + (yr - 1) + ': ' + engN(S.bapLast) : '')],
    ['member', 'Became a Family Member', S.memYtd, 'on pace for ' + engN(S.pace(S.memYtd)) + (S.memLast ? ' · ' + (yr - 1) + ': ' + engN(S.memLast) : '')],
    ['serve', 'Joined a serve team', teamYtd, 'Family Members still on that team'],
    ['lead', 'Started leading a group', S.leadersNew, 'new group leaders added']
  ];
  const fmEngaged = S.fm1 + S.fm2 + S.fm3;
  // "If you knew, what would you do?" — each insight carries the action it implies
  const levers = [['group', 'in a group', S.fmGroup], ['serve', 'on a serve team', S.fmServe]].concat(open ? [['give', 'giving', S.fmGive]] : []).sort((a, b) => a[2] - b[2]);
  const low = levers[0];
  const ins = [
    { q: 'Lever to pull', h: 'Only ' + engPct(low[2], S.fm) + '% of Family Members are ' + low[1] + '.', p: 'It’s the least-taken step on our pathway right now — the place an extra push will move the most people.', a: low[0] === 'group' ? ['Open Groups', "navGo('groups')"] : low[0] === 'serve' ? ['Open Serve', "navGo('serve')"] : ['Care › Engagement', "engOpenCare()"] },
    { q: 'Catch them early', h: engN(S.fm0) + ' Family Members haven’t taken a step yet.', p: 'No group, no team, no giving this year. A personal note from their shepherding pastor beats a church-wide email.', a: ['See who (pastors)', 'engOpenCare()'] },
    { q: 'Ready for more', h: engN(S.engagedNotMember) + ' people are in a group, serving and giving — but aren’t Family Members.', p: 'They’re already living it. Invite them to the next Family Member step personally.', a: ['Care › Engagement', 'engOpenCare()'] }
  ];
  const na = S.newAdults || {}, em = S.email || {};

  el.innerHTML =
    '<div class="card eng-path">' +
      '<div><div class="eng-k">Our pathway · church on a page</div><h2>Every person, one next step</h2>' +
        '<p class="eng-muted" style="max-width:560px">We don’t chase attendance and giving — we help each person take their next step with Jesus. Attendance and giving follow. People enter at the top, find a place on the wheel at their own pace, and the goal is someone who leads and brings others back in.</p>' +
        '<div class="eng-funnel">' +
          '<div><b>Aware</b><span>they know we exist</span></div>' +
          '<div><b>First visit</b><span>' + (na.count30d ? engN(na.count30d) + ' new adults · last 30 days' : 'a test drive, not a sign-up') + '</span></div>' +
          '<div><b>Third visit</b><span>the real goal · not tracked yet</span></div>' +
          '<div><b>Known</b><span>' + (S.known ? engN(S.known) + ' people connected' : 'they raised a hand') + '</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="eng-btn" onclick="engPrintPathway()">Print the pathway poster</button><button class="eng-btn g" onclick="navGo(\'today\')">See My Journey</button></div>' +
      '</div>' +
      '<div>' + engWheelSvg(S, open) + '<div class="eng-dim" style="text-align:center;margin-top:6px">Stronger color = more Family Members have taken that step</div></div>' +
    '</div>' +
    '<div class="card"><div class="eng-k">The seven steps</div><div class="eng-steps">' +
      stepCards.map(c => (c[4] ? '<button class="eng-step lock" onclick="mmShowPrompt(function(){engChurchRender()})">' : '<div class="eng-step">') + engIcon(c[0]) + '<b>' + engE(c[1]) + '</b><span class="v">' + c[2] + '</span><span class="d">' + c[3] + '</span>' + (c[4] ? '</button>' : '</div>')).join('') +
    '</div></div>' +
    '<div class="eng-two">' +
      '<div class="card"><div class="eng-k">How engaged is our church?</div><h2>Engagement score</h2>' +
        '<div class="eng-score"><div class="eng-ring">' + engRing(S.score) + '<div class="lbl"><b>' + (S.score != null ? S.score.toFixed(1) : '—') + '</b><span>out of 100</span></div></div>' +
        '<div><div class="eng-bar"><div class="t"><span>Engaged</span><span>' + engPct(fmEngaged, S.fm) + '%</span></div><div class="tr"><i style="width:' + engPct(fmEngaged, S.fm) + '%"></i></div></div>' +
          '<div class="eng-bar"><div class="t"><span>Fully engaged</span><span>' + engPct(S.fm3, S.fm) + '%</span></div><div class="tr"><i style="width:' + engPct(S.fm3, S.fm) + '%"></i></div></div>' +
          '<div class="eng-dim">Family Members in a group, on a team and giving. Engaged = at least one of the three; the score averages how many each person has.</div></div></div>' +
        '<div class="eng-opps">' +
          '<div class="eng-opp" style="--c:#ef6b6b"><div class="k">Untapped</div><div class="v">' + engN(S.fm0) + '</div><div class="d">Family Members with no group, team or giving</div></div>' +
          '<div class="eng-opp" style="--c:#e0a63c"><div class="k">Growth</div><div class="v">' + engN(S.fm1 + S.fm2) + '</div><div class="d">engaged in some steps, not all three</div></div>' +
          '<div class="eng-opp" style="--c:#22c55e"><div class="k">Fully engaged</div><div class="v">' + engN(S.fm3) + '</div><div class="d">group · team · giving</div></div>' +
        '</div></div>' +
      '<div class="card"><div class="eng-k">Noses, nickels &amp; next steps</div><h2>Next steps taken in ' + yr + '</h2>' +
        '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><span class="eng-big">' + engN(totalSteps) + '</span><span class="eng-muted">steps so far — reported alongside attendance and giving. Movement matters more than the number.</span></div>' +
        '<div class="eng-ns">' + nsRows.map(r => '<div>' + engIcon(r[0]) + '<div><b>' + engE(r[1]) + '</b><small>' + r[3] + '</small></div><span class="n">' + engN(r[2]) + '</span></div>').join('') + '</div></div>' +
    '</div>' +
    '<div class="card"><div class="eng-k">Movement over moments</div><h2>Next steps by month · ' + yr + '</h2><div class="card-sub">Joined a group · baptized · joined a serve team (Family Members). The talk’s finding: a rise in next steps shows up in attendance and giving 90–120 days later.</div>' +
      '<div class="chart-wrap" style="height:260px"><div class="chart-inner" style="height:100%"><canvas id="engMonthChart"></canvas></div></div></div>' +
    '<div class="eng-k" style="margin-top:4px">If you knew, what would you do?</div>' +
    '<div class="eng-three">' + ins.map(i => '<div class="eng-ins"><div class="q">' + engE(i.q) + '</div><h3>' + engE(i.h) + '</h3><p class="eng-muted">' + engE(i.p) + '</p><button class="eng-btn" onclick="' + i.a[1] + '">' + engE(i.a[0]) + ' →</button></div>').join('') + '</div>' +
    '<div class="eng-two">' +
      '<div class="card"><div class="eng-k">Guests</div><h2>The first visit is a test drive</h2><p class="eng-muted">' +
        (na.count30d ? '<b style="color:var(--text)">' + engN(na.count30d) + '</b> new adults in the last 30 days (~' + engN(na.weeklyAvg) + ' a week). ' : '') +
        'They’re still deciding about us, so the goal is a <b style="color:var(--text)">third visit</b>, not a group sign-up — about two in three people who come a third time are still here a year later.</p>' +
        '<p class="eng-dim">Not visible yet: who comes back a 2nd and 3rd time. That needs first-time guest check-in tracked by person.</p></div>' +
      '<div class="card"><div class="eng-k">Messages</div><h2>Journeys, not blasts</h2><p class="eng-muted">' +
        (em.latestCampaign ? 'Last email: <b style="color:var(--text)">' + engE(em.latestCampaign) + '</b> · ' + Math.round((em.latestOpenRate || 0) * 100) + '% opened (recent avg ' + Math.round((em.avgOpenRate3 || 0) * 100) + '%). ' : '') +
        'In church data it takes about <b style="color:var(--text)">14 touches</b> before someone acts (7 in business). Send the right note to the right person — a group invite to someone who already leads a group teaches them to ignore us.</p>' +
        '<p class="eng-dim">Pastors: Care › Engagement has ready-made audiences (primed to connect, serve, be baptized, lead) with copy-ready notes.</p></div>' +
    '</div>';

  // month chart
  try {
    const cv = document.getElementById('engMonthChart'); if (!cv || typeof Chart === 'undefined') return;
    if (_engChart) { try { _engChart.destroy(); } catch (e) {} }
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].slice(0, mon + 1);
    const cut = a => a.slice(0, mon + 1);
    _engChart = new Chart(cv, {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Joined a group', data: cut(S.jThis), backgroundColor: '#d4af37', stack: 's' },
        { label: 'Joined a serve team', data: cut(teamMonths), backgroundColor: '#8fbf98', stack: 's' },
        { label: 'Baptized', data: cut(S.bapMonths), backgroundColor: '#4c9aff', stack: 's' }
      ] },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { labels: { color: '#a39e94', font: { family: 'Montserrat', size: 12 }, boxWidth: 12 } }, tooltip: { mode: 'index', intersect: false } },
        scales: { x: { stacked: true, ticks: { color: '#a39e94' }, grid: { display: false } }, y: { stacked: true, ticks: { color: '#a39e94', precision: 0 }, grid: { color: 'rgba(255,255,255,.06)' } } } }
    });
  } catch (e) { console.error(e); }
}

function engOpenCare() {
  try { sessionStorage.setItem('eng_care_view', 'eng'); } catch (e) {}
  if (typeof navGo === 'function') navGo('care');
  if (document.getElementById('engSwitch')) engCareView('eng');
}

function engPrintPathway() {
  const w = window.open('', '_blank'); if (!w) return;
  w.document.write(engPosterHtml(true));
  w.document.close();
}
function engPosterHtml(print) {
  const icon = k => '<svg viewBox="0 0 24 24" fill="none" stroke="#b8932a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + ENG_ICONS[k] + '</svg>';
  return ('<!doctype html><html><head><meta charset="utf-8"><title>Our Pathway · Living Stones South Reno</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;800&display=swap" rel="stylesheet">' +
    '<style>@page{size:letter portrait;margin:.45in}body{font-family:Montserrat,sans-serif;color:#1a1a1a;margin:0;text-align:center}' +
    '.logo{height:54px;filter:invert(1);margin:.1in 0 .18in}' +
    'h1{font-size:62px;font-weight:800;letter-spacing:.02em;margin:0 0 8px;text-transform:uppercase;line-height:1}.sub{font-size:19px;color:#555;margin-bottom:.4in}' +
    '.steps{display:grid;grid-template-columns:repeat(2,1fr);gap:22px 24px;text-align:left;max-width:7.4in;margin:0 auto}' +
    '.s{display:flex;gap:18px;align-items:center;border:2.5px solid #e8dcb5;border-radius:18px;padding:22px 20px}.s svg{width:64px;height:64px;flex:none}' +
    '.s b{display:block;font-size:26px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;line-height:1.1}.s span{font-size:16.5px;color:#555}' +
    '.s:last-child{grid-column:1/-1;justify-content:center;border-color:#b8932a;background:#fbf7ea}.foot{margin-top:.45in;font-size:18px;color:#555}.foot b{color:#1a1a1a}' +
    '</style></head><body><img class="logo" src="' + location.origin + '/assets/ls-lockup-white.png" alt="Living Stones South Reno"><h1>Your next step</h1><div class="sub">Wherever you are, there’s a next step with Jesus</div><div class="steps">' +
    ENG_STEPS.map(s => '<div class="s">' + icon(s.k) + '<div><b>' + engE(s.label) + '</b><span>' + engE(s.line) + '</span></div></div>').join('') +
    '</div><div class="foot">See where you are and your next step: <b>lssouthreno.com/journey</b></div>' +
    (print ? '<script>setTimeout(function(){window.print()},700)<\/script>' : '') + '</body></html>');
}

/* ─────────────────────────────── CARE › ENGAGEMENT (pastors) ─────────────────────────────── */
let _engCareView = (function () { try { return sessionStorage.getItem('eng_care_view') || 'people'; } catch (e) { return 'people'; } })();
let _engScope = 'all';

function engCareMount() {
  const host = document.getElementById('pastorModContent'); if (!host) return null;
  if (!document.getElementById('engSwitch')) {
    const sw = document.createElement('div');
    sw.className = 'eng-switch'; sw.id = 'engSwitch';
    sw.innerHTML = '<button data-v="people" onclick="engCareView(\'people\')">People</button><button data-v="eng" onclick="engCareView(\'eng\')">Engagement</button>';
    const seed = document.getElementById('pastorSeedNote');
    host.insertBefore(sw, seed ? seed.nextSibling : host.firstChild);
    const box = document.createElement('div'); box.id = 'engCare';
    host.appendChild(box);
  }
  return document.getElementById('engCare');
}
function engCareView(v) {
  _engCareView = v === 'eng' ? 'eng' : 'people';
  try { sessionStorage.setItem('eng_care_view', _engCareView); } catch (e) {}
  const host = document.getElementById('pastorModContent'); if (!host) return;
  host.classList.toggle('eng-on', _engCareView === 'eng');
  document.querySelectorAll('#engSwitch button').forEach(b => b.classList.toggle('on', b.dataset.v === _engCareView));
  if (_engCareView === 'eng') engCareRender();
}
// Called by shApplyData() each time Care data arrives or refreshes.
function engOnCareData() {
  if (!engCareMount()) return;
  try { _engCareView = sessionStorage.getItem('eng_care_view') || _engCareView; } catch (e) {}
  engCareView(_engCareView);
}

function engCarePeople() {
  const data = typeof _shepData !== 'undefined' ? _shepData : null; if (!data) return [];
  const seen = new Set(), out = [];
  (data.elders || []).forEach(e => {
    if (_engScope !== 'all' && e.elder !== _engScope) return;
    (e.people || []).forEach(p => { const key = p.id || p.name; if (!seen.has(key)) { seen.add(key); out.push(p); } });
  });
  return out;
}
function engFacts(p) {
  const g = p.giving || null;
  return {
    group: (p.groups || []).length > 0, serve: (p.serveTeams || []).length > 0, lead: !!p.leads, baptized: !!p.baptized,
    give: !!(g && g.monthsGiven > 0), giveRegular: !!(g && g.givesRegular), g,
    away: /wandering|lost|could-not-contact/.test(p.status || ''), weak: p.status === 'weak'
  };
}
function engDonorStage(p) {
  const g = p.giving; if (!g) return null;
  if (!g.monthsGiven) return 'none';
  if (g.giftsEarlyHalf > 0 && !g.giftsRecentHalf) return 'lapsed';
  if (g.trend === 'down') return 'declining';
  if (g.trend === 'up') return 'growing';
  if (g.givesRegular) return 'regular';
  return 'occasional';
}
const ENG_DONOR = [
  ['growing', 'Growing or new', '#22c55e', 'Giving more than the year before, or started this year', 'Thank them personally and celebrate the story, not the amount.'],
  ['regular', 'Steady', '#8fbf98', 'Consistent through the year', 'Show them the fruit — a baptism story, a family their giving helped.'],
  ['occasional', 'Occasional', '#d4af37', 'Gave in some months', 'Generosity as a rhythm: how recurring giving frees them up.'],
  ['declining', 'Declining', '#e0a63c', 'Giving less than the year before', 'Don’t talk money first — ask how they’re doing. Life may have changed.'],
  ['lapsed', 'Lapsed', '#ef6b6b', 'Gave 6–12 months ago, nothing since', 'Often the first sign someone is drifting. A pastoral check-in, not an appeal.'],
  ['none', 'Not giving yet', '#6f6a62', 'No gift in the last 12 months', 'Generosity as a spiritual step for them — never what the church needs.']
];

function engPersonRow(p, chips) {
  const pid = p.id ? JSON.stringify(String(p.id)).replace(/"/g, '&quot;') : null;
  return '<div class="eng-prow">' + (pid ? '<button onclick="shOpenDrawer(' + pid + ')">' + engE(p.name) + '</button>' : '<span>' + engE(p.name) + '</span>') +
    '<span class="eng-chips">' + (chips || []).map(c => '<span class="eng-chip ' + (c[1] || '') + '">' + engE(c[0]) + '</span>').join('') + '</span></div>';
}
let _engLists = {};
function engListBtns(key, people) {
  _engLists[key] = people;
  return '<button class="eng-btn g" onclick="engCopyList(\'' + key + '\',\'email\',this)">Copy emails</button><button class="eng-btn g" onclick="engCopyList(\'' + key + '\',\'name\',this)">Copy names</button>';
}
function engCopyList(key, what, btn) {
  const ps = _engLists[key] || [];
  const vals = what === 'email' ? ps.map(p => p.email).filter(Boolean) : ps.map(p => p.name);
  engCopy(vals.join(what === 'email' ? ', ' : '\n'), btn);
  const miss = what === 'email' ? ps.length - vals.length : 0;
  if (btn) setTimeout(() => { btn.textContent = 'Copied ' + vals.length + (miss ? ' · ' + miss + ' no email' : ''); }, 0);
}
function engPeopleDetails(people, chipFn, label) {
  if (!people.length) return '<div class="eng-dim">Nobody right now.</div>';
  return '<details class="eng-people"><summary>' + engE(label || ('See ' + people.length + (people.length === 1 ? ' person' : ' people'))) + ' ▾</summary><div class="eng-plist">' +
    people.slice().sort((a, b) => String(a.last || a.name).localeCompare(String(b.last || b.name))).map(p => engPersonRow(p, chipFn ? chipFn(p) : [])).join('') + '</div></details>';
}

function engCareRender() {
  const box = engCareMount(); if (!box) return;
  const data = typeof _shepData !== 'undefined' ? _shepData : null;
  if (!data) { box.innerHTML = '<div class="card eng-muted">Loading…</div>'; return; }
  if (_engScope !== 'all' && !(data.elders || []).some(e => e.elder === _engScope)) _engScope = 'all';
  const seed = !!data.seed;
  const people = engCarePeople(), F = new Map(people.map(p => [p, engFacts(p)]));
  const n = people.length || 1;
  // score: baptized · group · serve · giving (each 25); lead is celebrated, not scored
  const steps = p => { const f = F.get(p); return seed ? (f.group ? 1 : 0) + (f.serve ? 1 : 0) : (f.baptized ? 1 : 0) + (f.group ? 1 : 0) + (f.serve ? 1 : 0) + (f.give ? 1 : 0); };
  const score = people.reduce((a, p) => a + steps(p), 0) / ((seed ? 2 : 4) * n) * 100;
  const engaged = people.filter(p => { const f = F.get(p); return f.group || f.serve || f.give; });
  const full = people.filter(p => { const f = F.get(p); return f.baptized && f.group && f.serve && f.give; });
  const reconnect = people.filter(p => F.get(p).away);
  const untapped = people.filter(p => { const f = F.get(p); return !f.away && !f.group && !f.serve && !f.give; });
  const growth = people.filter(p => { const f = F.get(p); return !f.away && (f.group || f.serve || f.give) && !(f.baptized && f.group && f.serve && f.give); });
  const stepChips = p => { const f = F.get(p); return [[f.baptized ? 'baptized' : 'not baptized', f.baptized ? 'g' : ''], [f.group ? 'group' : 'no group', f.group ? 'g' : ''], [f.serve ? 'serving' : 'not serving', f.serve ? 'g' : ''], [f.give ? 'giving' : 'not giving', f.give ? 'g' : '']]; };

  const primed = [
    { k: 'connect', icon: 'group', c: '#d4af37', t: 'Primed to connect', why: 'Serving or giving regularly, but not in a group yet.',
      ps: people.filter(p => { const f = F.get(p); return !f.away && !f.group && (f.serve || f.giveRegular); }),
      msg: 'Hi {first} — thank you for how you show up at Living Stones. I’d love to help you find a group; it’s where most of us found real friends here. Can I send you a couple that fit your week?' },
    { k: 'serve', icon: 'serve', c: '#8fbf98', t: 'Primed to serve', why: 'In a group, not on a serve team yet.',
      ps: people.filter(p => { const f = F.get(p); return !f.away && f.group && !f.serve; }),
      msg: 'Hi {first} — I’ve loved seeing you grow in your group. Have you thought about serving on Sundays? There’s a spot that fits how God made you, and I’d be glad to help you find it.' },
    { k: 'baptism', icon: 'baptism', c: '#4c9aff', t: 'Primed for baptism', why: 'Connected in a group or on a team, not baptized yet.',
      ps: seed ? [] : people.filter(p => { const f = F.get(p); return !f.away && !f.baptized && (f.group || f.serve); }),
      msg: 'Hi {first} — it’s been so good to see your faith grow. Have you ever thought about being baptized? I’d love to grab coffee and talk about it — no pressure at all.' },
    { k: 'lead', icon: 'lead', c: '#b48cff', t: 'Primed to lead', why: 'Baptized, in a group, serving and giving — not leading yet.',
      ps: seed ? [] : people.filter(p => { const f = F.get(p); return !f.away && f.baptized && f.group && f.serve && f.give && !f.lead; }),
      msg: 'Hi {first} — I see how you care for people. Would you pray about helping lead (a group or a team)? I think others would grow by following you, and we’d walk with you every step.' },
    { k: 'give', icon: 'give', c: '#e0a63c', t: 'Primed to give', why: 'In a group and serving, no gift in the last year.',
      ps: seed ? [] : people.filter(p => { const f = F.get(p); return !f.away && f.group && f.serve && !f.give; }),
      msg: 'Hi {first} — thank you for giving your time so faithfully. Generosity has been one of the most freeing parts of following Jesus for me; I’d love to share how it grew my faith.' }
  ];

  // Early warning — the signs that showed up before people left (look-alike, lite version)
  const drift = people.map(p => {
    const f = F.get(p), g = f.g, sig = [];
    if (g && g.giftsEarlyHalf >= 2 && !g.giftsRecentHalf) sig.push(['giving stopped', 'r']);
    else if (g && g.trend === 'down') sig.push(['giving down', 'y']);
    if (f.weak) sig.push(['health: weak', 'y']);
    if (p.status === 'wandering') sig.push(['wandering', 'r']);
    if (!f.group && !f.serve) sig.push(['no group or team', 'y']);
    if (p.overdue) sig.push(['check-in overdue', '']);
    return { p, sig };
  }).filter(x => x.p.status !== 'lost' && x.sig.length >= 2 && x.sig.some(s => s[1] === 'r' || s[0] === 'giving down' || s[0] === 'health: weak'))
    .sort((a, b) => b.sig.length - a.sig.length);

  // Donor health
  const stages = {}; ENG_DONOR.forEach(d => { stages[d[0]] = []; });
  people.forEach(p => { const s = engDonorStage(p); if (s && stages[s]) stages[s].push(p); });
  const givers = people.filter(p => p.giving && p.giving.monthsGiven > 0).length;
  const maxStage = Math.max(1, ...ENG_DONOR.map(d => stages[d[0]].length));

  // Next steps taken by month (this year) from dated records
  const yr = new Date().getFullYear(), months = Array(12).fill(0);
  const bump = iso => { const d = engDate(iso); if (d.getFullYear() === yr) months[d.getMonth()]++; };
  people.forEach(p => {
    const D = p.importantDates || {};
    bump(D.baptism); bump(D.membershipStart);
    (p.groups || []).forEach(x => bump(x.joinedAt)); (p.serveTeams || []).forEach(x => bump(x.joinedAt));
  });
  const stepsYtd = months.reduce((a, b) => a + b, 0), mMax = Math.max(1, ...months), curM = new Date().getMonth();

  const scopeOpts = '<option value="all">Whole church</option>' + (data.elders || []).filter(e => !e.unassigned).map(e => '<option value="' + engE(e.elder) + '"' + (_engScope === e.elder ? ' selected' : '') + '>' + engE(e.elder) + '’s list</option>').join('');
  _engLists = {};
  box.innerHTML =
    '<div class="eng-scope"><div class="eng-muted">Know your people · ' + engN(people.length) + ' people in view. Data is knowledge to shepherd with, never to pressure.</div>' +
      '<select onchange="_engScope=this.value;engCareRender()">' + scopeOpts + '</select></div>' +
    (seed ? '<div class="card eng-muted">Live Care data hasn’t loaded, so baptism and giving are missing below. Reload Care once signed in.</div>' : '') +
    '<div class="card"><h2>Engagement score</h2><div class="eng-dim">' + (seed ? 'Preview: group and serving only until live data loads.' : 'Baptized · in a group · serving · giving — each person’s share of the four, averaged.') + '</div>' +
      '<div class="eng-score" style="margin-top:14px"><div class="eng-ring">' + engRing(score) + '<div class="lbl"><b>' + score.toFixed(1) + '</b><span>out of 100</span></div></div><div>' +
        '<div class="eng-bar"><div class="t"><span>Engaged (group, team or giving)</span><span>' + engPct(engaged.length, n) + '%</span></div><div class="tr"><i style="width:' + engPct(engaged.length, n) + '%"></i></div></div>' +
        '<div class="eng-bar"><div class="t"><span>Fully engaged (all four)</span><span>' + engPct(full.length, n) + '%</span></div><div class="tr"><i style="width:' + engPct(full.length, n) + '%"></i></div></div>' +
      '</div></div>' +
      '<div class="eng-opps">' +
        '<div class="eng-opp" style="--c:#ef6b6b"><div class="k">Reconnect</div><div class="v">' + engN(reconnect.length) + '</div><div class="d">wandering, lost or can’t reach</div>' + engPeopleDetails(reconnect, p => [[p.status || '', 'r'], [p.assignedElder ? p.assignedElder.split(' ')[0] : '', '']]) + '</div>' +
        '<div class="eng-opp" style="--c:#e0a63c"><div class="k">Untapped</div><div class="v">' + engN(untapped.length) + '</div><div class="d">no group, team or giving yet</div>' + engPeopleDetails(untapped, stepChips) + '</div>' +
        '<div class="eng-opp" style="--c:#22c55e"><div class="k">Growth</div><div class="v">' + engN(growth.length) + '</div><div class="d">some steps taken, not all four</div>' + engPeopleDetails(growth, stepChips) + '</div>' +
      '</div></div>' +
    '<div class="card"><h2>Primed to engage</h2><div class="eng-dim">The right note to the right person — each list skips people already past that step. Copy the emails into one message per list, or better, call.</div>' +
      '<div class="eng-primed">' + primed.map(pr => '<div class="eng-pc" style="--c:' + pr.c + '"><div class="h">' + engIcon(pr.icon) + engE(pr.t) + '</div><div class="v">' + (seed && !pr.ps.length && pr.k !== 'connect' && pr.k !== 'serve' ? '—' : engN(pr.ps.length)) + '</div>' +
        '<div class="why">' + engE(pr.why) + ' ' + engPct(pr.ps.length, n) + '% of people in view.</div>' +
        '<div class="msg">' + engE(pr.msg.replace('{first}', '[first name]')) + '</div>' +
        '<div class="acts"><button class="eng-btn" onclick="engCopy(' + JSON.stringify(pr.msg.replace('{first}', '[first name]')).replace(/"/g, '&quot;') + ',this)">Copy note</button>' + engListBtns('pr_' + pr.k, pr.ps) + '</div>' +
        engPeopleDetails(pr.ps, stepChips) + '</div>').join('') + '</div></div>' +
    '<div class="eng-two">' +
      '<div class="card"><h2>Drifting — reach out now</h2><div class="eng-dim">People showing the signs that came before others left: giving stopped or dropping, a weak or wandering health check, no group or team. Call them six months <i>before</i> they go, not after.</div>' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:12px 0 4px"><span class="eng-big" style="font-size:36px">' + engN(drift.length) + '</span><span class="eng-muted">people</span><span style="margin-left:auto">' + engListBtns('drift', drift.map(x => x.p)) + '</span></div>' +
        (drift.length ? '<div class="eng-plist" style="max-height:420px">' + drift.map(x => engPersonRow(x.p, x.sig.concat(x.p.assignedElder ? [[x.p.assignedElder.split(' ')[0], '']] : []))).join('') + '</div>' : '<div class="eng-dim">Nobody is showing two or more warning signs right now.</div>') +
      '</div>' +
      '<div class="card"><h2>Next steps taken · ' + yr + '</h2><div class="eng-dim">Baptisms, Family Member starts, and group and team joins, by month, for the people in view.</div>' +
        '<div style="display:flex;align-items:baseline;gap:10px;margin-top:12px"><span class="eng-big" style="font-size:36px">' + engN(stepsYtd) + '</span><span class="eng-muted">steps so far this year</span></div>' +
        '<div class="eng-months">' + months.map((v, i) => '<div' + (i > curM ? ' style="opacity:.25"' : '') + '><b>' + (i <= curM ? v : '') + '</b><i style="height:' + Math.round(v / mMax * 100) + '%"></i>' + ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][i] + '</div>').join('') + '</div>' +
      '</div>' +
    '</div>' +
    (seed ? '' :
    '<div class="card"><h2>Donor health</h2><div class="eng-dim">Giving is a spiritual step. Talk about it always — just not the same way to everyone, and always for the giver’s good. Spouses who give together each count as a giver.</div>' +
      '<div class="eng-donor">' +
        '<div class="eng-opp"><div class="k">Givers · 12 months</div><div class="v">' + engN(givers) + '</div><div class="d">' + engPct(givers, n) + '% of people in view</div></div>' +
        '<div class="eng-opp" style="--c:#22c55e"><div class="k">Growing</div><div class="v">' + engN(stages.growing.length) + '</div><div class="d">giving more than last year, or new</div></div>' +
        '<div class="eng-opp" style="--c:#e0a63c"><div class="k">Declining</div><div class="v">' + engN(stages.declining.length) + '</div><div class="d">giving less than last year</div></div>' +
        '<div class="eng-opp" style="--c:#ef6b6b"><div class="k">Lapsed</div><div class="v">' + engN(stages.lapsed.length) + '</div><div class="d">stopped in the last 6 months</div></div>' +
      '</div><div style="margin-top:14px">' +
      ENG_DONOR.map(d => '<div class="eng-stage"><span><b>' + engE(d[1]) + '</b><br><span class="eng-dim">' + engE(d[3]) + '</span></span><div><div class="tr"><i style="width:' + Math.round(stages[d[0]].length / maxStage * 100) + '%;background:' + d[2] + '"></i></div><div class="eng-dim" style="margin-top:5px">' + engE(d[4]) + '</div>' +
        engPeopleDetails(stages[d[0]], p => [[(p.giving.monthsGiven || 0) + ' of 12 mo', ''], [p.giving.recurring ? 'recurring' : '', p.giving.recurring ? 'g' : '']].filter(c => c[0])) + '</div><span class="n">' + engN(stages[d[0]].length) + '</span></div>').join('') +
      '</div></div>');
}
