// CampusVibe login-code mailer (Google Apps Script).
// Paste this into a new project at https://script.google.com while signed in as the CampusVibe Gmail,
// set SECRET below to the same value as EMAIL_WEBHOOK_SECRET on your server, then
// Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
// Free Gmail accounts can send to about 100 recipients a day through Apps Script.

const SECRET = 'PASTE-THE-SAME-SECRET-AS-EMAIL_WEBHOOK_SECRET';

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad json' });
  }

  if (!data || data.secret !== SECRET) return reply({ ok: false, error: 'forbidden' });

  // Only ever send a 6-digit code to an SRM address, so a leaked secret can't be used for spam
  const to = String(data.to || '').trim().toLowerCase();
  const code = String(data.code || '');
  const minutes = Math.min(15, Math.max(1, parseInt(data.minutes, 10) || 15));
  if (!/^[a-z0-9._%+-]+@srmist\.edu\.in$/.test(to) || !/^\d{6}$/.test(code)) {
    return reply({ ok: false, error: 'bad request' });
  }

  MailApp.sendEmail({
    to: to,
    name: 'CampusVibe',
    subject: 'Your CampusVibe login code: ' + code,
    body: 'Your CampusVibe login code is ' + code + '\n\nIt works for the next ' + minutes + ' minutes, and you can use it more than once. If you didn\'t ask for this, you can ignore this email.',
  });
  return reply({ ok: true });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
