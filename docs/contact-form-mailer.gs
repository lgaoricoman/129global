/**
 * 129Global — contact form handler (Google Apps Script).
 *
 * Receives contact form submissions from www.129global.com, emails them to
 * lgao@ricoman.com, and appends each one to a Google Sheet as a backup log.
 * Runs on Google's infrastructure, so it needs no server and no MX records.
 *
 * SETUP
 * 1. Create the log Sheet: https://sheets.new  →  name it "129Global — Contact
 *    Form". Copy its ID from the URL (the long string between /d/ and /edit)
 *    and paste it into SHEET_ID below. The header row is created automatically
 *    on the first submission.
 * 2. Go to https://script.google.com  →  New project  →  name it
 *    "129Global contact form".
 * 3. Paste this whole file over the default Code.gs and Save.
 * 4. Deploy  →  New deployment  →  type "Web app".
 *      - Description:      129Global contact form
 *      - Execute as:       Me (lgao@ricoman.com)
 *      - Who has access:   Anyone
 *    Click Deploy, then authorise when prompted (it needs permission to send
 *    mail as you and to write to the Sheet).
 * 5. Copy the Web app URL — it ends in /exec — and use it as the form action.
 * 6. Open that URL in a browser to confirm it returns {"ok":true,...}.
 *
 * IMPORTANT — re-deploying after an edit
 * Editing the code does NOT update the live endpoint. You must go to
 * Deploy → Manage deployments → pencil icon → Version: "New version" → Deploy.
 * The /exec URL stays the same. This trips people up constantly.
 *
 * EXPECTED FIELDS
 *   name     (required)  sender's name
 *   company  (optional)  company name
 *   email    (required)  sender's email — used as the Reply-To
 *   message  (required)  the enquiry itself
 *   website  (honeypot)  MUST be empty; hidden from real users via CSS
 *
 * CALLING IT FROM THE SITE
 * Apps Script cannot answer CORS preflight requests, so the browser must send
 * a "simple" request — that means Content-Type of text/plain or
 * application/x-www-form-urlencoded, NEVER application/json. Sending JSON
 * triggers an OPTIONS preflight that Apps Script answers with a redirect, and
 * the fetch fails before your handler ever runs. This script accepts both
 * form-encoded bodies and JSON-as-text/plain, so either of these works:
 *
 *   // form-encoded
 *   await fetch(ENDPOINT, {
 *     method: 'POST',
 *     body: new URLSearchParams({ name, company, email, message, website }),
 *   });
 *
 *   // or JSON sent as text/plain
 *   await fetch(ENDPOINT, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'text/plain;charset=utf-8' },
 *     body: JSON.stringify({ name, company, email, message, website }),
 *   });
 *
 * Both return JSON: { ok: true } on success, or { ok: false, error: '...' }
 * with a human-readable reason you can show next to the form.
 *
 * The honeypot markup on the page should be genuinely invisible but still
 * submitted — position it off-screen rather than using display:none, and set
 * tabindex="-1" and autocomplete="off" so keyboard and password-manager users
 * never land in it:
 *
 *   <div style="position:absolute;left:-9999px;" aria-hidden="true">
 *     <label>Website<input type="text" name="website" tabindex="-1"
 *            autocomplete="off"></label>
 *   </div>
 *
 * QUOTAS
 * Sending is subject to Gmail limits: ~1,500 recipients/day on Google
 * Workspace, ~100/day on a consumer account. Far beyond normal contact form
 * volume — but note that a spam flood counts against it, which is part of why
 * the honeypot and the length caps below matter.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var NOTIFY_TO = 'lgao@ricoman.com';
var SHEET_ID = '1cafgp_yctqk_9RJrcMQDs9p3urpjVpO5zPWwpHx8rFc';
var SHEET_NAME = 'Submissions';
var SITE_NAME = '129Global';

// Anything longer than these is a bot or a paste accident; reject rather than
// let it into the Sheet or the inbox.
var MAX_LENGTHS = { name: 120, company: 160, email: 254, message: 5000 };

var HEADERS = ['Timestamp', 'Name', 'Company', 'Email', 'Message'];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doPost(e) {
  try {
    var body = parseBody(e);

    // Honeypot. Real users never see this field, so anything in it is a bot.
    // Return ok:true deliberately — telling a bot it was caught just teaches
    // whoever wrote it to leave the field alone next time. The submission is
    // silently discarded: no email, no Sheet row.
    if (String(body.website || '').trim() !== '') {
      return json({ ok: true });
    }

    var name = clean(body.name);
    var company = clean(body.company);
    var email = clean(body.email);
    var message = clean(body.message);

    var problem = validate({ name: name, company: company, email: email, message: message });
    if (problem) {
      return json({ ok: false, error: problem });
    }

    // Log first. If the Sheet write fails we still want the email to go out,
    // but if the email fails we want a record that someone tried to reach us.
    var logged = appendRow(name, company, email, message);

    MailApp.sendEmail({
      to: NOTIFY_TO,
      replyTo: email,
      subject: subjectFor(name, company),
      htmlBody: emailBody(name, company, email, message, logged),
      name: SITE_NAME + ' website',
    });

    return json({ ok: true });
  } catch (err) {
    // Log the real error for debugging (View → Executions in the editor) but
    // return something generic — error strings can leak config details.
    console.error(err);
    return json({ ok: false, error: 'Sorry, something went wrong sending your message. Please email ' + NOTIFY_TO + ' directly.' });
  }
}

// Health check for opening the /exec URL in a browser.
function doGet() {
  return json({ ok: true, service: '129global-contact-form' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Accepts form-encoded bodies (e.parameter) and JSON posted as text/plain.
function parseBody(e) {
  if (e && e.postData && e.postData.contents) {
    var raw = e.postData.contents.trim();
    if (raw.charAt(0) === '{') {
      try {
        return JSON.parse(raw);
      } catch (err) {
        // Fall through to the parsed parameters below.
      }
    }
  }
  return (e && e.parameter) || {};
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function validate(fields) {
  if (!fields.name) return 'Please enter your name.';
  if (!fields.email) return 'Please enter your email address.';
  if (!fields.message) return 'Please enter a message.';

  // Deliberately loose. Strict email regexes reject valid addresses far more
  // often than they catch bad ones; the real test is whether the reply sends.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(fields.email)) {
    return 'That email address does not look right.';
  }

  var names = Object.keys(MAX_LENGTHS);
  for (var i = 0; i < names.length; i++) {
    var key = names[i];
    if (fields[key] && fields[key].length > MAX_LENGTHS[key]) {
      return 'Your ' + key + ' is too long (limit ' + MAX_LENGTHS[key] + ' characters).';
    }
  }
  return null;
}

function subjectFor(name, company) {
  return SITE_NAME + ' enquiry — ' + name + (company ? ' (' + company + ')' : '');
}

// Returns true if the row was written, false if logging failed.
function appendRow(name, company, email, message) {
  try {
    var sheet = getSheet();
    sheet.appendRow([new Date(), name, company, email, message]);
    return true;
  } catch (err) {
    console.error('Sheet append failed: ' + err);
    return false;
  }
}

function getSheet() {
  var book = SpreadsheetApp.openById(SHEET_ID);
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function emailBody(name, company, email, message, logged) {
  var rows = [
    ['Name', escapeHtml(name)],
    ['Company', company ? escapeHtml(company) : '—'],
    ['Email', '<a href="mailto:' + encodeURI(email) + '">' + escapeHtml(email) + '</a>'],
  ];

  var html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#1b2422;">';
  html += '<p style="margin:0 0 16px;">New enquiry from the ' + SITE_NAME + ' website.</p>';
  html += '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px;">';
  for (var i = 0; i < rows.length; i++) {
    html += '<tr>'
      + '<td style="padding:4px 16px 4px 0;color:#6b7671;vertical-align:top;">' + rows[i][0] + '</td>'
      + '<td style="padding:4px 0;">' + rows[i][1] + '</td>'
      + '</tr>';
  }
  html += '</table>';
  html += '<div style="padding:16px;background:#f4f6f5;border-radius:6px;white-space:pre-wrap;">'
    + escapeHtml(message) + '</div>';
  html += '<p style="margin:20px 0 0;color:#6b7671;font-size:13px;">'
    + 'Reply directly to this email to respond to the sender.';
  if (!logged) {
    html += '<br><strong style="color:#a1461f;">Note: this submission could not be written to the '
      + 'log Sheet — check SHEET_ID and the script\'s permissions.</strong>';
  }
  html += '</p></div>';

  return html;
}

// The message is attacker-controlled and lands in an HTML email; escape it.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
