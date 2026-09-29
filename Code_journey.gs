/**
 * My Journey — a private, per-person faith-journey page (lssouthreno.com/journey).
 * ================================================================================
 * LINK-ONLY for now (not linked from the site; pastors can preview anyone from the
 * Shepherding drawer). Everything here is written TO the person, with a shepherd's heart:
 * no health status, no PACI, no pastoral notes, no dollar amounts.
 *
 * Sign-in (each person individually; nothing shared):
 *   • Phone code — Twilio Verify texts a 6-digit code. Needs Script Properties
 *       TWILIO_SID, TWILIO_TOKEN, TWILIO_VERIFY_SID.
 *   • Sign in with Planning Center — PCO OAuth (their PCO phone/email + password). Needs
 *       Script Properties PCO_OAUTH_CLIENT_ID, PCO_OAUTH_SECRET; redirect URI
 *       https://lssouthreno.com/journey/ registered on the PCO OAuth app.
 *   Until those are set, that method reports "not configured" and the page hides it.
 * A signed-in device gets a random token (90 days); only its SHA-256 is stored
 * (hidden "JourneySessions" tab of the bound sheet).
 *
 * POST actions (JSON body, dispatched from doPost in Code_eos_webapp.gs via JR_POST_ACTIONS_):
 *   jr_config · jr_phone_start · jr_phone_verify · jr_pick · jr_oauth_start · jr_oauth_finish
 *   jr_me (token, or preview: pid + pastor hash pw) · jr_note (note / prayer to their pastor)
 *   jr_logout
 * Reads PCO with the finance PAT (pcoGet_/PCO_API) — the dashboard app creds return blank
 * group names — and jgUnit_ so joint givers count together.
 */

var JR_ = {
  SESSION_DAYS: 90,
  REDIRECT: 'https://lssouthreno.com/journey/',
  TAB: 'JourneySessions',
  CACHE_MIN: 10,
  WF: { requested: '564704', ready: '528797', family: '528798', cgLeader: '535815' },
  CG_TYPE: '441907',
  NOTE_CAT: { note: '239853', prayer: '234652' },          // Pastoral Care · Prayer Requests
  // Where each next step's button goes. Adjust freely.
  LINKS: {
    groups:     'https://lssr.churchcenter.com/groups',
    serve:      'https://lssr.churchcenter.com/groups/serve-teams?enrollment=open_signup%2Crequest_to_join&filter=enrollment',
    giving:     'https://lssr.churchcenter.com/giving',
    baptism:    'https://lssr.churchcenter.com/people/forms/764941',
    membership: 'https://livingstoneschurches.com/lssr-membership',
    churchCenter: 'https://lssr.churchcenter.com/me'
  }
};
var JR_POST_ACTIONS_ = ['jr_config', 'jr_phone_start', 'jr_phone_verify', 'jr_pick', 'jr_magic', 'jr_diag', 'jr_oauth_start',
                        'jr_oauth_finish', 'jr_me', 'jr_note', 'jr_logout'];

function jrDoPost_(body) {
  var a = String(body.action || '');
  try {
    if (a === 'jr_config')       return eosWaJson_(jrConfig_());
    if (a === 'jr_phone_start')  return eosWaJson_(jrPhoneStart_(body));
    if (a === 'jr_phone_verify') return eosWaJson_(jrPhoneVerify_(body));
    if (a === 'jr_pick')         return eosWaJson_(jrPick_(body));
    if (a === 'jr_magic')        return eosWaJson_(jrMagic_(body));
    if (a === 'jr_diag')         return eosWaJson_(jrDiag_(body));
    if (a === 'jr_oauth_start')  return eosWaJson_(jrOauthStart_());
    if (a === 'jr_oauth_finish') return eosWaJson_(jrOauthFinish_(body));
    if (a === 'jr_me')           return eosWaJson_(jrMe_(body));
    if (a === 'jr_note')         return eosWaJson_(jrNote_(body));
    if (a === 'jr_logout')       return eosWaJson_(jrLogout_(body));
  } catch (e) { return eosWaJson_({ ok: false, error: 'Something went wrong — please try again.', detail: e.message }); }
  return eosWaJson_({ ok: false, error: 'Unknown action' });
}

function jrProp_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
// Phone sign-in is always on: they type their phone number; the code goes by TEXT when
// Twilio is set up, otherwise to the EMAIL on their PCO profile (one-tap link + code).
// No passwords anywhere (Brad: "seamless and simple but secure").
function jrSmsOn_() { return !!(jrProp_('TWILIO_SID') && jrProp_('TWILIO_TOKEN') && jrProp_('TWILIO_VERIFY_SID')); }
function jrConfig_() {
  return { ok: true, phone: true, channel: jrSmsOn_() ? 'sms' : 'email',
    pco: !!(jrProp_('PCO_OAUTH_CLIENT_ID') && jrProp_('PCO_OAUTH_SECRET')) };
}
function jrHash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s)).map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function jrRandom_() { return jrHash_(Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Date.now() + ':' + Math.random()); }
function jrGet_(path) { try { return pcoGet_(PCO_API + path); } catch (e) { return null; } }

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────
function jrSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(JR_.TAB);
  if (!sh) { sh = ss.insertSheet(JR_.TAB); sh.appendRow(['tokenHash', 'pid', 'method', 'createdAt', 'expiresAt', 'lastSeen']); sh.setFrozenRows(1); try { sh.hideSheet(); } catch (x) {} }
  return sh;
}
function jrNewSession_(pid, method) {
  var token = jrRandom_(), now = Date.now(), exp = now + JR_.SESSION_DAYS * 864e5;
  jrSheet_().appendRow([jrHash_(token), String(pid), method, now, exp, now]);
  CacheService.getScriptCache().put('jr_s_' + jrHash_(token), JSON.stringify({ pid: String(pid), exp: exp }), 21600);
  return { ok: true, token: token, expiresAt: exp };
}
function jrSessionPid_(token) {
  if (!token) return null;
  var h = jrHash_(token), c = CacheService.getScriptCache(), hit = c.get('jr_s_' + h);
  if (hit) { var o = JSON.parse(hit); return o.exp > Date.now() ? o.pid : null; }
  var sh = jrSheet_(), v = sh.getDataRange().getValues();
  for (var r = v.length - 1; r >= 1; r--) {
    if (String(v[r][0]) !== h) continue;
    if (Number(v[r][4]) < Date.now()) return null;
    try { sh.getRange(r + 1, 6).setValue(Date.now()); } catch (x) {}
    c.put('jr_s_' + h, JSON.stringify({ pid: String(v[r][1]), exp: Number(v[r][4]) }), 21600);
    return String(v[r][1]);
  }
  return null;
}
function jrLogout_(body) {
  var h = jrHash_(String(body.token || '')), sh = jrSheet_(), v = sh.getDataRange().getValues();
  for (var r = v.length - 1; r >= 1; r--) if (String(v[r][0]) === h) sh.getRange(r + 1, 5).setValue(0);
  CacheService.getScriptCache().remove('jr_s_' + h);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone code (Twilio Verify)
// ─────────────────────────────────────────────────────────────────────────────
function jrE164_(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
  return '';
}
function jrPeopleByPhone_(e164) {
  var ten = e164.replace(/^\+1/, ''), out = {}, seen = {};
  var r = jrGet_('/people/v2/people?where[search_name_or_email_or_phone_number]=' + ten + '&include=phone_numbers&per_page=25');
  var nums = {};
  ((r && r.included) || []).forEach(function(i) { if (i.type === 'PhoneNumber') nums[i.id] = String((i.attributes || {}).number || '').replace(/\D/g, '').slice(-10); });
  ((r && r.data) || []).forEach(function(p) {
    var ids = ((((p.relationships || {}).phone_numbers || {}).data) || []).map(function(x) { return x.id; });
    if (!ids.some(function(id) { return nums[id] === ten; }) || seen[p.id]) return;
    seen[p.id] = 1;
    var a = p.attributes || {};
    if (a.status && String(a.status) !== 'active') return;
    out[p.id] = { pid: p.id, first: a.first_name || '', last: a.last_name || '', child: !!a.child };
  });
  return Object.keys(out).map(function(k) { return out[k]; });
}
function jrTwilio_(path, payload) {
  var res = UrlFetchApp.fetch('https://verify.twilio.com/v2/Services/' + jrProp_('TWILIO_VERIFY_SID') + path, {
    method: 'post', muteHttpExceptions: true, payload: payload,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(jrProp_('TWILIO_SID') + ':' + jrProp_('TWILIO_TOKEN')) } });
  var j = null; try { j = JSON.parse(res.getContentText()); } catch (x) {}
  return { code: res.getResponseCode(), json: j };
}
function jrPhoneStart_(body) {
  var e164 = jrE164_(body.phone);
  if (!e164) return { ok: false, error: 'Please enter a 10-digit phone number.' };
  var c = CacheService.getScriptCache(), k = 'jr_rate_' + jrHash_(e164), n = Number(c.get(k) || 0);
  if (n >= 4) return { ok: false, error: 'Too many tries — please wait 15 minutes and try again.' };
  c.put(k, String(n + 1), 900);
  // Only contact numbers that belong to someone at Living Stones — and give the SAME reply
  // either way, so nobody can use this to learn whether a number is in our records.
  var ppl = jrPeopleByPhone_(e164).filter(function(p) { return !p.child; });
  jrLog_({ step: 'start', phone: '…' + e164.slice(-4), matches: ppl.length });
  if (!ppl.length) return { ok: true, sent: true, channel: jrConfig_().channel };
  if (jrSmsOn_()) { jrTwilio_('/Verifications', { To: e164, Channel: 'sms' }); return { ok: true, sent: true, channel: 'sms' }; }
  jrEmailCodes_(e164, ppl);
  return { ok: true, sent: true, channel: 'email' };
}

// Email channel: every adult with that phone gets THEIR OWN one-tap link + 6-digit code, sent
// only to the email on their own PCO profile. Codes/links are single-use and last 15 minutes.
function jrEmailCodes_(e164, ppl) {
  var c = CacheService.getScriptCache(), pending = [];
  ppl.forEach(function(p) {
    var email = jrPrimaryEmail_(p.pid); if (!email) return;
    var code = ('000000' + (parseInt(jrRandom_().slice(0, 10), 16) % 1000000)).slice(-6);
    var magic = jrRandom_();
    pending.push({ pid: p.pid, code: jrHash_(code + ':' + e164) });
    c.put('jr_ml_' + jrHash_(magic), String(p.pid), 900);
    var link = JR_.REDIRECT + '?m=' + magic;
    var html = '<div style="font-family:Montserrat,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 22px;color:#1a1a1a">' +
      '<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#a07d20;font-weight:700">Living Stones South Reno</div>' +
      '<h1 style="font-size:24px;margin:10px 0 8px">Hi ' + jrEsc_(p.first) + ', here’s your sign-in</h1>' +
      '<p style="font-size:15px;line-height:1.6;color:#444;margin:0 0 22px">Tap the button to open your private My Journey page on this phone.</p>' +
      '<a href="' + link + '" style="display:inline-block;background:#d4af37;color:#1a1407;text-decoration:none;font-weight:800;font-size:16px;padding:14px 26px;border-radius:10px">Open my journey</a>' +
      '<p style="font-size:14px;line-height:1.6;color:#444;margin:24px 0 6px">Signing in on a different device? Enter this code:</p>' +
      '<div style="font-size:30px;font-weight:800;letter-spacing:.3em;color:#1a1a1a">' + code + '</div>' +
      '<p style="font-size:12.5px;line-height:1.6;color:#888;margin:26px 0 0">This link and code work once and expire in 15 minutes. Your page is private — only you and the pastors who care for you can see it. If you didn’t ask to sign in, you can ignore this email.</p></div>';
    var msg = { to: email, subject: 'Your Living Stones sign-in: ' + code, name: 'Living Stones South Reno', htmlBody: html,
      body: 'Hi ' + p.first + ',\n\nOpen your private My Journey page: ' + link + '\n\nOr enter this code: ' + code + '\n\nThis link and code work once and expire in 15 minutes. If you didn’t ask to sign in, ignore this email.' };
    var how = 'noReply';
    try { MailApp.sendEmail(Object.assign({ noReply: true }, msg)); }
    catch (e) { how = 'noReply failed (' + e.message + ')'; try { MailApp.sendEmail(msg); how += ' → sent from account'; } catch (e2) { how += ' → FAILED: ' + e2.message; } }
    jrLog_({ step: 'email', pid: p.pid, to: jrMask_(email), how: how });
  });
  if (!pending.length) jrLog_({ step: 'email', note: 'no email on file for ' + ppl.length + ' match(es)' });
  if (pending.length) c.put('jr_ec_' + jrHash_(e164), JSON.stringify({ list: pending, tries: 0 }), 900);
}
function jrPrimaryEmail_(pid) {
  var r = jrGet_('/people/v2/people/' + pid + '/emails');
  var list = (r && r.data) || [];
  var em = list.filter(function(e) { return (e.attributes || {}).primary; })[0] || list[0];
  return em ? String((em.attributes || {}).address || '').trim() : '';
}
function jrMask_(e) { var m = String(e || '').split('@'); return m.length === 2 ? m[0].charAt(0) + '•••@' + m[1] : '(none)'; }
// Last 20 sign-in attempts (no codes, masked emails) — read by jr_diag.
function jrLog_(o) {
  try {
    var p = PropertiesService.getScriptProperties(), list = JSON.parse(p.getProperty('JR_SIGNIN_LOG') || '[]');
    o.at = new Date().toISOString(); list.unshift(o); p.setProperty('JR_SIGNIN_LOG', JSON.stringify(list.slice(0, 20)));
  } catch (e) {}
}
/** Run ONCE from the Apps Script editor (Run ▸ authorizeJourneyEmail) and click Allow, so the
 *  web app may send sign-in emails. Sends nothing; just checks the mail permission. */
function authorizeJourneyEmail() { Logger.log('Email permission OK — daily quota left: ' + MailApp.getRemainingDailyQuota()); }
// Pastor-only: run the phone lookup for a person's own numbers and show what sign-in would do.
function jrDiag_(body) {
  if (!spPastorForHash_(body.pw)) return { ok: false, error: 'unauthorized' };
  var pid = String(body.pid || '').replace(/\D/g, ''), out = { ok: true, log: JSON.parse(PropertiesService.getScriptProperties().getProperty('JR_SIGNIN_LOG') || '[]') };
  try { out.mailQuota = MailApp.getRemainingDailyQuota(); out.mailAllowed = true; } catch (e) { out.mailAllowed = false; out.mailError = e.message.split('.')[0]; }
  if (pid) {
    var ph = jrGet_('/people/v2/people/' + pid + '/phone_numbers');
    out.phones = ((ph && ph.data) || []).map(function(n) {
      var raw = (n.attributes || {}).number || '', e = jrE164_(raw), found = e ? jrPeopleByPhone_(e) : [];
      return { stored: '…' + String(raw).replace(/\D/g, '').slice(-4), location: (n.attributes || {}).location, e164ok: !!e,
               lookupFindsThisPerson: found.some(function(f) { return String(f.pid) === pid; }), lookupMatches: found.length };
    });
    out.email = jrMask_(jrPrimaryEmail_(pid));
    var P = jrGet_('/people/v2/people/' + pid); out.status = P && P.data && P.data.attributes && P.data.attributes.status; out.child = P && P.data && P.data.attributes && P.data.attributes.child;
  }
  return out;
}
function jrEsc_(s) { return String(s || '').replace(/[&<>"]/g, function(ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
function jrMagic_(body) {
  var c = CacheService.getScriptCache(), k = 'jr_ml_' + jrHash_(String(body.m || '')), pid = c.get(k);
  if (!pid) return { ok: false, error: 'That sign-in link has expired or was already used — please ask for a new one.' };
  c.remove(k);
  return jrNewSession_(pid, 'email-link');
}

function jrPhoneVerify_(body) {
  var e164 = jrE164_(body.phone), code = String(body.code || '').replace(/\D/g, '');
  if (!e164 || code.length < 4) return { ok: false, error: 'Enter the 6-digit code.' };
  if (!jrSmsOn_()) {                                   // email channel
    var c = CacheService.getScriptCache(), k = 'jr_ec_' + jrHash_(e164), hit = c.get(k);
    if (!hit) return { ok: false, error: 'That code has expired — please ask for a new one.' };
    var st = JSON.parse(hit), h = jrHash_(code + ':' + e164);
    var m = st.list.filter(function(x) { return x.code === h; })[0];
    if (!m) {
      st.tries++;
      if (st.tries >= 5) { c.remove(k); return { ok: false, error: 'Too many tries — please ask for a new code.' }; }
      c.put(k, JSON.stringify(st), 900);
      return { ok: false, error: 'That code didn’t match — check the email and try again.' };
    }
    st.list = st.list.filter(function(x) { return x.code !== h; });
    if (st.list.length) c.put(k, JSON.stringify(st), 900); else c.remove(k);
    return jrNewSession_(m.pid, 'email-code');
  }
  var r = jrTwilio_('/VerificationCheck', { To: e164, Code: code });
  if (!(r.json && r.json.status === 'approved')) return { ok: false, error: 'That code didn’t match — check the text and try again.' };
  var ppl = jrPeopleByPhone_(e164).filter(function(p) { return !p.child; });
  if (!ppl.length) return { ok: false, error: 'We couldn’t find you yet.' };
  if (ppl.length === 1) return jrNewSession_(ppl[0].pid, 'phone');
  // A shared household phone: let them pick who they are (the code proved they hold the phone).
  var ticket = jrRandom_();
  CacheService.getScriptCache().put('jr_pick_' + ticket, JSON.stringify(ppl.map(function(p) { return p.pid; })), 600);
  return { ok: true, pick: ppl.map(function(p) { return { pid: p.pid, name: p.first }; }), ticket: ticket };
}
function jrPick_(body) {
  var hit = CacheService.getScriptCache().get('jr_pick_' + String(body.ticket || ''));
  if (!hit) return { ok: false, error: 'That took a little too long — please start again.' };
  var allowed = JSON.parse(hit);
  if (allowed.indexOf(String(body.pid)) < 0) return { ok: false, error: 'Please pick your name.' };
  CacheService.getScriptCache().remove('jr_pick_' + String(body.ticket || ''));
  return jrNewSession_(String(body.pid), 'phone');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign in with Planning Center (OAuth 2)
// ─────────────────────────────────────────────────────────────────────────────
function jrOauthStart_() {
  if (!jrConfig_().pco) return { ok: false, error: 'Planning Center sign-in isn’t turned on yet.' };
  var state = jrRandom_();
  CacheService.getScriptCache().put('jr_oauth_' + state, '1', 900);
  var url = 'https://api.planningcenteronline.com/oauth/authorize?client_id=' + encodeURIComponent(jrProp_('PCO_OAUTH_CLIENT_ID')) +
    '&redirect_uri=' + encodeURIComponent(JR_.REDIRECT) + '&response_type=code&scope=people&state=' + state;
  return { ok: true, url: url };
}
function jrOauthFinish_(body) {
  var state = String(body.state || ''), code = String(body.code || '');
  var c = CacheService.getScriptCache();
  if (!state || !c.get('jr_oauth_' + state)) return { ok: false, error: 'That sign-in link expired — please try again.' };
  c.remove('jr_oauth_' + state);
  var tr = UrlFetchApp.fetch('https://api.planningcenteronline.com/oauth/token', { method: 'post', muteHttpExceptions: true, payload: {
    grant_type: 'authorization_code', code: code, client_id: jrProp_('PCO_OAUTH_CLIENT_ID'),
    client_secret: jrProp_('PCO_OAUTH_SECRET'), redirect_uri: JR_.REDIRECT } });
  var tok = null; try { tok = JSON.parse(tr.getContentText()); } catch (x) {}
  if (!tok || !tok.access_token) return { ok: false, error: 'Planning Center didn’t finish the sign-in — please try again.' };
  // Their token is used once, to learn who they are, then thrown away.
  var me = UrlFetchApp.fetch('https://api.planningcenteronline.com/people/v2/me', { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tok.access_token } });
  var mj = null; try { mj = JSON.parse(me.getContentText()); } catch (x) {}
  var pid = mj && mj.data && mj.data.id;
  if (!pid) return { ok: false, error: 'We couldn’t find your Living Stones profile.' };
  return jrNewSession_(pid, 'pco');
}

// ─────────────────────────────────────────────────────────────────────────────
// The journey
// ─────────────────────────────────────────────────────────────────────────────
function jrMe_(body) {
  var pid = null, preview = false;
  if (body.preview) {
    if (!spPastorForHash_(body.pw)) return { ok: false, error: 'Preview needs a pastor sign-in.' };
    pid = String(body.preview).replace(/\D/g, ''); preview = true;
  } else {
    pid = jrSessionPid_(String(body.token || ''));
    if (!pid) return { ok: false, signin: true };
  }
  var c = CacheService.getScriptCache(), key = 'jr_me_' + pid;
  if (!body.fresh) { var hit = c.get(key); if (hit) { var o = JSON.parse(hit); o.preview = preview; return o; } }
  var out = jrBuild_(pid);
  try { c.put(key, JSON.stringify(out), JR_.CACHE_MIN * 60); } catch (x) {}
  out.preview = preview;
  return out;
}

function jrBuild_(pid) {
  var tz = Session.getScriptTimeZone(), now = Date.now(), yearAgo = new Date(now - 365 * 864e5).toISOString().substring(0, 10);
  var P = jrGet_('/people/v2/people/' + pid + '?include=field_data,households');
  if (!P || !P.data) { var alt = shGet_('/people/v2/people/' + pid + '?include=field_data,households'); P = alt && alt.json; }
  if (!P || !P.data) { var alt2 = shGet_('/people/v2/people/' + pid); P = alt2 && alt2.json; }
  if (!P || !P.data) return { ok: false, error: 'We couldn’t load your profile.' };   // e.g. a merged/deleted PCO record (404)
  var a = P.data.attributes || {}, fd = {}, hhIds = [];
  (P.included || []).forEach(function(i) {
    if (i.type === 'FieldDatum') fd[String((((i.relationships || {}).field_definition || {}).data || {}).id)] = (i.attributes || {}).value;
    if (i.type === 'Household') hhIds.push(i.id);
  });
  var me = { pid: pid, first: a.nickname || a.given_name || a.first_name || '', last: a.last_name || '', name: a.name || '', avatar: a.avatar || '',
    child: !!a.child, gender: a.gender || '', membership: a.membership || '', since: a.created_at || '' };

  // Household (spouse + kids)
  var spouse = null, kids = [];
  if (hhIds.length) {
    var H = jrGet_('/people/v2/households/' + hhIds[0] + '?include=people');
    ((H && H.included) || []).forEach(function(x) {
      if (x.type !== 'Person' || String(x.id) === String(pid)) return;
      var xa = x.attributes || {};
      if (xa.child) kids.push({ pid: x.id, first: xa.first_name || '', age: jrAge_(xa.birthdate) });
      else if (!spouse) spouse = { pid: x.id, first: xa.first_name || '', membership: xa.membership || '' };
    });
  }

  // Groups (current) with role + joined date
  var groups = [], roles = {};
  var gm = jrGet_('/groups/v2/people/' + pid + '/memberships?per_page=100');
  ((gm && gm.data) || []).forEach(function(m) { roles[(((m.relationships || {}).group || {}).data || {}).id] = m.attributes || {}; });
  var gl = jrGet_('/groups/v2/people/' + pid + '/groups?per_page=100');
  ((gl && gl.data) || []).forEach(function(g) {
    var r = roles[g.id] || {}, gt = ((((g.relationships || {}).group_type || {}).data) || {}).id;
    groups.push({ name: (g.attributes || {}).name || 'Group', leader: String(r.role || '') === 'leader', joined: r.joined_at || '', cg: String(gt) === JR_.CG_TYPE });
  });

  // Serving: teams (from Services position assignments) + schedule (served this year, upcoming)
  var teams = {}, served = 0, upcoming = [], leadsTeam = false;
  var tm = jrGet_('/services/v2/people/' + pid + '/person_team_position_assignments?include=team_position&per_page=100');
  var posName = {}, posTeam = {};
  ((tm && tm.included) || []).forEach(function(i) {
    if (i.type !== 'TeamPosition') return;
    posName[i.id] = (i.attributes || {}).name || '';
    posTeam[i.id] = (((i.relationships || {}).team || {}).data || {}).id;
  });
  ((tm && tm.data) || []).forEach(function(x) {
    var tp = (((x.relationships || {}).team_position || {}).data || {}).id;
    if (/lead|captain|coordinator|director/i.test(posName[tp] || '')) leadsTeam = true;
    teams[posTeam[tp] || tp] = teams[posTeam[tp] || tp] || { position: posName[tp] || '', since: (x.attributes || {}).created_at || '' };
  });
  var sch = jrGet_('/services/v2/people/' + pid + '/schedules?filter=past&per_page=100&order=-sort_date');
  ((sch && sch.data) || []).forEach(function(s) {
    var sa = s.attributes || {};
    if (String(sa.sort_date || '') >= yearAgo && String(sa.status || '') === 'C') served++;
    if (sa.team_name) Object.keys(teams).forEach(function(k) { if (!teams[k].name && teams[k].position && sa.team_position_name === teams[k].position) teams[k].name = sa.team_name; });
  });
  var fut = jrGet_('/services/v2/people/' + pid + '/schedules?filter=future&per_page=10&order=sort_date');
  ((fut && fut.data) || []).forEach(function(s) {
    var sa = s.attributes || {};
    if (String(sa.status || '') === 'D') return;
    upcoming.push({ date: String(sa.sort_date || '').substring(0, 10), what: 'You’re serving: ' + (sa.team_name || 'a team') + (sa.team_position_name ? ' · ' + sa.team_position_name : '') });
    if (sa.team_name) Object.keys(teams).forEach(function(k) { if (!teams[k].name && teams[k].position === sa.team_position_name) teams[k].name = sa.team_name; });
  });
  var teamList = Object.keys(teams).map(function(k) { return { name: jrTeamName_(k) || teams[k].name || teams[k].position || 'A serve team', since: teams[k].since }; })
    .filter(function(t, i, arr) { return arr.findIndex(function(x) { return x.name === t.name; }) === i; });

  // Giving — the PATTERN only (never amounts)
  var gifts = 0, months = {}, last = null, recurring = false;
  var unit = [String(pid)]; try { unit = jgUnit_(pid); } catch (e) {}
  unit.forEach(function(gid) {
    var url = PCO_API + '/giving/v2/people/' + gid + '/donations?per_page=100&where[received_at][gte]=' + yearAgo, guard = 0;
    while (url && guard++ < 10) {
      var r = null; try { r = pcoGet_(url); } catch (e) { break; }
      ((r && r.data) || []).forEach(function(d) { var at = (d.attributes || {}).received_at; if (!at) return; gifts++; months[at.substring(0, 7)] = 1; if (!last || at > last) last = at; });
      url = r && r.links && r.links.next;
    }
    var rd = jrGet_('/giving/v2/people/' + gid + '/recurring_donations?per_page=25');
    ((rd && rd.data) || []).forEach(function(x) { if (/active/i.test(String((x.attributes || {}).status || ''))) recurring = true; });
  });
  var giving = { months: Object.keys(months).length, recurring: recurring, lastDays: last ? Math.floor((now - Date.parse(last)) / 864e5) : null, any: gifts > 0 };

  // Kids check-ins this year
  kids.forEach(function(k) {
    var ci = jrGet_('/check-ins/v2/people/' + k.pid + '/check_ins?order=-created_at&per_page=100'), days = {};
    ((ci && ci.data) || []).forEach(function(x) { var d = String((x.attributes || {}).created_at || '').substring(0, 10); if (d && d >= yearAgo) days[d] = 1; });
    k.checkIns = Object.keys(days).length;
  });

  // Workflows in progress (baptism, new family member, leader pipeline)
  var wfs = {};
  var wc = jrGet_('/people/v2/people/' + pid + '/workflow_cards?per_page=50');
  ((wc && wc.data) || []).forEach(function(cd) {
    var wid = String((((cd.relationships || {}).workflow || {}).data || {}).id || ''), st = String((cd.attributes || {}).stage || '');
    var key = Object.keys(JR_.WF).filter(function(k) { return JR_.WF[k] === wid; })[0];
    if (!key) return;
    if (st === 'completed') wfs[key] = wfs[key] || 'done';
    else if (st !== 'removed') wfs[key] = 'active';
  });
  var baptismPlan = null; try { var pl = bapPlans_()[String(pid)]; if (pl && pl.date) baptismPlan = { date: pl.date, service: pl.service }; } catch (e) {}
  if (!baptismPlan && wfs.ready === 'active') {   // scheduled by hand on the staff Baptisms sheet
    try {
      var bs = getBaptismSchedule_(), mine = baptismNameParts_(me.first + ' ' + me.last), legal = baptismNameParts_((a.first_name || '') + ' ' + me.last);
      (bs && bs.byService || []).forEach(function(g) { g.people.forEach(function(x) {
        var n = baptismNameParts_(x.name);
        if (!baptismPlan && n.last && n.last === mine.last && (n.first === mine.first || n.first === legal.first)) baptismPlan = { date: bs.date, service: g.service };
      }); });
    } catch (e) {}
  }

  // Profile dates + pastor
  var baptized = String(fd[SH_FIELD.baptized] || '').toLowerCase() === 'true' || !!fd[SH_FIELD.baptismDate] || wfs.ready === 'done';
  var elderFull = String(fd[SH_FIELD.assignedElder] || '');
  var pastor = elderFull ? { name: elderFull } : null;

  var member = /^(member|deacon|pastor)$/i.test(String(me.membership).trim());
  var inCG = groups.some(function(g) { return g.cg; }), inGroup = groups.length > 0;
  var leads = groups.some(function(g) { return g.leader; }) || leadsTeam;
  var serving = teamList.length > 0;

  // Season (a place on the path — never a grade)
  var season = 'exploring';
  if (baptized || member) season = 'belonging';
  if ((baptized || member) && (inGroup || serving)) season = 'growing';
  if (leads) season = 'leading';

  // Milestones (only what we actually know)
  var ms = [];
  var add = function(label, d) { if (d) ms.push({ label: label, date: String(d).substring(0, 10) }); };
  add('First connected with Living Stones', fd[SH_FIELD.firstVisit] || me.since);
  add('Said yes to Jesus', fd[SH_FIELD.salvationDate]);
  add('Baptized', fd[SH_FIELD.baptismDate]);
  add('Became a Family Member', fd[SH_FIELD.membershipStart]);
  groups.filter(function(g) { return g.cg; }).forEach(function(g) { add((g.leader ? 'Started leading ' : 'Joined ') + g.name, g.joined); });
  teamList.forEach(function(t) { add('Joined ' + (/team$/i.test(t.name) ? 'the ' + t.name : 'the ' + t.name + ' team'), t.since); });
  ms.sort(function(x, y) { return x.date < y.date ? -1 : 1; });
  if (ms.length > 9) ms = ms.slice(0, 1).concat(ms.slice(-8));

  // Upcoming extras
  if (baptismPlan) upcoming.push({ date: baptismPlan.date, what: 'Your baptism · ' + baptismPlan.service + ' service' });
  var nextBap = null; try { nextBap = bapFirstSundays_(1)[0]; } catch (e) {}
  if (nextBap && baptized) upcoming.push({ date: nextBap, what: 'Baptism Sunday — know someone who’s ready? Invite them' });
  upcoming.sort(function(x, y) { return x.date < y.date ? -1 : 1; });

  var ctx = { me: me, spouse: spouse, kids: kids, groups: groups, inCG: inCG, inGroup: inGroup, teams: teamList, serving: serving,
    served: served, giving: giving, wfs: wfs, baptized: baptized, member: member, leads: leads, pastor: pastor };
  return { ok: true, person: { first: me.first, name: me.name, avatar: me.avatar, since: me.since, membership: me.membership },
    spouse: spouse ? { first: spouse.first } : null, kids: kids.map(function(k) { return { first: k.first, age: k.age, checkIns: k.checkIns || 0 }; }),
    season: season, groups: groups.filter(function(g) { return g.cg; }).map(function(g) { return { name: g.name, leader: g.leader, joined: g.joined }; }),
    otherGroups: groups.filter(function(g) { return !g.cg; }).length,
    serving: { teams: teamList, servedThisYear: served }, giving: giving,
    baptized: baptized, member: member, baptism: { requested: wfs.requested === 'active', ready: wfs.ready === 'active', plan: baptismPlan },
    milestones: ms, upcoming: upcoming.slice(0, 5), pastor: pastor, steps: jrSteps_(ctx), links: JR_.LINKS, asOf: new Date().toISOString() };
}

function jrTeamName_(teamId) {
  if (!teamId) return '';
  var c = CacheService.getScriptCache(), k = 'jr_team_' + teamId, hit = c.get(k);
  if (hit) return hit;
  var t = jrGet_('/services/v2/teams/' + teamId);
  var n = (t && t.data && t.data.attributes && t.data.attributes.name) || '';
  if (n) c.put(k, n, 21600);
  return n;
}
function jrAge_(bd) { if (!bd) return null; var b = new Date(bd + 'T12:00:00'); if (isNaN(b)) return null; return Math.floor((Date.now() - b.getTime()) / (365.25 * 864e5)); }

// Next steps: at most three, most important first, each with a warm "why" and one button.
function jrSteps_(c) {
  var S = [], L = JR_.LINKS, adult = !c.me.child;
  var spouseHere = c.spouse && /^(member|deacon|pastor|attender|regular attender)$/i.test(String(c.spouse.membership || '').trim());
  if (c.wfs.requested === 'active' || c.wfs.ready === 'active') {
    S.push({ id: 'baptism-on-way', kind: 'celebrate', title: 'You’re on the road to baptism',
      why: (c.pastor ? c.pastor.name.split(' ')[0] + ' is walking with you' : 'A pastor is walking with you') + ' — we can’t wait to celebrate with you.', btn: null });
  } else if (!c.baptized && adult) {
    S.push({ id: 'baptism', title: 'Have you thought about being baptized?',
      why: 'Baptism is a joyful public step of following Jesus. Let us know you’re interested and a pastor will reach out to talk it through — no pressure.', btn: 'I’m interested', url: L.baptism });
  }
  if (adult && !c.member && c.wfs.family !== 'active') {
    S.push({ id: 'membership', title: 'Become a Family Member',
      why: 'If Living Stones feels like home, membership is how we say “we’re in this together” — you’ll meet a pastor and hear our story.', btn: 'Learn more', url: L.membership });
  }
  if (adult && !c.inCG) {
    if (spouseHere) S.push({ id: 'group-couples', title: 'Join a group with ' + c.spouse.first,
      why: 'Groups are where friendships at Living Stones really form. A couples or co-ed group lets you both grow alongside other people in your season.', btn: 'See groups', url: L.groups });
    else S.push({ id: 'group', title: 'Find a group',
      why: 'Groups are where friendships at Living Stones really form — a few people who know your name, pray for you, and open the Bible together.', btn: 'See groups', url: L.groups });
  }
  if (adult && !c.serving) {
    if (c.kids.length) S.push({ id: 'serve-kids', title: 'Try serving in Stepping Stones',
      why: 'Your kids are part of Stepping Stones — many parents serve once a month alongside a friend, and it’s a great way to know their world.', btn: 'Try a Sunday', url: L.serve });
    else S.push({ id: 'serve', title: 'Find a place to serve',
      why: 'Serving is one of the best ways to belong — you meet people, use your gifts, and help someone else take their next step.', btn: 'Find a team', url: L.serve });
  }
  if (adult && c.inGroup && c.serving && !c.leads) {
    S.push({ id: 'lead', title: 'Have you thought about leading?',
      why: 'You’re already connected and serving — you might be exactly the person to help others take their next step. Talk it over with your pastor.', btn: 'Tell my pastor', action: 'note:I’d like to talk about leading a group or team.' });
  }
  if (adult && !c.giving.any) {
    S.push({ id: 'give', title: 'Generosity is part of the journey',
      why: 'Giving is an act of worship and trust. Wherever you are, you can start small — and we’re grateful for every step.', btn: 'Give online', url: L.giving });
  } else if (adult && c.giving.any && !c.giving.recurring && c.giving.months < 6) {
    S.push({ id: 'give-recurring', title: 'Make generosity a rhythm',
      why: 'A recurring gift is an easy way to make giving part of your week — you can change or pause it anytime.', btn: 'Set up recurring giving', url: L.giving });
  }
  if (!S.length || (S.length === 1 && S[0].kind === 'celebrate')) {
    S.push({ id: 'invite', title: 'Who could you invite?',
      why: 'You’re connected, serving and giving — thank you. Think of one person who might need a place like Living Stones this season.', btn: 'Share this Sunday', url: 'https://lssouthreno.com/' });
  }
  return S.slice(0, 3);
}

// "Send your pastor a note" / "Share a prayer request" → a PCO note on their profile + an
// email to their pastor. Never allowed in preview.
function jrNote_(body) {
  var pid = jrSessionPid_(String(body.token || ''));
  if (!pid) return { ok: false, signin: true };
  var kind = body.kind === 'prayer' ? 'prayer' : 'note', text = String(body.text || '').trim().substring(0, 3000);
  if (!text) return { ok: false, error: 'Write a few words first.' };
  var P = jrGet_('/people/v2/people/' + pid + '?include=field_data');
  var name = (P && P.data && P.data.attributes && P.data.attributes.name) || 'Someone';
  var elder = '';
  ((P && P.included) || []).forEach(function(i) { if (i.type === 'FieldDatum' && String((((i.relationships || {}).field_definition || {}).data || {}).id) === SH_FIELD.assignedElder) elder = (i.attributes || {}).value || ''; });
  var label = kind === 'prayer' ? 'Prayer request' : 'Note';
  var w = shWrite_('post', '/people/v2/people/' + pid + '/notes', { data: { attributes: { note: label + ' from My Journey:\n\n' + text },
    relationships: { note_category: { data: { type: 'NoteCategory', id: JR_.NOTE_CAT[kind] } } } } });
  var ok = w.code >= 200 && w.code < 300;
  try {
    var to = jrPastorEmail_(elder);
    if (to) MailApp.sendEmail({ to: to, subject: label + ' from ' + name + ' (My Journey)',
      body: name + ' sent this from their My Journey page:\n\n' + text + '\n\nIt’s saved as a note on their Planning Center profile.' });
  } catch (e) {}
  return ok ? { ok: true } : { ok: false, error: 'We couldn’t send that — please try again.' };
}
function jrPastorEmail_(elderFull) {
  var first = String(elderFull || '').split(' ')[0];
  var id = Object.keys(SH_ELDER_BY_PERSON).filter(function(k) { return SH_ELDER_BY_PERSON[k] === first; })[0];
  if (!id) return '';
  var r = jrGet_('/people/v2/people/' + id + '/emails');
  var em = ((r && r.data) || []).filter(function(e) { return (e.attributes || {}).primary; })[0] || ((r && r.data) || [])[0];
  return em ? (em.attributes || {}).address : '';
}
