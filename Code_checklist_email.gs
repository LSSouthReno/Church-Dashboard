/**
 * Sunday Volunteer Checklist email.
 *
 * Builds the per-volunteer "you're serving this Sunday" email — their roles,
 * their team leader's contact, and the FULL per-team Sunday checklist — and can
 * send a test copy to Pastor Brad.
 *
 * SENDING requires the mail scope (script.send_mail in the manifest). Because the
 * dashboard web app runs as the deploying user, the owner must approve that scope
 * ONCE by running sendTestChecklistEmail() from the Apps Script editor. Do that
 * BEFORE redeploying the live web-app deployment to a version that carries the
 * mail scope, so the live dashboard is never left needing re-authorization.
 *
 * Checklist content currently mirrors TEAM_CHECKLISTS in index.html. When this
 * moves to real per-person sending, source both from one shared place.
 */

var CHECKLIST_FEEDBACK_EMAIL = 'brad@lschurches.com';

// team (lowercased) -> [{ phase, time, text }]
var CE_TEAM_CHECKLISTS = {
  'hospitality team': [
    { phase:'Before Service', time:'15 min before service', text:'Arrive 15 minutes before the start of service' },
    { phase:'As People Arrive', time:'Before service', text:'Spread out across the worship center — welcome people, talk with them, and help them feel at home and cared about' },
    { phase:'As People Arrive', time:'Before service', text:'Especially look for anyone sitting alone, not with or talking to someone else — go make them feel welcomed and included' },
    { phase:'When Worship Starts', time:'Service start', text:'Once worship begins, find a seat and enjoy the service' }
  ],
  'safety team': [
    { phase:'Arrival', time:'15 min before your service', text:'Arrive at least 15 minutes before your assigned service (7:00 AM preferred for pre-service prayer)' },
    { phase:'Arrival', time:'Before service', text:'Wear your purple lanyard name badge; safety shirt is encouraged but not required' },
    { phase:'Arrival', time:'Before service', text:'Pick up your radio from the kitchen cabinet; confirm radio check with team' },
    { phase:'Arrival', time:'Before service', text:'Know your assigned post: (1) Children’s double doors, (2) Roamer/campus, or (3) Front auditorium SW corner' },
    { phase:'Pre-Service', time:'Before service', text:'Locate AED units — adult AED in kitchen; children’s area AED confirmed' },
    { phase:'Children’s Post', time:'During service', text:'Stand in front of the double doors — no one without a background check passes through' },
    { phase:'Children’s Post', time:'During service', text:'Parents must show child’s security tag to pick up — verify all pickups' },
    { phase:'Children’s Post', time:'Bathroom needs', text:'If a child needs the bathroom: radio another team member to sweep the bathroom before child enters; stay outside with door shut; no one else may enter until child leaves' },
    { phase:'Children’s Post', time:'Bathroom needs', text:'NEVER be behind a closed door alone with a child — if child needs help, radio for parent or get another adult' },
    { phase:'Roamer Post', time:'During service', text:'Roam the entire campus continuously — parking lot (at least twice), patio, lobby, hallways' },
    { phase:'Roamer Post', time:'9:30 service', text:'Escort Mustangs class to Yosh’s after worship; notify leaders when worship begins at end of service to return' },
    { phase:'Roamer Post', time:'During service', text:'Ensure patio gate door is closed (not locked) during service' },
    { phase:'During Service', time:'All times', text:'Operate "behind the scenes" — calm, unobtrusive presence; be aware, alert, and ready' },
    { phase:'During Service', time:'Any concern', text:'Report any concerns via radio immediately; get assistance before approaching anyone whose behavior concerns you — ideally bring 1-2 others' },
    { phase:'Emergency', time:'Medical emergency', text:'Call 911 — give name, location, phone number, and describe the situation. Administer CPR/first aid if trained. Clear the area for emergency personnel.' },
    { phase:'Emergency', time:'Fire', text:'Position at all exit doors; keep doors wide open; direct people calmly to parking lot past dumpsters away from building' },
    { phase:'Post-Service', time:'After service', text:'Do a final walkthrough — confirm building is clear and secure' },
    { phase:'Post-Service', time:'After service', text:'Return radio to kitchen cabinet for recharging' }
  ]
};

function ceEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function ceCheckbox_() {
  return '<span style="display:inline-block;width:13px;height:13px;border:2px solid #c19a3e;' +
         'border-radius:3px;vertical-align:-1px;margin-right:10px;"></span>';
}

function ceTeamSection_(team, position, leader) {
  var INK='#2b2b2b', MUTED='#8a8580', LINE='#e7e3dd', GOLD='#c19a3e', PANEL='#faf8f5';
  var items = CE_TEAM_CHECKLISTS[String(team).toLowerCase()] || [];
  var phases = [];
  items.forEach(function(it){
    if (!phases.length || phases[phases.length-1].phase !== it.phase) phases.push({ phase:it.phase, rows:[] });
    phases[phases.length-1].rows.push(it);
  });
  var h = '';
  h += '<tr><td style="padding:26px 28px 0;">';
  h += '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:'+MUTED+';font-weight:700;">Your role</div>';
  h += '<div style="font-size:20px;font-weight:800;color:'+INK+';margin:2px 0;">'+ceEsc_(team)+'</div>';
  h += '<div style="font-size:14px;color:'+MUTED+';">'+ceEsc_(position)+'</div>';
  if (leader && leader.name) {
    var telDigits = String(leader.phone||'').replace(/[^0-9]/g,'');
    h += '<div style="margin:14px 0 4px;padding:12px 14px;background:'+PANEL+';border:1px solid '+LINE+';border-radius:8px;">' +
         '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:'+MUTED+';font-weight:700;margin-bottom:3px;">Your team leader</div>' +
         '<div style="font-size:15px;color:'+INK+';font-weight:700;">'+ceEsc_(leader.name)+'</div>' +
         (leader.phone ? '<div style="font-size:14px;color:'+MUTED+';margin-top:2px;"><a href="tel:'+telDigits+'" style="color:'+GOLD+';text-decoration:none;">'+ceEsc_(leader.phone)+'</a></div>' : '') +
         '<div style="font-size:12.5px;color:'+MUTED+';margin-top:6px;line-height:1.5;">Questions about your role? Reach out to '+ceEsc_(String(leader.name).split(' ')[0])+'.</div>' +
         '</div>';
  }
  h += '</td></tr>';
  h += '<tr><td style="padding:14px 28px 6px;">';
  h += '<div style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:'+GOLD+';font-weight:700;margin-bottom:6px;">Your Sunday checklist</div>';
  phases.forEach(function(p){
    h += '<div style="font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:'+MUTED+';font-weight:700;margin:14px 0 6px;">'+ceEsc_(p.phase)+'</div>';
    p.rows.forEach(function(it){
      var timeHtml = (it.time && it.time !== '-') ? '<span style="display:block;font-size:11px;color:'+GOLD+';margin-top:3px;">'+ceEsc_(it.time)+'</span>' : '';
      h += '<div style="padding:8px 0;border-bottom:1px solid '+LINE+';">' +
           '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
           '<td width="24" valign="top" style="padding-top:2px;">'+ceCheckbox_()+'</td>' +
           '<td valign="top" style="font-size:14px;line-height:1.5;color:'+INK+';">'+ceEsc_(it.text)+timeHtml+'</td>' +
           '</tr></table></div>';
    });
  });
  h += '</td></tr>';
  return h;
}

/**
 * Build the full HTML email.
 * data = { person, dateStr, roles:[{team,position,when}], leaders:{team:{name,phone,email}} }
 */
function shBuildChecklistEmailHtml_(data) {
  var INK='#2b2b2b', MUTED='#8a8580', LINE='#e7e3dd', GOLD='#c19a3e';
  var rolesRows = (data.roles||[]).map(function(r){
    return '<tr>' +
      '<td style="padding:8px 0;font-size:14px;color:'+INK+';font-weight:700;">'+ceEsc_(r.team) +
      '<span style="display:block;font-size:13px;color:'+MUTED+';font-weight:400;">'+ceEsc_(r.position)+'</span></td>' +
      '<td align="right" style="padding:8px 0;font-size:14px;color:'+MUTED+';white-space:nowrap;">'+ceEsc_(r.when)+'</td>' +
      '</tr>';
  }).join('');
  var sections = (data.roles||[]).map(function(r){
    return ceTeamSection_(r.team, r.position, (data.leaders||{})[r.team]);
  }).join('');
  var feedbackUrl = 'mailto:' + CHECKLIST_FEEDBACK_EMAIL + '?subject=' + encodeURIComponent('Sunday Checklist Feedback');
  var declineUrl  = 'https://lssr.churchcenter.com/me';   // Church Center — their schedule, to decline
  var oneSheetUrl = 'https://lssouthreno.com/sunday' + (data.isoDate ? '?date=' + data.isoDate : '');

  var html = ''
  + '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Serving Sunday</title></head>'
  + '<body style="margin:0;padding:0;background:#f0eeea;">'
  + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0eeea;">'
  + '<tr><td align="center" style="padding:24px 12px;">'
  + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
  + '<tr><td align="center" style="padding:28px 28px 0;">'
  + '<div style="font-size:20px;font-weight:800;letter-spacing:.14em;color:'+INK+';">LIVING STONES</div>'
  + '<div style="font-size:11px;letter-spacing:.34em;color:'+GOLD+';font-weight:700;margin-top:2px;">SOUTH RENO</div>'
  + '<div style="height:3px;width:100%;background:'+GOLD+';margin-top:16px;border-radius:2px;"></div>'
  + '</td></tr>'
  + '<tr><td style="padding:24px 28px 0;">'
  + '<div style="font-size:22px;font-weight:800;color:'+INK+';">Hi '+ceEsc_(data.person)+', here are your serving checklists!</div>'
  + '<div style="font-size:14px;color:'+MUTED+';margin-top:4px;">'+ceEsc_(data.dateStr)+'</div>'
  + '</td></tr>'
  + '<tr><td style="padding:18px 28px 0;">'
  + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid '+LINE+';border-bottom:1px solid '+LINE+';">'
  + '<tr><td style="padding:10px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:'+MUTED+';font-weight:700;">Your role(s)</td>'
  + '<td align="right" style="padding:10px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:'+MUTED+';font-weight:700;">When</td></tr>'
  + rolesRows
  + '</table></td></tr>'
  + '<tr><td style="padding:16px 28px 0;">'
  + '<a href="'+oneSheetUrl+'" style="display:inline-block;background:'+GOLD+';color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px;">View the full Sunday one-sheet &rarr;</a>'
  + '</td></tr>'
  + sections
  + '<tr><td style="padding:22px 28px 6px;">'
  + '<div style="font-size:13px;color:'+MUTED+';line-height:1.6;">Each team is a little different — where you go, what you do, and when. Your checklist above is specific to your team. Save this email or pull it up Sunday morning.</div>'
  + '</td></tr>'
  + '<tr><td style="padding:12px 28px 22px;">'
  + '<div style="background:#faf8f5;border:1px solid '+LINE+';border-radius:10px;padding:18px;text-align:center;">'
  + '<div style="font-size:13px;color:'+MUTED+';line-height:1.6;margin-bottom:14px;">This email is a new way we’re trying to help resource our volunteers with everything they need. If you see a glitch or have any feedback — good or bad — please let us know.</div>'
  + '<a href="'+feedbackUrl+'" style="display:inline-block;background:'+GOLD+';color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">Send feedback to Pastor Brad</a>'
  + '</div></td></tr>'
  + '<tr><td style="padding:16px 28px 30px;border-top:1px solid '+LINE+';">'
  + '<div style="font-size:12px;color:'+MUTED+';line-height:1.6;">Can’t make it this Sunday? <a href="'+declineUrl+'" style="color:'+MUTED+';text-decoration:underline;">Decline in Church Center</a>.</div>'
  + '<div style="font-size:12.5px;color:'+MUTED+';line-height:1.6;margin-top:10px;">Thank you for serving &mdash; it makes Sunday possible.</div>'
  + '<div style="font-size:12.5px;color:'+MUTED+';margin-top:2px;">Living Stones South Reno</div>'
  + '</td></tr>'
  + '</table></td></tr></table></body></html>';
  return html;
}

// Sample payload used for the test send (matches the preview Brad reviewed).
function ceTestData_() {
  return {
    person: 'Darren',
    dateStr: 'Sunday, September 13, 2026',
    isoDate: '2026-09-13',
    roles: [
      { team:'Hospitality Team', position:'Host', when:'9:30 AM' },
      { team:'Safety Team', position:'Safety Monitor', when:'11:00 AM' }
    ],
    leaders: {
      'Hospitality Team': { name:'Ray Brown', phone:'(775) 219-4697', email:'raybrowninc@gmail.com' },
      'Safety Team': { name:'Michael Poleselli', phone:'(650) 773-5312', email:'mpoleselli@yahoo.com' }
    }
  };
}

/**
 * Run this ONCE from the Apps Script editor (Run ▸ sendTestChecklistEmail).
 * The first run prompts for the "send email as you" permission — approve it, and
 * a test copy of the Sunday checklist email lands in brad@lschurches.com.
 */
function sendTestChecklistEmail() {
  var html = shBuildChecklistEmailHtml_(ceTestData_());
  MailApp.sendEmail({
    to: 'brad@lschurches.com',
    subject: '[TEST] You’re serving this Sunday — Living Stones South Reno',
    htmlBody: html,
    name: 'Living Stones South Reno'
  });
  Logger.log('Test checklist email sent to brad@lschurches.com');
  return { ok: true, sentTo: 'brad@lschurches.com' };
}
