const express    = require('express');
const { Pool }   = require('pg');
const path       = require('path');
const fs         = require('fs');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const passport   = require('passport');
const { Strategy: LocalStrategy }    = require('passport-local');
const { Strategy: GoogleStrategy }   = require('passport-google-oauth20');
const { Strategy: FacebookStrategy } = require('passport-facebook');
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const { Resend } = require('resend');
const crypto     = require('crypto');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const escapeHtml = require('escape-html');

// --- Environment gate ---
// Every secret/config the app depends on MUST come from the environment.
// Fail fast at startup if anything required is missing — the alternative
// (silent fallback to a dev default) is how production sites leak.
const IS_PROD = process.env.NODE_ENV === 'production';
const REQUIRED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'CRON_SECRET', 'APP_URL'];
const envMissing = REQUIRED_ENV.filter(n => !process.env[n] || String(process.env[n]).length < 8);
if (envMissing.length) {
  console.error('[startup] Missing/too-short required env vars: ' + envMissing.join(', '));
  console.error('[startup] Generate strong secrets via:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (process.env.SESSION_SECRET.length < 32) {
  console.error('[startup] SESSION_SECRET must be at least 32 chars long.');
  process.exit(1);
}
// Reject any of the former hardcoded dev defaults if someone pasted them as real secrets.
const BANNED_SECRETS = new Set(['dev-secret', 'redmaple-dev-secret-change-in-production', 'pilates2024']);
if (BANNED_SECRETS.has(process.env.SESSION_SECRET) || BANNED_SECRETS.has(process.env.CRON_SECRET)) {
  console.error('[startup] A placeholder value is being used for SESSION_SECRET or CRON_SECRET — rotate it.');
  process.exit(1);
}

// Multer: parse multipart/form-data for Page Editor image uploads.
// Keep files in memory (small studio, few images) so we can stream them
// straight into a Postgres bytea column without touching disk — important
// because Vercel's serverless filesystem is ephemeral.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max per image
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|svg\+xml)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, WebP, GIF, or SVG images allowed'), ok);
  }
});

const PORT = process.env.PORT || 3000;
// APP_URL is required above; no localhost fallback — the full URL is used to
// build cancel/reset/waiver links and those must not point at localhost in prod.
const APP_URL = process.env.APP_URL;

// --- Email ---
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Short non-reversible tag for logs. Lets us correlate events for the same
// user across log lines without spilling raw email addresses into Vercel's
// log storage (which retains them indefinitely and shows up in support
// screenshots etc.). 8 hex chars = 32 bits — plenty for correlation, not
// enough to meaningfully brute-force back to the email.
function hashForLog(value) {
  if (!value) return 'none';
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function cancelToken(registrationId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(String(registrationId)).digest('hex');
}

function paymentActionToken(registrationId, action) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(`payment-${action}-${registrationId}`).digest('hex');
}

function formatClassTime(time) {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function formatClassDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

const FROM_ADDRESS = 'Red Maple Movement <bookings@redmaplemovement.ca>';

// Shared email layout matching the branded card design
function emailWrap({ heading, subtitle, detailRows, body, buttonLabel, buttonUrl }) {
  const rowsHtml = detailRows ? detailRows.map(([label, value]) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #e8e3dd;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#820000;width:120px;vertical-align:top">${label}</td><td style="padding:10px 0 10px 16px;border-bottom:1px solid #e8e3dd;font-size:15px;color:#3a3a3a">${value}</td></tr>`
  ).join('') : '';

  return `
    <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#FAF7F2;padding:40px 20px">
      <div style="background:#fff;border:1px solid #e8e3dd;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
        <div style="padding:40px 36px;text-align:center">
          <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#820000;margin:0 0 12px;font-weight:600">MOVE. BREATHE. TRANSFORM.</p>
          <h1 style="font-family:Georgia,serif;font-size:28px;color:#3a3a3a;margin:0 0 8px;font-weight:700;line-height:1.2">${heading}</h1>
          ${subtitle ? `<p style="font-size:15px;color:#6b6b6b;margin:0">${subtitle}</p>` : ''}
        </div>
        ${detailRows ? `
        <div style="padding:0 36px">
          <div style="border-top:1px solid #e8e3dd;margin-bottom:8px"></div>
          <table style="width:100%;border-collapse:collapse">${rowsHtml}</table>
        </div>` : ''}
        ${body ? `<div style="padding:24px 36px 0;text-align:center">${body}</div>` : ''}
        ${buttonLabel ? `
        <div style="padding:28px 36px 36px;text-align:center">
          <a href="${buttonUrl}" style="display:inline-block;background:#820000;color:#fff;padding:14px 40px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.03em">${buttonLabel}</a>
        </div>` : '<div style="padding:0 0 36px"></div>'}
      </div>
      <div style="padding:0 0 12px"></div>
    </div>`;
}

async function sendConfirmationEmail({ to, firstName, lastName, cls, registrationId, packageType }) {
  if (!process.env.RESEND_API_KEY) return;
  const cancelUrl = `${APP_URL}/api/registrations/${registrationId}/cancel?token=${cancelToken(registrationId)}`;

  // Tailor the payment block to the package chosen at booking time
  const isPack  = packageType === '4pack';
  const price   = isPack ? '$85 CAD' : '$25 CAD';
  const priceHeader = isPack ? 'SECURE YOUR 4-CLASS PACKAGE' : 'SECURE YOUR SPOT';
  const priceSub    = isPack
    ? 'For your 4-class bundle — 1 class used for this booking, 3 credits will be added to your account once payment is received.'
    : 'Send via Interac e-Transfer to';
  const priceBodyExtra = isPack
    ? `<p style="font-size:12px;color:#6b6b6b;margin:8px 0 0">After payment confirmation, use your remaining credits when booking future classes (no payment needed until your balance runs out).</p>`
    : '';
  const subjectPrefix = isPack ? 'Booking Confirmed (4-Pack)' : 'Booking Confirmed';

  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `${subjectPrefix}: ${cls.title} on ${formatClassDate(cls.date)}`,
    html: emailWrap({
      heading: isPack ? 'Booking Confirmed — 4-Class Package' : 'Booking Confirmed',
      subtitle: isPack
        ? `Your spot is reserved. Please complete payment to confirm your booking and unlock your 4-class bundle.`
        : `Your spot is reserved for the next hour. Please complete payment to confirm your spot in class.`,
      detailRows: [
        ['Name', `${firstName} ${lastName}`],
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
        ['Instructor', cls.instructor],
        ...(isPack ? [['Package', '4-Class Bundle — $85 (save $15 vs. drop-in)']] : [])
      ],
      body: `
        <div style="background:#FAF7F2;border:1px solid #e8e3dd;border-radius:8px;padding:16px;margin-bottom:8px">
          <p style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#6b6b6b;margin:0 0 4px;font-weight:700">${priceHeader}</p>
          <p style="font-family:Georgia,serif;font-size:22px;color:#820000;font-weight:700;margin:0 0 6px">${price}</p>
          <p style="font-size:13px;color:#6b6b6b;margin:0 0 2px">${priceSub}</p>
          <p style="font-size:15px;font-weight:700;color:#3a3a3a;margin:${isPack ? '6px' : '0'} 0 0">amanda@redmaplemovement.ca</p>
          ${priceBodyExtra}
        </div>
        <p style="font-size:12px;color:#b0b0b0;margin:8px 0 0">Your spot is held for 1 hour pending payment. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>
        <p style="font-size:13px;color:#6b6b6b;margin:12px 0 0">Need to cancel? <a href="${cancelUrl}" style="color:#820000">Cancel your booking</a></p>`,
      buttonLabel: 'Manage My Booking',
      buttonUrl: `${APP_URL}/my-schedule.html`
    })
  });
}

function waiverViewToken(waiverId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(`waiver-${waiverId}`).digest('hex');
}

// --- Signature data-URL sanitiser ---
// Signatures arrive as base64 data URLs from an HTML5 canvas. Before we render
// them back into an <img src=...>, confirm they match the canvas-export format
// so an attacker can't store `javascript:...` or an inline SVG with a <script>.
const SAFE_SIGNATURE_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/;
function safeSignatureSrc(v) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  return SAFE_SIGNATURE_RE.test(trimmed) && trimmed.length < 2_000_000 ? trimmed : '';
}

// Combined confirmation email for a multi-class drop-in batch. Sent once per
// batch (instead of N per-class emails) so the user gets a single $25 × N
// total ask with all classes listed, plus individual cancel links per class.
async function sendBatchDropInConfirmation({ to, firstName, lastName, classes }) {
  if (!process.env.RESEND_API_KEY) return;
  const n       = classes.length;
  const total   = n * 25;
  const classesList = classes.map(c => {
    const cancelUrl = `${APP_URL}/api/registrations/${c.registrationId}/cancel?token=${cancelToken(c.registrationId)}`;
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top">
          <p style="margin:0 0 2px;font-weight:700;color:#3a3a3a;font-size:14px">${c.title}</p>
          <p style="margin:0;font-size:12px;color:#6b6b6b">${formatClassDate(c.date)} · ${formatClassTime(c.time)} · ${c.instructor || 'Amanda'}</p>
        </td>
        <td style="padding:10px 0 10px 12px;border-bottom:1px solid #eee;text-align:right;vertical-align:top;white-space:nowrap">
          <p style="margin:0;font-weight:700;color:#3a3a3a;font-size:14px">$25 CAD</p>
          <a href="${cancelUrl}" style="font-size:11px;color:#820000">Cancel this</a>
        </td>
      </tr>`;
  }).join('');

  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Booking Confirmed (${n} classes): ${formatClassDate(classes[0].date)}${n > 1 ? ` and ${n - 1} more` : ''}`,
    html: emailWrap({
      heading: `Booking Confirmed — ${n} classes`,
      subtitle: `Your ${n} spots are reserved. Please complete payment to confirm them.`,
      detailRows: [
        ['Name',  `${firstName} ${lastName}`],
        ['Classes booked', `${n} class${n === 1 ? '' : 'es'}`]
      ],
      body: `
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px">${classesList}</table>
        <div style="background:#FAF7F2;border:1px solid #e8e3dd;border-radius:8px;padding:16px;margin-bottom:8px">
          <p style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#6b6b6b;margin:0 0 4px;font-weight:700">SECURE YOUR ${n} SPOTS</p>
          <p style="font-family:Georgia,serif;font-size:22px;color:#820000;font-weight:700;margin:0 0 6px">$${total} CAD</p>
          <p style="font-size:13px;color:#6b6b6b;margin:0 0 2px">${n} × $25 drop-in · Send via Interac e-Transfer to</p>
          <p style="font-size:15px;font-weight:700;color:#3a3a3a;margin:0">amanda@redmaplemovement.ca</p>
          <p style="font-size:12px;color:#6b6b6b;margin:8px 0 0">Include your name in the e-Transfer message.</p>
        </div>
        <p style="font-size:12px;color:#b0b0b0;margin:8px 0 0">Your spots are held for 1 hour pending payment. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>`,
      buttonLabel: 'Manage My Schedule',
      buttonUrl: `${APP_URL}/my-schedule.html`
    })
  });
}

async function sendWaiverConfirmationEmail({ to, firstName, waiverId, signedAt }) {
  if (!process.env.RESEND_API_KEY) return;
  const viewUrl = `${APP_URL}/api/waiver/view/${waiverId}?token=${waiverViewToken(waiverId)}`;
  const signedDate = new Date(signedAt).toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Waiver Signed: ${signedDate}`,
    html: emailWrap({
      heading: 'Waiver Received',
      subtitle: `Thank you, ${firstName} — your liability waiver has been successfully signed and is on file.`,
      detailRows: [
        ['Signed By', firstName],
        ['Date', signedDate],
      ],
      body: `<p style="font-size:13px;color:#6b6b6b;margin:0">You can view and download a copy of your signed waiver at any time using the button below.</p>
             <p style="font-size:12px;color:#b0b0b0;margin:8px 0 0">Keep this email — the link provides permanent access to your waiver copy.</p>`,
      buttonLabel: 'View My Waiver',
      buttonUrl: viewUrl
    })
  });
}

async function sendRemovalEmail({ to, firstName, cls }) {
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Your booking for ${cls.title} has been cancelled`,
    html: emailWrap({
      heading: 'Booking Cancelled',
      subtitle: `Your spot in ${cls.title} has been cancelled by the studio.`,
      detailRows: [
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
        ['Instructor', cls.instructor],
      ],
      body: `<p style="font-size:14px;color:#6b6b6b">If you have any questions, please contact us at <a href="mailto:amanda@redmaplemovement.ca" style="color:#820000">amanda@redmaplemovement.ca</a>.</p>`,
      buttonLabel: 'Visit Red Maple Movement',
      buttonUrl: APP_URL
    })
  });
}

// Sent when a user cancels their own booking (via My Schedule portal or
// via the email cancellation link). Wording adapts to the refund outcome.
async function sendSelfCancellationEmail({ to, firstName, cls, refundType }) {
  if (!process.env.RESEND_API_KEY) return;
  const policyLink = `<a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a>`;
  const refundBlock =
    refundType === 'cash'
      ? `<div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;padding:14px 16px;margin:8px 0">
           <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#2e7d32;letter-spacing:0.05em;text-transform:uppercase">Refund on the way</p>
           <p style="margin:0;font-size:14px;color:#3a3a3a">You cancelled more than 24 hours before class, so your <strong>$25 payment will be refunded via e-Transfer within 2–3 business days</strong>.</p>
         </div>`
      : refundType === 'credit'
      ? `<div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;padding:14px 16px;margin:8px 0">
           <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#2e7d32;letter-spacing:0.05em;text-transform:uppercase">Credit returned</p>
           <p style="margin:0;font-size:14px;color:#3a3a3a">You cancelled more than 24 hours before class, so <strong>1 class credit has been returned to your account</strong> and is ready to use on any future class.</p>
         </div>`
      : `<div style="background:#fff3e0;border:1px solid #ffe0b2;border-radius:8px;padding:14px 16px;margin:8px 0">
           <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#e65100;letter-spacing:0.05em;text-transform:uppercase">No refund or credit</p>
           <p style="margin:0;font-size:14px;color:#3a3a3a">This cancellation is within 24 hours of class start, so per our ${policyLink} no refund or credit return applies.</p>
         </div>`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Cancellation Confirmed: ${cls.title} on ${formatClassDate(cls.date)}`,
    html: emailWrap({
      heading: 'Cancellation Confirmed',
      subtitle: `Hi ${firstName || 'there'} — we've cancelled your booking as requested.`,
      detailRows: [
        ['Class',      cls.title],
        ['Date',       formatClassDate(cls.date)],
        ['Time',       formatClassTime(cls.time)],
        ['Instructor', cls.instructor || 'Amanda']
      ],
      body: refundBlock +
        `<p style="font-size:13px;color:#6b6b6b;margin:12px 0 0">Questions? Reply to this email or reach out at <a href="mailto:amanda@redmaplemovement.ca" style="color:#820000">amanda@redmaplemovement.ca</a>. See our ${policyLink} for details.</p>`,
      buttonLabel: 'Back to Red Maple Movement',
      buttonUrl: APP_URL
    })
  });
}

async function sendReminderEmail({ to, firstName, cls, registrationId }) {
  if (!process.env.RESEND_API_KEY) return;
  const cancelUrl = `${APP_URL}/api/registrations/${registrationId}/cancel?token=${cancelToken(registrationId)}`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `See you tomorrow — ${cls.title} at ${formatClassTime(cls.time)}`,
    html: emailWrap({
      heading: `We look forward to seeing you tomorrow, ${firstName}!`,
      subtitle: `Just a quick reminder about your ${cls.title} class. Can't wait to move with you.`,
      detailRows: [
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
        ['Instructor', cls.instructor],
        ['Duration', `${cls.duration} minutes`],
      ],
      body:
        `<p style="font-size:14px;color:#3a3a3a;margin:0 0 10px">
           <strong>A few things to bring:</strong> comfortable clothing you can move in, a water bottle,
           and an open mindset. Don't forget to bring your pilates mat!
         </p>
         <p style="font-size:13px;color:#6b6b6b;margin:0 0 8px">Running late or can't make it? <a href="${cancelUrl}" style="color:#820000">Cancel your booking</a> so the spot can go to someone else (cancellations more than 24 hours ahead are fully refundable — see our <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a>).</p>
         <p style="font-size:13px;color:#3a3a3a;margin:0">See you on the mat! 🤍</p>`,
      buttonLabel: 'View My Schedule',
      buttonUrl: `${APP_URL}/my-schedule.html`
    })
  });
}

async function getSetting(key) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  } catch { return null; }
}

// ===== Microsoft Clarity Data Export API =====
// Docs: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api
// Hard limit: 10 API calls per project per day. We use 3 buckets and refresh
// each every 8 hours → 9 calls/day worst case, safely under the cap.
const CLARITY_API_URL  = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const CLARITY_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Bucket definitions: which dimensions to request in each Clarity API call
const CLARITY_BUCKETS = {
  overview:    { dims: [] },                           // totals only
  geoDevice:   { dims: ['Country', 'Device'] },        // country + device breakdown
  pagesRefs:   { dims: ['URL', 'Referrer'] }           // top pages + referrers
};

async function fetchClarityBucket(bucketKey, token, { force = false } = {}) {
  if (!CLARITY_BUCKETS[bucketKey]) throw new Error(`Unknown bucket: ${bucketKey}`);
  // Check cache first
  const { rows: cached } = await pool.query(
    'SELECT response, fetched_at, error FROM clarity_api_cache WHERE bucket_key = $1',
    [bucketKey]
  );
  if (!force && cached.length) {
    const age = Date.now() - new Date(cached[0].fetched_at).getTime();
    if (age < CLARITY_CACHE_TTL_MS && !cached[0].error) {
      return { data: cached[0].response, cached: true, fetchedAt: cached[0].fetched_at };
    }
  }

  // Build query string: numOfDays=3 is max, gives widest window
  const params = new URLSearchParams({ numOfDays: '3' });
  CLARITY_BUCKETS[bucketKey].dims.forEach((d, i) => params.set(`dimension${i + 1}`, d));

  try {
    const r = await fetch(`${CLARITY_API_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const text = await r.text();
    if (!r.ok) {
      const errMsg = `Clarity API ${r.status}: ${text.slice(0, 200)}`;
      // Upsert an error record so we don't hammer the rate limit on repeated 4xx
      await pool.query(`
        INSERT INTO clarity_api_cache (bucket_key, response, fetched_at, error)
        VALUES ($1, '[]'::jsonb, NOW(), $2)
        ON CONFLICT (bucket_key) DO UPDATE SET fetched_at = NOW(), error = $2
      `, [bucketKey, errMsg]);
      throw new Error(errMsg);
    }
    const data = JSON.parse(text);
    await pool.query(`
      INSERT INTO clarity_api_cache (bucket_key, response, fetched_at, error)
      VALUES ($1, $2::jsonb, NOW(), NULL)
      ON CONFLICT (bucket_key) DO UPDATE SET response = $2::jsonb, fetched_at = NOW(), error = NULL
    `, [bucketKey, JSON.stringify(data)]);
    return { data, cached: false, fetchedAt: new Date().toISOString() };
  } catch (e) {
    // If we have stale cache data, return that rather than failing completely
    if (cached.length) {
      return { data: cached[0].response, cached: true, fetchedAt: cached[0].fetched_at, staleError: e.message };
    }
    throw e;
  }
}

// Normalize Clarity's verbose response shape into flat KPIs + rollups the UI
// can render directly. Clarity returns [{ metricName, information: [...] }] —
// the shape of `information` depends on which dimensions were requested.
function normalizeClarityData({ overview, geoDevice, pagesRefs }) {
  const out = {
    totalSessions: 0,
    totalPageViews: 0,
    uniqueUsers: 0,
    botSessions: 0,
    avgEngagementSeconds: 0,
    avgScrollDepth: null,
    countries: [],   // [{ label, sessions }]
    devices: [],     // [{ label, sessions }]
    pages: [],       // [{ label, sessions }]
    referrers: []    // [{ label, sessions }]
  };

  const findMetric = (resp, name) => Array.isArray(resp) ? resp.find(m => m.metricName === name) : null;

  // Overview bucket — totals
  if (Array.isArray(overview)) {
    const traffic = findMetric(overview, 'Traffic');
    const info = traffic && traffic.information && traffic.information[0];
    if (info) {
      out.totalSessions  = parseInt(info.totalSessionCount || 0, 10);
      out.totalPageViews = parseInt(info.totalPageViews || info.pageViews || 0, 10);
      out.uniqueUsers    = parseInt(info.distinctUserCount || info.totalUsers || 0, 10);
      out.botSessions    = parseInt(info.totalBotSessionCount || 0, 10);
    }
    const engagement = findMetric(overview, 'EngagementTime');
    const e = engagement && engagement.information && engagement.information[0];
    if (e && e.activeTime != null) out.avgEngagementSeconds = Math.round(parseFloat(e.activeTime));

    const scroll = findMetric(overview, 'ScrollDepth');
    const s = scroll && scroll.information && scroll.information[0];
    if (s && s.averageScrollDepth != null) out.avgScrollDepth = Math.round(parseFloat(s.averageScrollDepth));
  }

  // Geo + Device bucket
  if (Array.isArray(geoDevice)) {
    const traffic = findMetric(geoDevice, 'Traffic');
    if (traffic && Array.isArray(traffic.information)) {
      const byCountry = new Map();
      const byDevice  = new Map();
      traffic.information.forEach(row => {
        const sessions = parseInt(row.totalSessionCount || row.sessions || 0, 10);
        if (row.Country) byCountry.set(row.Country, (byCountry.get(row.Country) || 0) + sessions);
        if (row.Device)  byDevice.set(row.Device,   (byDevice.get(row.Device)   || 0) + sessions);
      });
      out.countries = [...byCountry.entries()].map(([label, sessions]) => ({ label, sessions }))
        .sort((a, b) => b.sessions - a.sessions).slice(0, 10);
      out.devices = [...byDevice.entries()].map(([label, sessions]) => ({ label, sessions }))
        .sort((a, b) => b.sessions - a.sessions);
    }
  }

  // Pages + Referrers bucket
  if (Array.isArray(pagesRefs)) {
    const traffic = findMetric(pagesRefs, 'Traffic');
    if (traffic && Array.isArray(traffic.information)) {
      const byUrl = new Map();
      const byRef = new Map();
      traffic.information.forEach(row => {
        const sessions = parseInt(row.totalSessionCount || row.sessions || 0, 10);
        const url = row.URL || row.Page;
        const ref = row.Referrer;
        if (url) byUrl.set(url, (byUrl.get(url) || 0) + sessions);
        if (ref) byRef.set(ref, (byRef.get(ref) || 0) + sessions);
      });
      out.pages = [...byUrl.entries()].map(([label, sessions]) => ({ label, sessions }))
        .sort((a, b) => b.sessions - a.sessions).slice(0, 10);
      out.referrers = [...byRef.entries()].map(([label, sessions]) => ({ label, sessions }))
        .sort((a, b) => b.sessions - a.sessions).slice(0, 10);
    }
  }

  return out;
}

// Clean up orphaned artifacts left behind by past deletes that didn't fully
// purge. Any row in the legacy tables whose email matches but whose user_id
// is NULL is treated as a remnant of a previously-deleted account. Called
// immediately before a new user is created so the fresh account starts on a
// truly clean slate — important because email-linked lookups (my-schedule
// bookings, waiver pre-fill, phone auto-populate, etc.) would otherwise
// silently re-attach those orphaned rows to the new account.
async function purgeOrphansByEmail(email) {
  if (!email) return { registrations: 0, cancelled_registrations: 0, waivers: 0 };
  const lower = email.toLowerCase();
  const results = {};
  const tables = [
    ['registrations',           'LOWER(email) = $1 AND user_id IS NULL'],
    ['cancelled_registrations', 'LOWER(email) = $1 AND user_id IS NULL'],
    ['waivers',                 'LOWER(email) = $1 AND user_id IS NULL']
  ];
  for (const [table, where] of tables) {
    try {
      const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE ${where}`, [lower]);
      results[table] = rowCount;
    } catch (e) {
      console.error(`purgeOrphansByEmail(${table}):`, e.message);
      results[table] = -1;
    }
  }
  const any = Object.values(results).some(n => n > 0);
  if (any) console.log(`[purgeOrphansByEmail] cleaned remnants for ${lower}:`, results);
  return results;
}

// Copy a registration into the cancelled_registrations archive.
// Call BEFORE deleting the registration row so class details are still joinable.
// `cancelledBy` is a free-form label: 'user', 'admin', 'email-link', 'unpaid-release', 'user-deleted'.
async function archiveRegistration(registrationId, cancelledBy = 'user') {
  try {
    await pool.query(`
      INSERT INTO cancelled_registrations (
        id, "classId", "firstName", "lastName", email, phone,
        "registeredAt", user_id, package_type, payment_status,
        class_title, class_date, class_time, class_instructor,
        cancelled_at, cancelled_by
      )
      SELECT r.id, r."classId", r."firstName", r."lastName", r.email, r.phone,
             r."registeredAt", r.user_id, r.package_type, r.payment_status,
             c.title, c.date, c.time, c.instructor,
             NOW(), $2
      FROM registrations r
      LEFT JOIN classes c ON c.id = r."classId"
      WHERE r.id = $1
      ON CONFLICT (id) DO NOTHING
    `, [registrationId, cancelledBy]);
  } catch (e) {
    console.error('archiveRegistration failed for', registrationId, e.message);
    // Swallow — we don't want archiving failures to block the actual cancellation
  }
}

async function sendAdminPaymentAlertEmail({ notifyEmail, unpaidList }) {
  if (!notifyEmail || !process.env.RESEND_API_KEY) return;
  const rows = unpaidList.map(({ reg, cls }) => {
    const confirmUrl = `${APP_URL}/api/admin/payment-action/${reg.id}/confirm?token=${paymentActionToken(reg.id, 'confirm')}`;
    const releaseUrl = `${APP_URL}/api/admin/payment-action/${reg.id}/release?token=${paymentActionToken(reg.id, 'release')}`;
    return `
      <div style="background:#FAF7F2;border:1px solid #e8e3dd;border-radius:8px;padding:16px;margin:0 0 12px">
        <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#3a3a3a">${reg.firstName} ${reg.lastName}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b6b6b">${reg.email}${reg.phone ? ' · ' + reg.phone : ''}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#3a3a3a">
          <strong>${cls ? cls.title : 'Unknown class'}</strong>${cls ? ` — ${formatClassDate(cls.date)} at ${formatClassTime(cls.time)}` : ''}
        </p>
        <p style="margin:0 0 12px;font-size:11px;color:#b0b0b0">Booked ${new Date(reg.registeredAt).toLocaleString('en-CA')}</p>
        <div>
          <a href="${confirmUrl}" style="display:inline-block;background:#2d6a2d;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-weight:700;font-size:13px;margin-right:8px">✅ Payment Received</a>
          <a href="${releaseUrl}" style="display:inline-block;background:#820000;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-weight:700;font-size:13px">❌ No Payment — Remove</a>
        </div>
      </div>`;
  }).join('');

  await getResend().emails.send({
    from: FROM_ADDRESS,
    to: notifyEmail,
    subject: `Payment Alert: ${unpaidList.length} unpaid booking${unpaidList.length > 1 ? 's' : ''} require your attention`,
    html: emailWrap({
      heading: 'Payment Required — Action Needed',
      subtitle: unpaidList.length > 1
        ? `${unpaidList.length} bookings have been pending for over 1 hour without payment. Please confirm or remove each below.`
        : `This booking has been pending for over 1 hour without payment. Please confirm or remove it below.`,
      detailRows: [],
      body:
        rows +
        `<p style="font-size:12px;color:#b0b0b0;margin:12px 0 0">One-click actions — no login required. Payment Received marks as paid + emails the guest. Remove cancels + notifies the guest.</p>`,
      buttonLabel: 'Open Admin Dashboard',
      buttonUrl: `${APP_URL}/admin.html`
    })
  });
}

async function sendPaymentConfirmedEmail({ to, firstName, cls, classes }) {
  if (!process.env.RESEND_API_KEY) return;
  // If `classes` is passed in (batch-paid drop-in), the email lists all of
  // them. Otherwise falls back to the single-class layout.
  const multi = Array.isArray(classes) && classes.length > 1;
  const classListHtml = multi
    ? `<table style="width:100%;border-collapse:collapse;margin:0 0 16px">${classes.map(c => `
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top">
          <p style="margin:0 0 2px;font-weight:700;color:#3a3a3a;font-size:14px">${c.title}</p>
          <p style="margin:0;font-size:12px;color:#6b6b6b">${formatClassDate(c.date)} · ${formatClassTime(c.time)} · ${c.instructor || 'Amanda'}</p>
        </td></tr>`).join('')}</table>`
    : '';
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: multi
      ? `Payment Confirmed — ${classes.length} classes booked`
      : `Payment Confirmed — See you in ${cls.title}!`,
    html: emailWrap({
      heading: `Payment Confirmed`,
      subtitle: multi
        ? `You're all set, ${firstName}! Payment received for all ${classes.length} classes.`
        : `You're all set, ${firstName}! We can't wait to see you on the mat.`,
      detailRows: multi
        ? [['Classes paid', `${classes.length} × $25 = $${classes.length * 25} CAD`]]
        : [
            ['Class', cls.title],
            ['Date', formatClassDate(cls.date)],
            ['Time', formatClassTime(cls.time)],
            ['Instructor', cls.instructor],
            ['Duration', `${cls.duration} minutes`],
          ],
      body: classListHtml +
        `<p style="font-size:13px;color:#b0b0b0">Cancellations more than 24 hours before class are fully refundable. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>`,
      buttonLabel: 'View My Schedule',
      buttonUrl: `${APP_URL}/my-schedule.html`
    })
  });
}

async function sendPaymentReleasedEmail({ to, firstName, cls }) {
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Your spot in ${cls.title} — Payment not received`,
    html: emailWrap({
      heading: 'Spot Released',
      subtitle: `We weren't able to confirm payment for ${cls.title}.`,
      detailRows: [
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
      ],
      body: `
        <p style="font-size:14px;color:#6b6b6b;margin:0 0 8px">Your spot has been released. If you'd still like to join us, simply book again and complete payment right away.</p>
        <p style="font-size:13px;color:#b0b0b0;margin:0">Think this is a mistake? Contact <a href="mailto:amanda@redmaplemovement.ca" style="color:#820000">amanda@redmaplemovement.ca</a></p>`,
      buttonLabel: 'Book Again',
      buttonUrl: `${APP_URL}/register.html`
    })
  });
}

async function sendNewBookingNotification({ notifyEmail, registrant, cls }) {
  if (!notifyEmail || !process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to: notifyEmail,
    subject: `New Booking: ${registrant.firstName} ${registrant.lastName} — ${cls.title}`,
    html: emailWrap({
      heading: 'New Class Booking',
      subtitle: `A new registration has just been received for ${cls.title}.`,
      detailRows: [
        ['Name',       `${registrant.firstName} ${registrant.lastName}`],
        ['Email',      registrant.email],
        ['Phone',      registrant.phone || '—'],
        ['Class',      cls.title],
        ['Date',       formatClassDate(cls.date)],
        ['Time',       formatClassTime(cls.time)],
        ['Instructor', cls.instructor || 'Amanda']
      ],
      body: `<p style="font-size:13px;color:#6b6b6b;margin:0">Open the admin dashboard to mark payment received, view the roster, or message this guest.</p>`,
      buttonLabel: 'Open Admin Dashboard',
      buttonUrl: `${APP_URL}/admin.html`
    })
  });
}

async function sendCreditBookingEmail({ to, firstName, cls, creditsRemaining }) {
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `You're booked — ${cls.title} on ${formatClassDate(cls.date)}`,
    html: emailWrap({
      heading: 'You\'re Booked!',
      subtitle: `1 class credit used — ${creditsRemaining} credit${creditsRemaining !== 1 ? 's' : ''} remaining in your account.`,
      detailRows: [
        ['Class',       cls.title],
        ['Date',        formatClassDate(cls.date)],
        ['Time',        formatClassTime(cls.time)],
        ['Instructor',  cls.instructor],
        ['Duration',    `${cls.duration} minutes`],
        ['Credits Left', `${creditsRemaining} of your 4-class pack`],
      ],
      body: `<p style="font-size:13px;color:#b0b0b0">Cancellations more than 24 hours before class are fully refundable. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>`,
      buttonLabel: 'View My Schedule',
      buttonUrl: `${APP_URL}/my-schedule.html`
    })
  });
}

async function sendPasswordResetEmail({ to, firstName, resetUrl }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[sendPasswordResetEmail] RESEND_API_KEY not set — skipping send');
    return { skipped: 'no-api-key' };
  }
  const result = await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Reset your Red Maple Movement password',
    html: emailWrap({
      heading: 'Password Reset Request',
      subtitle: `Hi ${firstName || 'there'} — click the button below to choose a new password.`,
      detailRows: [],
      body: `<p style="font-size:14px;color:#6b6b6b;margin:0 0 12px">
               This link will expire in 1 hour and can only be used once.
             </p>
             <p style="font-size:13px;color:#b0b0b0;margin:0">
               If you didn't request this, you can safely ignore this email — your password will stay the same.
             </p>`,
      buttonLabel: 'Choose a New Password',
      buttonUrl: resetUrl
    })
  });
  return result;
}

async function sendPackageConfirmedEmail({ to, firstName, cls, creditsRemaining }) {
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `4-Class Package Confirmed — Welcome to Red Maple Movement!`,
    html: emailWrap({
      heading: '4-Class Package Confirmed',
      subtitle: `Payment received — your class is confirmed and ${creditsRemaining} credit${creditsRemaining !== 1 ? 's' : ''} have been added to your account.`,
      detailRows: [
        ['Class',           cls.title],
        ['Date',            formatClassDate(cls.date)],
        ['Time',            formatClassTime(cls.time)],
        ['Instructor',      cls.instructor],
        ['Credits Remaining', `${creditsRemaining} — use these when booking future classes`],
      ],
      body: `<p style="font-size:14px;color:#6b6b6b;margin:0 0 8px">Your remaining credits will be automatically applied when you book your next class — no payment needed until your balance runs out.</p>
             <p style="font-size:13px;color:#b0b0b0;margin:0">Cancellations more than 24 hours before class are fully refundable. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>`,
      buttonLabel: 'Book Your Next Class',
      buttonUrl: `${APP_URL}/register.html`
    })
  });
}

// DATABASE_URL is guaranteed present by the env gate above.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Log unhandled errors so they appear in Railway logs ---
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// --- DB Init (runs first — all tables must exist before middleware starts) ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      instructor  TEXT NOT NULL DEFAULT 'Studio Instructor',
      date        TEXT NOT NULL,
      time        TEXT NOT NULL,
      duration    INTEGER NOT NULL DEFAULT 60,
      capacity    INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id            TEXT PRIMARY KEY,
      "classId"     TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      "firstName"   TEXT NOT NULL,
      "lastName"    TEXT NOT NULL,
      email         TEXT NOT NULL,
      phone         TEXT NOT NULL DEFAULT '',
      "registeredAt" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      first_name    TEXT NOT NULL DEFAULT '',
      last_name     TEXT NOT NULL DEFAULT '',
      google_id     TEXT UNIQUE,
      facebook_id   TEXT UNIQUE,
      is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Add is_admin column to existing databases that predate this migration
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Session table — created separately so connect-pg-simple can also manage it
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid    VARCHAR NOT NULL,
      sess   JSON    NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT user_sessions_pkey PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS IDX_user_sessions_expire ON user_sessions (expire);
  `);

  // Fix deferrable PK on user_sessions — connect-pg-simple requires a non-deferrable PK
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_sessions_pkey' AND condeferrable = true
      ) THEN
        ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_pkey;
        ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (sid);
      END IF;
    END $$;
  `);

  // Waivers table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waivers (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      first_name      TEXT NOT NULL,
      last_name       TEXT NOT NULL,
      email           TEXT NOT NULL,
      phone           TEXT NOT NULL DEFAULT '',
      emergency_name  TEXT NOT NULL DEFAULT '',
      emergency_phone TEXT NOT NULL DEFAULT '',
      health_conditions TEXT NOT NULL DEFAULT '',
      signature_data  TEXT NOT NULL,
      signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Add pilates_experience column — captured at waiver signing ('first_class',
  // 'under_5', or 'over_5'). Nullable for pre-existing waivers signed before
  // this field was introduced.
  await pool.query(`
    ALTER TABLE waivers ADD COLUMN IF NOT EXISTS pilates_experience TEXT NOT NULL DEFAULT '';
  `);

  // Settings table (key-value store for admin configuration)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Add payment_status column to existing registrations tables
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
  `);

  // Add payment_alert_sent column — tracks whether admin has been notified for this unpaid registration
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_alert_sent BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Add package_type column — 'single', '4pack', or 'credit'
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS package_type TEXT NOT NULL DEFAULT 'single';
  `);

  // reminder_sent_at — stamped when the 23-hour reminder email has been sent
  // so the hourly cron doesn't send duplicates. NULL means 'not yet sent'.
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
  `);

  // batch_id — groups sibling registrations created from a single multi-class
  // cart submission. Used so the user gets ONE combined confirmation email
  // ($25 × N total) instead of N separate emails, and so admin Mark Paid
  // flips all siblings at once.
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS batch_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_registrations_batch ON registrations(batch_id) WHERE batch_id IS NOT NULL;
  `);

  // Add user_id column to registrations for linking to the credits system
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Class credits — tracks each user's remaining credit balance
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_credits (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance    INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Password reset tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pw_resets_user ON password_resets(user_id);
  `);

  // Page Editor — admin-editable text/markdown content keyed by a short id.
  // Pages use <tag data-content-key="home.hero.headline"> and a client-side
  // loader swaps the default content with whatever's in the DB. If a key
  // has no row the HTML default shows — graceful fallback.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_content (
      content_key   TEXT PRIMARY KEY,
      content_value TEXT NOT NULL DEFAULT '',
      content_type  TEXT NOT NULL DEFAULT 'text',
      page          TEXT NOT NULL,
      label         TEXT NOT NULL DEFAULT '',
      help_text     TEXT NOT NULL DEFAULT '',
      sort_order    INTEGER NOT NULL DEFAULT 100,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_page_content_page ON page_content(page, sort_order);
  `);

  // Admin-uploaded images (hero, portraits, etc.) stored as bytea so the
  // serverless filesystem's ephemerality isn't an issue. Served via
  // GET /api/images/:key with a Cache-Control header.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_images (
      image_key   TEXT PRIMARY KEY,
      mime_type   TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      data        BYTEA NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed the page_content rows with known keys + human-friendly labels.
  // ON CONFLICT DO NOTHING so subsequent boots don't overwrite admin edits.
  const seeds = [
    // HOME
    ['home', 10,  'home.hero.subtitle',    'text',     'Hero eyebrow',           'The small text above the main headline on the home page (e.g. "Move. Breathe. Transform.")'],
    ['home', 20,  'home.hero.headline',    'text',     'Hero headline',          'The big main heading on the home page (HTML allowed for line breaks — use a <br> tag if needed)'],
    ['home', 30,  'home.hero.body',        'markdown', 'Hero body paragraph',    'Intro paragraph under the headline. Markdown allowed.'],
    ['home', 40,  'home.hero.cta_label',   'text',     'Hero CTA button label',  'The call-to-action button next to the hero (e.g. "Reserve Your Spot")'],

    // ABOUT
    ['about', 10, 'about.hero.subtitle',   'text',     'Page eyebrow',           'Small text above the About-Me page headline (e.g. "Meet Amanda")'],
    ['about', 20, 'about.hero.headline',   'text',     'Page headline',          'The main heading on the About-Me page (e.g. "About Me")'],
    ['about', 30, 'about.bio.heading',     'text',     'Bio heading',            'Heading above the bio ("Hi, I\'m Amanda.")'],
    ['about', 40, 'about.bio.body',        'markdown', 'Bio / main body',        'Main bio text. Use blank lines between paragraphs. Markdown supported: **bold**, *italic*, lists, links.'],
    ['about', 50, 'about.portrait.image',  'image',    'Portrait photo',         'Main portrait / studio photo (recommended 600-1200 px wide, JPG or PNG, max 5 MB)'],

    // PRICING
    ['pricing', 10, 'pricing.hero.subtitle','text',    'Page eyebrow',           'Small text above the Pricing page headline'],
    ['pricing', 20, 'pricing.hero.headline','text',    'Page headline',          'The main heading on the Pricing page (e.g. "Pricing")'],
    ['pricing', 30, 'pricing.hero.body',    'text',    'Intro paragraph',        'Short intro paragraph under the Pricing headline'],
    ['pricing', 40, 'pricing.footer.note',  'markdown','Footer note',            'Note below the pricing cards — payment instructions, location, contact etc. Markdown supported.'],

    // CANCELLATION POLICY
    ['policy', 10,  'policy.body',          'markdown','Policy body',            'Full cancellation-policy text. Markdown supported (headings with ##, bullets with -).'],

    // WAIVER
    ['waiver', 10,  'waiver.intro.body',    'markdown','Waiver intro paragraph', 'Friendly intro paragraph shown above the waiver form. The legal liability text remains hard-coded for legal safety.']
  ];
  for (const [page, sort, key, type, label, help] of seeds) {
    await pool.query(`
      INSERT INTO page_content (content_key, content_value, content_type, page, label, help_text, sort_order)
      VALUES ($1, '', $2, $3, $4, $5, $6)
      ON CONFLICT (content_key) DO UPDATE
        SET label = EXCLUDED.label,
            help_text = EXCLUDED.help_text,
            sort_order = EXCLUDED.sort_order,
            page = EXCLUDED.page,
            content_type = EXCLUDED.content_type
    `, [key, type, page, label, help, sort]);
  }

  // Microsoft Clarity API response cache — keyed by bucket (e.g. 'overview',
  // 'geo-device', 'pages-refs') because the Clarity Data Export API is limited
  // to 10 calls per project per day. We refresh each bucket every 8 hours.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clarity_api_cache (
      bucket_key  TEXT PRIMARY KEY,
      response    JSONB NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error       TEXT
    );
  `);

  // Cancelled registrations archive — preserves a record of cancelled bookings
  // so admin can see the full booking history for a user (registered / cancelled / attended)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cancelled_registrations (
      id             TEXT PRIMARY KEY,
      "classId"      TEXT,
      "firstName"    TEXT NOT NULL,
      "lastName"     TEXT NOT NULL,
      email          TEXT NOT NULL,
      phone          TEXT NOT NULL DEFAULT '',
      "registeredAt" TEXT NOT NULL,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      package_type   TEXT NOT NULL DEFAULT 'single',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      class_title    TEXT,
      class_date     TEXT,
      class_time     TEXT,
      class_instructor TEXT,
      cancelled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_by   TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_cancelled_user ON cancelled_registrations(user_id);
    CREATE INDEX IF NOT EXISTS idx_cancelled_email ON cancelled_registrations(LOWER(email));
  `);

}

// --- App factory (shared by Railway server and Vercel serverless) ---
async function createApp() {
  // 1. Initialise DB — tables exist before session store starts
  await initDB();
  console.log('Database ready.');

  const app = express();
  app.set('trust proxy', 1);

  // 1a. Security headers (must come before other middleware so every response gets them)
  // - CSP script-src allows the CDN/analytics origins the frontend uses:
  //   jsDelivr (Chart.js on admin), Clarity, Vercel Insights.
  // - 'unsafe-inline' is permitted for BOTH scripts and styles because the
  //   existing HTML pages (login, register, schedule, waiver, admin, etc.)
  //   embed large inline <script> blocks and inline style attributes.
  //   Removing them cleanly is a sizeable refactor (tracked as a P2 item:
  //   "migrate inline scripts to external files or add per-request nonces").
  //   Until then, 'unsafe-inline' is the trade-off that keeps the site
  //   functional. Everything else in this CSP still provides meaningful
  //   defense: frameAncestors 'none' blocks clickjacking, formAction 'self'
  //   blocks off-site form posts, objectSrc 'none' blocks Flash/plugins,
  //   baseUri 'self' blocks <base> tag injection, and the origin allowlists
  //   on img/font/connect limit exfiltration channels.
  // - HSTS only in production — local dev runs over HTTP.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Third-party scripts: jsDelivr (Chart.js admin, jsPDF waiver),
        // Clarity (opt-in analytics), Vercel Insights, and the Google Maps JS
        // API used by the admin location-autocomplete (maps.googleapis.com
        // serves the API loader, maps.gstatic.com serves sub-scripts it pulls).
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://www.clarity.ms', 'https://*.clarity.ms', 'https://*.vercel-insights.com', 'https://maps.googleapis.com', 'https://maps.gstatic.com'],
        scriptSrcAttr: ["'unsafe-inline'"],  // allows onclick= etc. used in legacy pages
        // Google Fonts for typography; Google Maps injects a few inline styles.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // 'https:' for imgSrc is intentionally broad — Google Maps tiles,
        // Clarity trackers, and the studio's own CDN assets all load images
        // from varying origins we don't control.
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'"],
        // connect-src controls XHR/fetch/WebSocket destinations. Places API
        // does runtime autocomplete fetches to maps.googleapis.com, and the
        // Maps JS API also chatters with maps.gstatic.com and google.com.
        connectSrc: ["'self'", 'https://*.clarity.ms', 'https://*.vercel-insights.com', 'https://maps.googleapis.com', 'https://maps.gstatic.com', 'https://www.google.com'],
        // frame-src controls iframes embedded BY our pages. Without this,
        // default-src 'self' blocks the Google Maps studio-location embed on
        // schedule.html. frameAncestors below still prevents OTHER sites from
        // embedding us (clickjacking defense) — those are independent directives.
        frameSrc: ["'self'", 'https://www.google.com', 'https://maps.google.com'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,    // we host external fonts + images
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false
  }));

  // Behind Vercel's proxy; required so express-rate-limit sees the real client IP
  // and req.secure reflects the original TLS termination.
  app.set('trust proxy', 1);

  // 2. Session middleware — DB tables are guaranteed to exist now
  app.use(session({
    store: new pgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: false  // table was just created above
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: IS_PROD,
      httpOnly: true,
      // 'lax' blocks cross-site POST/PUT/DELETE (CSRF) but still lets
      // top-level GET navigation carry the session — which is what the OAuth
      // callback flow relies on. All state-changing requests go through fetch
      // with Content-Type: application/json, which browsers can't forge cross-site.
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  }));

  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.json());

  // --- Server-side SEO injection for /schedule.html ---
  // The schedule page normally loads classes client-side via /api/classes, which
  // means search-engine crawlers and LLM bots that don't execute JS see an empty
  // calendar. We intercept /schedule.html BEFORE express.static, query upcoming
  // classes, and inject a crawlable <section> + Event JSON-LD so that Google,
  // Perplexity, ChatGPT, etc. can quote concrete class info ("what classes are
  // on this week in Campbellville?"). The visual JS calendar is untouched.
  let _scheduleHtmlCache = null;
  function getScheduleTemplate() {
    if (!_scheduleHtmlCache) {
      _scheduleHtmlCache = fs.readFileSync(path.join(__dirname, 'public', 'schedule.html'), 'utf8');
    }
    return _scheduleHtmlCache;
  }

  app.get('/schedule.html', async (req, res, next) => {
    try {
      const template = getScheduleTemplate();

      // Next ~12 upcoming classes, joined with registration counts for availability.
      // Uses the same query shape as /api/classes but filters to future dates only.
      const { rows: classes } = await pool.query(`
        SELECT c.*, COUNT(r.id)::int AS "registeredCount"
        FROM classes c
        LEFT JOIN registrations r ON r."classId" = c.id
        WHERE (c.date || ' ' || c.time)::timestamp >= NOW() - INTERVAL '1 hour'
        GROUP BY c.id
        ORDER BY c.date, c.time
        LIMIT 12
      `);

      const htmlItems = classes.map(c => {
        const spotsLeft = Math.max(0, (c.capacity || 0) - (c.registeredCount || 0));
        const availability = spotsLeft > 0 ? `${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} available` : 'Fully booked';
        return `
    <li class="seo-class-item">
      <strong>${escapeHtml(c.title || 'Mat Pilates')}</strong> with ${escapeHtml(c.instructor || 'Studio Instructor')} — ${escapeHtml(c.date)} at ${escapeHtml(c.time)} (${c.duration || 60} min). ${availability}.${c.description ? ` ${escapeHtml(c.description)}` : ''}
    </li>`;
      }).join('');

      const jsonLdEvents = classes.map(c => {
        // Combine date + time into a best-effort ISO 8601 local timestamp.
        // Classes are stored in studio-local time (America/Toronto); we emit
        // a naive ISO string which Google accepts for recurring local events.
        const startDate = `${c.date}T${c.time}:00`;
        const endMinutes = (c.duration || 60);
        // Compute end time by adding minutes — quick arithmetic, good enough for schema.
        const [hh, mm] = (c.time || '00:00').split(':').map(Number);
        const endDt = new Date(2000, 0, 1, hh, mm + endMinutes);
        const endTime = `${String(endDt.getHours()).padStart(2,'0')}:${String(endDt.getMinutes()).padStart(2,'0')}`;
        const endDate = `${c.date}T${endTime}:00`;
        const spotsLeft = Math.max(0, (c.capacity || 0) - (c.registeredCount || 0));
        return {
          "@context": "https://schema.org",
          "@type": "Event",
          "name": c.title || "Mat Pilates Class",
          "description": c.description || "Small-group mat Pilates class at Red Maple Movement.",
          "startDate": startDate,
          "endDate": endDate,
          "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
          "eventStatus": spotsLeft > 0 ? "https://schema.org/EventScheduled" : "https://schema.org/EventScheduled",
          "location": {
            "@type": "Place",
            "name": "Red Maple Movement",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "43 Main Street South, Suite 2B",
              "addressLocality": "Campbellville",
              "addressRegion": "ON",
              "postalCode": "L0P 1B0",
              "addressCountry": "CA"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "Red Maple Movement",
            "url": "https://redmaplemovement.ca"
          },
          "performer": {
            "@type": "Person",
            "name": c.instructor || "Studio Instructor"
          },
          "offers": {
            "@type": "Offer",
            "url": "https://redmaplemovement.ca/schedule.html",
            "price": "25.00",
            "priceCurrency": "CAD",
            "availability": spotsLeft > 0 ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
            "validFrom": new Date().toISOString()
          }
        };
      });

      const injection = classes.length === 0 ? '' : `
<!-- SEO: server-rendered upcoming classes (hidden visually; the JS calendar is the UI) -->
<section class="seo-upcoming-classes" aria-label="Upcoming Pilates classes at Red Maple Movement" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;">
  <h2>Upcoming Pilates Classes in Campbellville, ON</h2>
  <p>Red Maple Movement hosts small-group mat Pilates classes at 43 Main Street South, Suite 2B, Campbellville, Ontario. Upcoming schedule:</p>
  <ul>${htmlItems}
  </ul>
</section>
<script type="application/ld+json">
${JSON.stringify(jsonLdEvents, null, 2)}
</script>
`;

      const rendered = template.replace('</body>', `${injection}</body>`);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=300'); // 5 min edge cache
      return res.send(rendered);
    } catch (err) {
      // Any failure: fall through to static handler, which will serve the raw file.
      console.error('schedule.html SEO injection failed:', err);
      return next();
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // --- Rate limiters ---
  // Narrow limiters applied only to credential-handling endpoints. Keeps legitimate
  // users unaffected while throttling brute-force / credential-stuffing / spam-reset.
  // `trust proxy` above ensures the IP is the real client, not the Vercel edge.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 min
    limit: 10,                  // 10 attempts / IP / window
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts — please wait a few minutes and try again.' }
  });
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,   // 1 hr
    limit: 60,                  // matches expected booking flow; generous
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many registrations from this network — please wait and retry.' }
  });

  // Ensure session is fully written to DB before any redirect (fixes Vercel serverless OAuth state loss)
  app.use((req, res, next) => {
    const originalRedirect = res.redirect.bind(res);
    res.redirect = function(url) {
      if (req.session) {
        req.session.save(() => originalRedirect(url));
      } else {
        originalRedirect(url);
      }
    };
    next();
  });

  // 3. Passport
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, email, first_name, last_name, is_admin FROM users WHERE id = $1', [id]
      );
      done(null, rows[0] || false);
    } catch (e) { done(e); }
  });

  passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]
      );
      const user = rows[0];
      if (!user) return done(null, false, { message: 'No account found with that email.' });
      if (!user.password_hash) return done(null, false, { message: 'Please sign in with Google or Facebook.' });
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return done(null, false, { message: 'Incorrect password.' });
      return done(null, user);
    } catch (e) { return done(e); }
  }));

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${APP_URL}/auth/google/callback`
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const email     = profile.emails?.[0]?.value;
        const firstName = profile.name?.givenName  || '';
        const lastName  = profile.name?.familyName || '';
        const { rows } = await pool.query(
          'SELECT * FROM users WHERE google_id = $1' + (email ? ' OR LOWER(email) = LOWER($2)' : ''),
          email ? [profile.id, email] : [profile.id]
        );
        let user = rows[0];
        if (user) {
          if (!user.google_id) await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.id, user.id]);
          return done(null, user);
        }
        // Fresh account for this email — first wipe any orphan artifacts
        // left behind by a previous (incomplete) deletion of this email
        if (email) await purgeOrphansByEmail(email);
        const { rows: created } = await pool.query(
          'INSERT INTO users (email, google_id, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING *',
          [email ? email.toLowerCase() : null, profile.id, firstName, lastName]
        );
        return done(null, created[0]);
      } catch (e) { return done(e); }
    }));
  }

  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use(new FacebookStrategy({
      clientID:      process.env.FACEBOOK_APP_ID,
      clientSecret:  process.env.FACEBOOK_APP_SECRET,
      callbackURL:   `${APP_URL}/auth/facebook/callback`,
      profileFields: ['id', 'emails', 'name']
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const email     = profile.emails?.[0]?.value;
        const firstName = profile.name?.givenName  || '';
        const lastName  = profile.name?.familyName || '';
        const { rows } = await pool.query(
          'SELECT * FROM users WHERE facebook_id = $1' + (email ? ' OR LOWER(email) = LOWER($2)' : ''),
          email ? [profile.id, email] : [profile.id]
        );
        let user = rows[0];
        if (user) {
          if (!user.facebook_id) await pool.query('UPDATE users SET facebook_id = $1 WHERE id = $2', [profile.id, user.id]);
          return done(null, user);
        }
        const insertEmail = email ? email.toLowerCase() : `fb_${profile.id}@noemail.local`;
        // Fresh account for this email — first wipe any orphan artifacts
        // left behind by a previous (incomplete) deletion of this email
        if (email) await purgeOrphansByEmail(email);
        const { rows: created } = await pool.query(
          'INSERT INTO users (email, facebook_id, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING *',
          [insertEmail, profile.id, firstName, lastName]
        );
        return done(null, created[0]);
      } catch (e) { return done(e); }
    }));
  }

  // 4. Routes
  app.get('/health', (req, res) => res.send('OK'));

  app.get('/auth/debug', (req, res) => {
    res.json({
      APP_URL:              !!process.env.APP_URL,
      SESSION_SECRET:       !!process.env.SESSION_SECRET,
      GOOGLE_CLIENT_ID:     !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
      FACEBOOK_APP_ID:      !!process.env.FACEBOOK_APP_ID,
      FACEBOOK_APP_SECRET:  !!process.env.FACEBOOK_APP_SECRET,
      NODE_ENV:             process.env.NODE_ENV || '(not set)',
      resolvedAppUrl:       APP_URL
    });
  });

  app.get('/auth/config', (req, res) => {
    res.json({
      googleEnabled:   !!(process.env.GOOGLE_CLIENT_ID   && process.env.GOOGLE_CLIENT_SECRET),
      facebookEnabled: !!(process.env.FACEBOOK_APP_ID    && process.env.FACEBOOK_APP_SECRET)
    });
  });

  // Public site config — safe to expose to all visitors. Used by the client-side
  // analytics loader to conditionally inject third-party trackers (Microsoft
  // Clarity, etc.) based on admin-configured settings.
  app.get('/api/public-config', async (req, res) => {
    try {
      const clarityProjectId = (await getSetting('clarity_project_id')) || '';
      // Short cache — propagate changes within a minute but keep the response
      // cheap for repeat visitors.
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ clarityProjectId });
    } catch (e) {
      console.error('public-config error:', e);
      res.json({ clarityProjectId: '' });
    }
  });

  // ===== Page Editor — content API =====

  // Public: all editable content keys/values. Any visitor may fetch this; the
  // response is a compact map so the client-side loader can apply text/markdown
  // swaps by data-content-key attribute.
  app.get('/api/content', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT content_key, content_value, content_type FROM page_content'
      );
      const map = {};
      for (const row of rows) {
        if (row.content_value) map[row.content_key] = { value: row.content_value, type: row.content_type };
      }
      res.set('Cache-Control', 'public, max-age=30');
      res.json(map);
    } catch (e) { console.error('content get error:', e); res.json({}); }
  });

  // Admin: full content rows (with labels + help text) for the Page Editor UI
  app.get('/api/admin/content', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT content_key, content_value, content_type, page, label, help_text, sort_order, updated_at
        FROM page_content
        ORDER BY page, sort_order, content_key
      `);
      // Also report which image keys have images uploaded so the UI can show previews
      const { rows: imgRows } = await pool.query('SELECT image_key FROM page_images');
      const uploadedImages = new Set(imgRows.map(r => r.image_key));
      res.json({
        items: rows,
        uploadedImages: [...uploadedImages]
      });
    } catch (e) { console.error('admin content get error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: save one content key's value (text or markdown)
  app.post('/api/admin/content', requireAdmin, async (req, res) => {
    const { contentKey, value } = req.body || {};
    if (!contentKey) return res.status(400).json({ error: 'contentKey required' });
    try {
      // Only allow updates to keys that were seeded (whitelist via existence)
      const { rowCount } = await pool.query(
        `UPDATE page_content SET content_value = $1, updated_at = NOW() WHERE content_key = $2`,
        [value || '', contentKey]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Unknown content key' });
      res.json({ success: true });
    } catch (e) { console.error('admin content save error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Public: serve an uploaded image (used by <img src="/api/images/about.portrait.image">)
  app.get('/api/images/:key', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT mime_type, data FROM page_images WHERE image_key = $1',
        [req.params.key]
      );
      if (!rows.length) return res.status(404).send('Not found');
      res.set('Content-Type', rows[0].mime_type);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(rows[0].data);
    } catch (e) { console.error('image serve error:', e); res.status(500).send('Error'); }
  });

  // Admin: upload/replace an image for a specific content key
  app.post('/api/admin/images/:key', requireAdmin, (req, res, next) => {
    imageUpload.single('image')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      next();
    });
  }, async (req, res) => {
    try {
      // Only allow uploads for keys that are declared as content_type = 'image'
      const { rows } = await pool.query(
        `SELECT content_type FROM page_content WHERE content_key = $1`,
        [req.params.key]
      );
      if (!rows.length || rows[0].content_type !== 'image') {
        return res.status(400).json({ error: 'This key is not declared as an image slot' });
      }
      await pool.query(`
        INSERT INTO page_images (image_key, mime_type, size_bytes, data, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (image_key) DO UPDATE
          SET mime_type = EXCLUDED.mime_type,
              size_bytes = EXCLUDED.size_bytes,
              data = EXCLUDED.data,
              updated_at = NOW()
      `, [req.params.key, req.file.mimetype, req.file.size, req.file.buffer]);
      // Also stamp the content_value so /api/content knows the image exists
      const imageUrl = `/api/images/${req.params.key}`;
      await pool.query(
        `UPDATE page_content SET content_value = $1, updated_at = NOW() WHERE content_key = $2`,
        [imageUrl, req.params.key]
      );
      res.json({ success: true, url: imageUrl + '?t=' + Date.now() });
    } catch (e) { console.error('image upload error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: remove an uploaded image (reverts to whatever default the HTML provides)
  app.delete('/api/admin/images/:key', requireAdmin, async (req, res) => {
    try {
      await pool.query('DELETE FROM page_images WHERE image_key = $1', [req.params.key]);
      await pool.query(
        `UPDATE page_content SET content_value = '', updated_at = NOW() WHERE content_key = $1`,
        [req.params.key]
      );
      res.json({ success: true });
    } catch (e) { console.error('image delete error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/auth/me', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ user: null });
    const { id, email, first_name, last_name, is_admin } = req.user;
    // Pull the most recently used phone number from their bookings so the
    // register page can pre-fill it on return visits. Non-fatal if it fails.
    let phone = '';
    try {
      const { rows } = await pool.query(
        `SELECT phone FROM registrations
         WHERE (user_id = $1 OR LOWER(email) = LOWER($2)) AND phone IS NOT NULL AND phone != ''
         ORDER BY "registeredAt" DESC
         LIMIT 1`,
        [id, email]
      );
      if (rows.length) phone = rows[0].phone;
    } catch (e) { /* ignore — just means no pre-fill */ }
    res.json({ user: { id, email, firstName: first_name, lastName: last_name, isAdmin: !!is_admin, phone } });
  });

  app.post('/auth/signup', authLimiter, async (req, res) => {
    const { email, password, firstName, lastName } = req.body;
    if (!email || !password || !firstName || !lastName)
      return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      const { rows: existing } = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (existing.length > 0) return res.status(409).json({ error: 'An account with that email already exists.' });
      // Wipe any orphan records left behind by a previous (incomplete) delete
      // for this email before the new account is created
      await purgeOrphansByEmail(email);
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING *',
        [email.toLowerCase(), hash, firstName.trim(), lastName.trim()]
      );
      req.login(rows[0], err => {
        if (err) return res.status(500).json({ error: 'Account created but sign-in failed.' });
        res.status(201).json({ user: { id: rows[0].id, email: rows[0].email, firstName: firstName.trim(), lastName: lastName.trim() } });
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/auth/login', authLimiter, (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: info?.message || 'Sign in failed.' });
      req.login(user, err2 => {
        if (err2) return next(err2);
        res.json({ user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name } });
      });
    })(req, res, next);
  });

  // Forgot password — send a one-time reset link by email.
  // Always returns success (doesn't leak which emails exist).
  app.post('/auth/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const trimmedEmail = email.trim();
    try {
      const { rows } = await pool.query(
        'SELECT id, email, first_name, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
        [trimmedEmail]
      );
      if (!rows.length) {
        console.log(`[forgot-password] No user for email-hash=${hashForLog(trimmedEmail)} — returning success silently.`);
      } else {
        const user = rows[0];
        if (!user.password_hash) {
          console.log(`[forgot-password] user id=${user.id} (email-hash=${hashForLog(user.email)}) has no password_hash (social login only) — skipping.`);
        } else {
          // Invalidate any prior unused tokens for this user
          await pool.query(
            `UPDATE password_resets SET used_at = NOW()
             WHERE user_id = $1 AND used_at IS NULL`,
            [user.id]
          );
          const token = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
          const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
          await pool.query(
            `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`,
            [tokenHash, user.id, expires]
          );
          const resetUrl = `${APP_URL}/reset-password.html?token=${token}`;
          console.log(`[forgot-password] sending reset email to user id=${user.id} (email-hash=${hashForLog(user.email)}); RESEND_API_KEY present=${!!process.env.RESEND_API_KEY}`);
          // Await so we can surface Resend errors in the response logs immediately
          try {
            const result = await sendPasswordResetEmail({ to: user.email, firstName: user.first_name, resetUrl });
            console.log(`[forgot-password] Resend OK user id=${user.id} messageId=${result?.data?.id || 'n/a'}`);
          } catch (e) {
            console.error(`[forgot-password] Resend error user id=${user.id}:`, e?.message);
          }
        }
      }
      // Always respond success for privacy
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Reset password — consumes the one-time token and sets a new password
  app.post('/auth/reset-password', authLimiter, async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password)  return res.status(400).json({ error: 'Token and password are required.' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const { rows } = await pool.query(
        `SELECT pr.user_id, pr.expires_at, pr.used_at, u.email, u.first_name, u.last_name
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
         WHERE pr.token_hash = $1`,
        [tokenHash]
      );
      if (!rows.length) return res.status(400).json({ error: 'This reset link is invalid or has already been used.' });
      const rec = rows[0];
      if (rec.used_at) return res.status(400).json({ error: 'This reset link has already been used.' });
      if (new Date(rec.expires_at) < new Date())
        return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });

      const hash = await bcrypt.hash(password, 12);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, rec.user_id]);
      await pool.query('UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1', [tokenHash]);

      // Auto-login after reset
      const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id = $1', [rec.user_id]);
      req.login(userRows[0], err => {
        if (err) return res.json({ success: true, autoLogin: false });
        res.json({ success: true, autoLogin: true, email: rec.email });
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/auth/logout', (req, res, next) => {
    req.logout(err => {
      if (err) return next(err);
      res.json({ success: true });
    });
  });

  // --- Self-serve data-subject endpoints (PIPEDA right of access + correction/deletion) ---

  // Export every row we hold for the signed-in user as a single JSON download.
  // This covers the user record (minus password_hash), every registration past
  // and present (live + cancelled_registrations archive), signed waiver(s), and
  // class-credit balance. Matches the admin purge cascade so users can verify
  // there's nothing we'd fail to delete if they later hit DELETE /api/me.
  app.get('/api/me/export', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not signed in.' });
    const userId = req.user.id;
    try {
      const { rows: userRows } = await pool.query(
        `SELECT id, email, first_name, last_name, phone, is_admin, created_at
         FROM users WHERE id = $1`, [userId]);
      if (!userRows.length) return res.status(404).json({ error: 'User not found.' });
      const user = userRows[0];

      const [regs, cancelled, waivers, credits] = await Promise.all([
        pool.query(
          `SELECT r.*, c.title AS class_title, c.date AS class_date, c.time AS class_time
           FROM registrations r LEFT JOIN classes c ON c.id = r."classId"
           WHERE r.user_id = $1 OR LOWER(r.email) = LOWER($2)`,
          [userId, user.email]),
        pool.query(
          `SELECT * FROM cancelled_registrations
           WHERE user_id = $1 OR LOWER(email) = LOWER($2)`,
          [userId, user.email]),
        pool.query(
          `SELECT * FROM waivers
           WHERE user_id = $1 OR LOWER(email) = LOWER($2)`,
          [userId, user.email]),
        pool.query(`SELECT balance FROM user_credits WHERE user_id = $1`, [userId])
      ]);

      const payload = {
        exported_at: new Date().toISOString(),
        note: 'This is every record Red Maple Movement holds about your account. Keep this file private — it contains your signed waiver and booking history.',
        user,
        credit_balance: credits.rows.length ? credits.rows[0].balance : 0,
        registrations: regs.rows,
        cancelled_registrations: cancelled.rows,
        waivers: waivers.rows
      };

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="rmm-my-data-${userId}-${Date.now()}.json"`);
      res.send(JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error('[me/export] error for user id=' + userId + ':', e.message);
      res.status(500).json({ error: 'Could not export your data. Please email amanda@redmaplemovement.ca.' });
    }
  });

  // Permanently delete the signed-in user's account and every row keyed by
  // either their user_id or their email. Mirrors the admin /api/admin/users/:id
  // cascade so the self-serve path leaves exactly the same amount of data
  // behind (none).
  //
  // Safety: refuses if the caller is an admin — an admin self-delete would
  // risk nobody being left to manage the studio. The admin must ask another
  // admin to delete them via the admin dashboard.
  app.delete('/api/me', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not signed in.' });
    const userId = req.user.id;
    if (req.user.is_admin) {
      return res.status(400).json({
        error: 'Admin accounts must be deleted from the admin dashboard by another admin.'
      });
    }
    try {
      const { rows: userRows } = await pool.query(
        'SELECT email FROM users WHERE id = $1', [userId]);
      if (!userRows.length) return res.status(404).json({ error: 'Account not found.' });
      const email = userRows[0].email;

      const deleted = {};
      const del = async (label, q, params) => {
        const { rowCount } = await pool.query(q, params);
        deleted[label] = rowCount;
      };

      await del('registrations',
        'DELETE FROM registrations WHERE user_id = $1 OR LOWER(email) = LOWER($2)',
        [userId, email]);
      await del('cancelled_registrations',
        'DELETE FROM cancelled_registrations WHERE user_id = $1 OR LOWER(email) = LOWER($2)',
        [userId, email]);
      await del('waivers',
        'DELETE FROM waivers WHERE user_id = $1 OR LOWER(email) = LOWER($2)',
        [userId, email]);
      await del('password_resets',
        'DELETE FROM password_resets WHERE user_id = $1',
        [userId]);
      // Kill any active login sessions on other devices
      await del('user_sessions',
        `DELETE FROM user_sessions WHERE sess::jsonb -> 'passport' ->> 'user' = $1`,
        [String(userId)]);
      // Finally the user row itself (user_credits cascades via FK)
      await del('users', 'DELETE FROM users WHERE id = $1', [userId]);

      console.log(`[me/delete] self-purged user id=${userId} email-hash=${hashForLog(email)}:`, deleted);

      // End the current session too
      req.logout(err => {
        if (err) {
          // The rows are already gone — just tell the client it worked even
          // if logout had a glitch. The next request to any authenticated
          // endpoint will 401 because the user row no longer exists.
          return res.json({ success: true, purged: deleted });
        }
        res.json({ success: true, purged: deleted });
      });
    } catch (e) {
      console.error('[me/delete] error for user id=' + userId + ':', e.message);
      res.status(500).json({ error: 'Could not delete account. Please email amanda@redmaplemovement.ca.' });
    }
  });

  app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google-not-configured');
    // Persist the returnTo into the session BEFORE initiating the OAuth
    // redirect. Without an explicit save the browser can follow the 302 to
    // accounts.google.com before express-session has written the row to
    // Postgres, meaning the callback loads a session without authReturnTo
    // and falls back to '/' — the cause of 'landed on home page instead of
    // checkout' reports.
    const start = () => passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
    if (req.query.returnTo) {
      req.session.authReturnTo = req.query.returnTo;
      req.session.save(err => {
        if (err) console.error('Google auth session save error:', err.message);
        start();
      });
    } else {
      start();
    }
  });
  // Normalize an arbitrary returnTo value into a safe same-origin path.
  // Rejects protocol-relative (//evil.com) and external (https://evil.com)
  // destinations — those are open-redirect foot-guns — and collapses any
  // mix of leading slashes to exactly one. Falls back to '/' on anything
  // suspicious, which is why Chrome was barfing with ERR_INVALID_REDIRECT
  // before: the old `'/' + returnTo` trick produced '//register.html'
  // when returnTo already started with a slash.
  function safeReturnTo(raw) {
    if (!raw || typeof raw !== 'string') return '/';
    let s = String(raw).trim();
    // Block absolute URLs and protocol-relative URLs outright
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '/';   // http:, https:, javascript:, etc.
    if (s.startsWith('//'))              return '/';   // protocol-relative
    if (s.startsWith('\\'))              return '/';   // windows-style
    // Strip ALL leading slashes, then prepend exactly one
    s = '/' + s.replace(/^\/+/, '');
    return s;
  }

  app.get('/auth/google/callback', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google-not-configured');
    passport.authenticate('google', (err, user) => {
      if (err) { console.error('Google auth error:', err.message || err); return res.redirect('/login.html?error=google'); }
      if (!user) { console.error('Google auth: no user returned'); return res.redirect('/login.html?error=google'); }
      // ⚠ Capture authReturnTo BEFORE req.login. Passport 0.6+ regenerates
      // the session inside req.login for session-fixation protection, which
      // would otherwise wipe our authReturnTo and cause the user to land
      // on '/' instead of the intended destination (register.html, etc.).
      const returnTo = safeReturnTo(req.session.authReturnTo);
      delete req.session.authReturnTo;
      req.login(user, (loginErr) => {
        if (loginErr) { console.error('Google login error:', loginErr.message || loginErr); return res.redirect('/login.html?error=google'); }
        // Explicit save so the new (post-regeneration) session is in Postgres
        // before the browser follows the redirect.
        req.session.save(saveErr => {
          if (saveErr) console.error('Google session save error:', saveErr.message);
          return res.redirect(returnTo);
        });
      });
    })(req, res, next);
  });

  app.get('/auth/facebook', (req, res, next) => {
    if (!process.env.FACEBOOK_APP_ID) return res.redirect('/login.html?error=facebook-not-configured');
    const start = () => passport.authenticate('facebook', { scope: ['email'] })(req, res, next);
    if (req.query.returnTo) {
      req.session.authReturnTo = req.query.returnTo;
      req.session.save(err => {
        if (err) console.error('Facebook auth session save error:', err.message);
        start();
      });
    } else {
      start();
    }
  });
  app.get('/auth/facebook/callback', (req, res, next) => {
    if (!process.env.FACEBOOK_APP_ID) return res.redirect('/login.html?error=facebook-not-configured');
    passport.authenticate('facebook', (err, user) => {
      if (err)   { console.error('Facebook auth error:', err.message || err); return res.redirect('/login.html?error=facebook'); }
      if (!user) { console.error('Facebook auth: no user returned'); return res.redirect('/login.html?error=facebook'); }
      // Capture authReturnTo BEFORE req.login (see Google callback comment)
      const returnTo = safeReturnTo(req.session.authReturnTo);
      delete req.session.authReturnTo;
      req.login(user, (loginErr) => {
        if (loginErr) { console.error('Facebook login error:', loginErr.message || loginErr); return res.redirect('/login.html?error=facebook'); }
        req.session.save(saveErr => {
          if (saveErr) console.error('Facebook session save error:', saveErr.message);
          return res.redirect(returnTo);
        });
      });
    })(req, res, next);
  });

  // --- Admin middleware ---
  function requireAdmin(req, res, next) {
    if (!req.isAuthenticated() || !req.user.is_admin) {
      return res.status(401).json({ error: 'Admin access required' });
    }
    next();
  }

  app.get('/api/classes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*, COUNT(r.id)::int AS "registeredCount"
        FROM classes c
        LEFT JOIN registrations r ON r."classId" = c.id
        GROUP BY c.id ORDER BY c.date, c.time
      `);
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/classes', requireAdmin, async (req, res) => {
    const { title, instructor, date, time, duration, capacity, description } = req.body;
    if (!title || !date || !time || !capacity) return res.status(400).json({ error: 'Missing required fields' });
    const newClass = {
      id: Date.now().toString(), title,
      instructor: instructor || 'Studio Instructor', date, time,
      duration: parseInt(duration) || 60, capacity: parseInt(capacity),
      description: description || ''
    };
    try {
      await pool.query(
        `INSERT INTO classes (id,title,instructor,date,time,duration,capacity,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newClass.id, newClass.title, newClass.instructor, newClass.date, newClass.time, newClass.duration, newClass.capacity, newClass.description]
      );
      res.status(201).json(newClass);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.put('/api/classes/:id', requireAdmin, async (req, res) => {
    const { title, instructor, date, time, duration, capacity, description } = req.body;
    if (!title || !date || !time || !capacity) return res.status(400).json({ error: 'Missing required fields' });
    try {
      const { rowCount } = await pool.query(
        `UPDATE classes SET title=$1, instructor=$2, date=$3, time=$4, duration=$5, capacity=$6, description=$7 WHERE id=$8`,
        [title, instructor || 'Studio Instructor', date, time, parseInt(duration) || 60, parseInt(capacity), description || '', req.params.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
      res.json({ success: true, id: req.params.id, title, instructor, date, time, duration, capacity, description });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.delete('/api/classes/:id', requireAdmin, async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Get current user's credit balance
  app.get('/api/credits/me', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ balance: 0 });
    try {
      const { rows } = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [req.user.id]);
      res.json({ balance: rows.length ? rows[0].balance : 0 });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/register', registerLimiter, async (req, res) => {
    const { classId, firstName, lastName, email, phone, packageType, password, batchId } = req.body;
    if (!classId || !firstName || !lastName || !email)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!req.isAuthenticated() && (!password || password.length < 8))
      return res.status(400).json({ error: 'Please create a password (min. 8 characters) to set up your account.' });
    try {
      const { rows: clsRows } = await pool.query('SELECT * FROM classes WHERE id = $1', [classId]);
      if (clsRows.length === 0) return res.status(404).json({ error: 'Class not found' });
      const cls = clsRows[0];
      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM registrations WHERE "classId" = $1', [classId]
      );
      if (countRows[0].n >= cls.capacity) return res.status(409).json({ error: 'Class is full' });
      const { rows: dupRows } = await pool.query(
        'SELECT id FROM registrations WHERE "classId" = $1 AND LOWER(email) = LOWER($2)', [classId, email]
      );
      if (dupRows.length > 0) return res.status(409).json({ error: 'You are already registered for this class' });

      const registrationId = Date.now().toString();
      let userId = req.isAuthenticated() ? req.user.id : null;
      let accountCreated = false;

      // ── Optional account creation during booking ───────────────
      if (password && !req.isAuthenticated() && password.length >= 8) {
        try {
          const { rows: existing } = await pool.query(
            'SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1)', [email]
          );
          const hash = await bcrypt.hash(password, 12);
          if (existing.length > 0) {
            // User record exists (e.g. Google login) — add password if not already set
            userId = existing[0].id;
            if (!existing[0].password_hash) {
              await pool.query(
                'UPDATE users SET password_hash=$1, first_name=$2, last_name=$3 WHERE id=$4',
                [hash, firstName.trim(), lastName.trim(), userId]
              );
              accountCreated = true;
            }
            await new Promise((resolve, reject) =>
              req.login(existing[0], err => err ? reject(err) : resolve())
            ).catch(() => {});
          } else {
            // Brand new user — wipe any orphan records tied to this email
            // from a previous deleted account, then create account and log in
            await purgeOrphansByEmail(email);
            const { rows: newUser } = await pool.query(
              'INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING *',
              [email.toLowerCase(), hash, firstName.trim(), lastName.trim()]
            );
            userId = newUser[0].id;
            accountCreated = true;
            await new Promise((resolve, reject) =>
              req.login(newUser[0], err => err ? reject(err) : resolve())
            ).catch(() => {});
          }
        } catch (e) { console.error('Account creation error during booking:', e); }
      }

      // ── Credit booking: deduct 1 credit, auto-confirm ──────────
      if (packageType === 'credit') {
        if (!req.isAuthenticated()) return res.status(401).json({ error: 'Please sign in to use credits.' });
        const { rows: cr } = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [req.user.id]);
        const balance = cr.length ? cr[0].balance : 0;
        if (balance <= 0) return res.status(400).json({ error: 'No class credits remaining.' });
        // Deduct 1 credit
        await pool.query(`
          INSERT INTO user_credits (user_id, balance, updated_at) VALUES ($1, $2, NOW())
          ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance - 1, updated_at = NOW()
        `, [req.user.id, balance - 1]);
        await pool.query(
          `INSERT INTO registrations (id,"classId","firstName","lastName",email,phone,"registeredAt",payment_status,package_type,user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'paid','credit',$8)`,
          [registrationId, classId, firstName, lastName, email, phone || '', new Date().toISOString(), userId]
        );
        const creditsRemaining = balance - 1;
        res.status(201).json({ success: true, registrationId, packageType: 'credit', creditsRemaining, accountCreated });
        sendCreditBookingEmail({ to: email, firstName, cls, creditsRemaining }).catch(console.error);
        return;
      }

      // ── 4-pack or single: create pending registration ──────────
      const pkgType = packageType === '4pack' ? '4pack' : 'single';
      // Batch drop-in registrations share a batch_id so the user gets one
      // combined confirmation email + admin Mark Paid flips all siblings.
      // Only stored for 'single' (drop-in) bookings — 4-pack is a single
      // payment by design.
      const effectiveBatchId = (pkgType === 'single' && batchId) ? String(batchId) : null;
      await pool.query(
        `INSERT INTO registrations (id,"classId","firstName","lastName",email,phone,"registeredAt",payment_status,package_type,user_id,batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`,
        [registrationId, classId, firstName, lastName, email, phone || '', new Date().toISOString(), pkgType, userId, effectiveBatchId]
      );
      res.status(201).json({ success: true, registrationId, packageType: pkgType, batchId: effectiveBatchId, accountCreated });
      // Skip the per-class confirmation email if this booking is part of a
      // batch — the client will hit /api/register/batch-confirmation once
      // after the whole batch is created to send ONE combined email.
      if (!effectiveBatchId) {
        sendConfirmationEmail({ to: email, firstName, lastName, cls, registrationId, packageType: pkgType })
          .catch(e => console.error('Confirmation email error:', e.message));
      }
      // Admin notification — deferred for batched bookings; sent as a single
      // combined admin notice by /api/register/batch-confirmation instead
      if (!effectiveBatchId) {
        getSetting('booking_notify_email').then(notifyEmail => {
          if (notifyEmail) sendNewBookingNotification({ notifyEmail, registrant: { firstName, lastName, email, phone }, cls })
            .catch(e => console.error('Notify email error:', e.message));
        });
      }
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Called by the client once after a cart's worth of /api/register calls
  // succeed — sends ONE combined confirmation email for all drop-in classes
  // in that batch instead of N per-class emails.
  app.post('/api/register/batch-confirmation', async (req, res) => {
    const { batchId } = req.body || {};
    if (!batchId) return res.status(400).json({ error: 'batchId required' });
    try {
      const { rows } = await pool.query(`
        SELECT r.id AS "registrationId", r."firstName", r."lastName", r.email, r.phone,
               c.title, c.date, c.time, c.instructor
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE r.batch_id = $1
        ORDER BY c.date ASC, c.time ASC
      `, [batchId]);
      if (!rows.length) return res.status(404).json({ error: 'No registrations found for this batch' });
      const { firstName, lastName, email, phone } = rows[0];
      const classes = rows.map(r => ({
        registrationId: r.registrationId,
        title: r.title, date: r.date, time: r.time, instructor: r.instructor
      }));
      // Fire confirmation email (don't await so the response isn't blocked
      // by Resend's latency)
      sendBatchDropInConfirmation({ to: email, firstName, lastName, classes })
        .catch(e => console.error('Batch confirmation email error:', e.message));
      // Also notify admin once, with the first class (keeps existing
      // admin-notification template unchanged for now)
      getSetting('booking_notify_email').then(notifyEmail => {
        if (notifyEmail) {
          const first = classes[0];
          sendNewBookingNotification({
            notifyEmail,
            registrant: { firstName, lastName, email, phone },
            cls: { title: `${first.title} (+${classes.length - 1} more class${classes.length === 2 ? '' : 'es'})`,
                   date: first.date, time: first.time, instructor: first.instructor }
          }).catch(e => console.error('Notify email error:', e.message));
        }
      });
      res.json({ success: true, classesEmailed: classes.length });
    } catch (e) { console.error('batch-confirmation error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  app.get('/api/registrations', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.*, c.title, c.date, c.time, c.instructor
        FROM registrations r LEFT JOIN classes c ON c.id = r."classId"
        ORDER BY r."registeredAt" DESC
      `);
      const enriched = rows.map(r => ({
        id: r.id, classId: r.classId, firstName: r.firstName,
        lastName: r.lastName, email: r.email, phone: r.phone,
        registeredAt: r.registeredAt, paymentStatus: r.payment_status,
        packageType: r.package_type || 'single', userId: r.user_id, batchId: r.batch_id,
        class: r.title ? { title: r.title, date: r.date, time: r.time, instructor: r.instructor } : null
      }));
      res.json(enriched);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // My registrations — logged-in user only
  app.get('/api/my-registrations', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(`
        SELECT r.id, r."classId", r."firstName", r."lastName", r.email, r.phone, r."registeredAt",
               r.payment_status, r.package_type,
               c.title, c.date, c.time, c.instructor, c.duration, c.description
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE LOWER(r.email) = LOWER($1)
        ORDER BY c.date ASC, c.time ASC
      `, [req.user.email]);
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Combined account summary for my-schedule.html — credits balance + bundle history
  app.get('/api/my-account-summary', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const userId = req.user.id;
      const email  = req.user.email;

      const { rows: cr } = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [userId]);
      const creditBalance = cr.length ? cr[0].balance : 0;

      // Count every 4-pack purchase on record (active + cancelled) to compute total credits purchased
      const { rows: activeBundles } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM registrations
        WHERE package_type = '4pack' AND (user_id = $1 OR LOWER(email) = LOWER($2))
      `, [userId, email]);
      const { rows: cancelledBundles } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM cancelled_registrations
        WHERE package_type = '4pack' AND (user_id = $1 OR LOWER(email) = LOWER($2))
      `, [userId, email]);
      const bundleCount = (activeBundles[0]?.n || 0) + (cancelledBundles[0]?.n || 0);

      // Count pending payments for a quick summary banner
      const { rows: pending } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM registrations
        WHERE payment_status != 'paid' AND (user_id = $1 OR LOWER(email) = LOWER($2))
      `, [userId, email]);

      // Count pending 4-pack bundle bookings specifically — each one will
      // unlock 3 new credits once payment is marked received, so the
      // Class Credits card can show the user what's coming.
      const { rows: pendingBundles } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM registrations
        WHERE package_type = '4pack' AND payment_status != 'paid'
          AND (user_id = $1 OR LOWER(email) = LOWER($2))
      `, [userId, email]);

      res.json({
        creditBalance,
        bundleCount,
        pendingPayments: pending[0]?.n || 0,
        pendingBundles: pendingBundles[0]?.n || 0
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.delete('/api/my-registrations/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(`
        SELECT r.*, c.title, c.date, c.time, c.instructor FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE r.id = $1 AND LOWER(r.email) = LOWER($2)
      `, [req.params.id, req.user.email]);
      if (rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
      const reg = rows[0];
      const classStart = new Date(`${reg.date}T${reg.time}`);
      const hoursUntilClass = (classStart - new Date()) / (1000 * 60 * 60);
      const withinWindow = hoursUntilClass > 24;

      // Figure out what kind of refund applies:
      //   - 'cash'   : paid drop-in inside window → refund $25 e-Transfer
      //   - 'credit' : paid 4-pack or credit booking inside window → +1 credit
      //   - 'none'   : outside window, or unpaid pending booking (nothing to reverse)
      let refundType = 'none';
      let creditBalance = null;
      if (withinWindow) {
        if (reg.package_type === 'single' && reg.payment_status === 'paid') {
          refundType = 'cash';
        } else if (reg.package_type === 'credit' ||
                  (reg.package_type === '4pack' && reg.payment_status === 'paid')) {
          refundType = 'credit';
          // Return the credit to the user's balance
          if (reg.user_id) {
            await pool.query(`
              INSERT INTO user_credits (user_id, balance, updated_at) VALUES ($1, 1, NOW())
              ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + 1, updated_at = NOW()
            `, [reg.user_id]);
            const { rows: cr } = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [reg.user_id]);
            creditBalance = cr.length ? cr[0].balance : null;
          }
        }
      }

      await archiveRegistration(req.params.id, 'user');
      await pool.query('DELETE FROM registrations WHERE id = $1', [req.params.id]);
      res.json({
        success: true,
        refundType,
        creditBalance,
        // Back-compat for any older clients still reading this flag
        refundEligible: withinWindow
      });
      // Send cancellation confirmation email — fire-and-forget after response
      sendSelfCancellationEmail({
        to: reg.email,
        firstName: reg.firstName,
        cls: { title: reg.title, date: reg.date, time: reg.time, instructor: reg.instructor },
        refundType
      }).catch(e => console.error('Cancellation email error:', e.message));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: list all admin users
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.is_admin, u.created_at,
               w.id AS waiver_id, w.signed_at AS waiver_signed_at,
               COALESCE(uc.balance, 0) AS credit_balance,
               COALESCE(w.phone, rp.phone, '') AS phone
        FROM users u
        LEFT JOIN waivers w ON w.user_id = u.id OR LOWER(w.email) = LOWER(u.email)
        LEFT JOIN user_credits uc ON uc.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT phone FROM registrations
          WHERE (user_id = u.id OR LOWER(email) = LOWER(u.email))
            AND phone IS NOT NULL AND phone != ''
          ORDER BY "registeredAt" DESC LIMIT 1
        ) rp ON true
        ORDER BY u.is_admin DESC, u.created_at ASC
      `);
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: grant admin permission by email
  app.post('/api/admin/users/grant', requireAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
      const { rows } = await pool.query(
        `UPDATE users SET is_admin = TRUE WHERE LOWER(email) = LOWER($1) RETURNING id, email, first_name, last_name`,
        [email]
      );
      if (!rows.length) return res.status(404).json({ error: 'No account found with that email. They must sign up first.' });
      res.json({ success: true, user: rows[0] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: revoke admin permission
  app.delete('/api/admin/users/:id/admin', requireAdmin, async (req, res) => {
    try {
      await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: delete a user account and their registrations
  app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
      // Prevent deleting yourself
      if (req.user && String(req.user.id) === String(userId)) {
        return res.status(400).json({ error: 'You cannot delete your own account.' });
      }

      // Look up the user's email so we can also purge records that were
      // linked only by email (guest bookings made before the account existed,
      // legacy rows with null user_id, waivers signed before login, etc.)
      const { rows: userRows } = await pool.query(
        'SELECT email FROM users WHERE id = $1',
        [userId]
      );
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found.' });
      const email = userRows[0].email;

      // Purge every artifact tied to this user_id OR email. We do NOT archive
      // to cancelled_registrations this time — the admin is explicitly
      // wiping the user, so any historical rows they'd leave behind are
      // considered 'remnants' and should go too.
      const deleted = {};
      const del = async (label, q, params) => {
        const { rowCount } = await pool.query(q, params);
        deleted[label] = rowCount;
      };

      await del('registrations',
        'DELETE FROM registrations WHERE user_id = $1 OR LOWER(email) = LOWER($2)',
        [userId, email]);
      await del('cancelled_registrations',
        'DELETE FROM cancelled_registrations WHERE user_id = $1 OR LOWER(email) = LOWER($2)',
        [userId, email]);
      await del('waivers',
        'DELETE FROM waivers WHERE user_id = $1 OR LOWER(email) = LOWER($2)',
        [userId, email]);
      // Revoke any still-valid password-reset tokens (FK normally cascades
      // once we delete the user; this is belt-and-braces for race conditions)
      await del('password_resets',
        'DELETE FROM password_resets WHERE user_id = $1',
        [userId]);
      // Kill any active login sessions for this user so they're signed out
      // on their other devices immediately. connect-pg-simple stores the
      // user id inside sess->passport->user as JSON, so we match on that.
      await del('user_sessions',
        `DELETE FROM user_sessions WHERE sess::jsonb -> 'passport' ->> 'user' = $1`,
        [String(userId)]);

      // Finally the user row itself (user_credits cascades via FK)
      await del('users', 'DELETE FROM users WHERE id = $1', [userId]);

      console.log(`[delete-user] purged user id=${userId} email-hash=${hashForLog(email)}:`, deleted);
      res.json({ success: true, purged: deleted });
    } catch (e) { console.error('delete-user error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: scan for orphaned by-email artifacts across all tables. Returns
  // counts + a list of affected emails so the admin can see what leaked
  // before the purge logic was added.
  app.get('/api/admin/orphans/scan', requireAdmin, async (req, res) => {
    try {
      const [r1, r2, r3] = await Promise.all([
        pool.query(`SELECT LOWER(email) AS email, COUNT(*)::int AS n FROM registrations WHERE user_id IS NULL GROUP BY 1 ORDER BY n DESC`),
        pool.query(`SELECT LOWER(email) AS email, COUNT(*)::int AS n FROM cancelled_registrations WHERE user_id IS NULL GROUP BY 1 ORDER BY n DESC`),
        pool.query(`SELECT LOWER(email) AS email, COUNT(*)::int AS n FROM waivers WHERE user_id IS NULL GROUP BY 1 ORDER BY n DESC`)
      ]);
      // Merge by email
      const byEmail = new Map();
      const add = (rows, key) => rows.forEach(r => {
        if (!byEmail.has(r.email)) byEmail.set(r.email, { email: r.email, registrations: 0, cancelled_registrations: 0, waivers: 0 });
        byEmail.get(r.email)[key] = r.n;
      });
      add(r1.rows, 'registrations');
      add(r2.rows, 'cancelled_registrations');
      add(r3.rows, 'waivers');
      const list = [...byEmail.values()].sort((a, b) =>
        (b.registrations + b.cancelled_registrations + b.waivers) -
        (a.registrations + a.cancelled_registrations + a.waivers)
      );
      res.json({ orphansByEmail: list, totalEmails: list.length });
    } catch (e) { console.error('orphan scan error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: wipe orphan rows for a specific email (or all orphans if no email)
  app.post('/api/admin/orphans/purge', requireAdmin, async (req, res) => {
    const { email } = req.body || {};
    try {
      if (email) {
        const result = await purgeOrphansByEmail(email);
        return res.json({ success: true, email: email.toLowerCase(), purged: result });
      }
      // No email = purge ALL orphans
      const [r1, r2, r3] = await Promise.all([
        pool.query('DELETE FROM registrations WHERE user_id IS NULL'),
        pool.query('DELETE FROM cancelled_registrations WHERE user_id IS NULL'),
        pool.query('DELETE FROM waivers WHERE user_id IS NULL')
      ]);
      res.json({
        success: true,
        purged: {
          registrations: r1.rowCount,
          cancelled_registrations: r2.rowCount,
          waivers: r3.rowCount
        }
      });
    } catch (e) { console.error('orphan purge error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: full booking history for a user (upcoming, past, cancelled, bundle summary)
  app.get('/api/admin/users/:userId/bookings', requireAdmin, async (req, res) => {
    const userId = req.params.userId;
    try {
      // Fetch the user so we can also look up records that were only ever linked by email
      const { rows: userRows } = await pool.query(
        'SELECT id, email, first_name, last_name FROM users WHERE id = $1', [userId]
      );
      if (!userRows.length) return res.status(404).json({ error: 'User not found' });
      const user = userRows[0];

      // Active registrations (upcoming and past) — match by user_id OR email for legacy rows
      const { rows: active } = await pool.query(`
        SELECT r.id, r."classId", r."registeredAt", r.payment_status, r.package_type,
               c.title, c.date, c.time, c.duration, c.instructor
        FROM registrations r
        LEFT JOIN classes c ON c.id = r."classId"
        WHERE r.user_id = $1 OR LOWER(r.email) = LOWER($2)
        ORDER BY c.date DESC NULLS LAST, c.time DESC NULLS LAST
      `, [userId, user.email]);

      // Cancelled archive
      const { rows: cancelled } = await pool.query(`
        SELECT id, "classId", "registeredAt", payment_status, package_type,
               class_title AS title, class_date AS date, class_time AS time,
               class_instructor AS instructor, cancelled_at, cancelled_by
        FROM cancelled_registrations
        WHERE user_id = $1 OR LOWER(email) = LOWER($2)
        ORDER BY cancelled_at DESC
      `, [userId, user.email]);

      // Split active into upcoming vs. past using today's date
      const today = new Date().toISOString().slice(0, 10);
      const nowTime = new Date();
      const upcoming = [];
      const past = [];
      for (const r of active) {
        if (!r.date) { upcoming.push(r); continue; }
        const classStart = new Date(`${r.date}T${r.time || '00:00'}`);
        if (classStart >= nowTime) upcoming.push(r); else past.push(r);
      }

      // Bundle summary — count historical 4-pack purchases across active + cancelled
      const bundleCount =
        active.filter(r => r.package_type === '4pack').length +
        cancelled.filter(r => r.package_type === '4pack').length;

      // Current credit balance
      const { rows: cr } = await pool.query(
        'SELECT balance FROM user_credits WHERE user_id = $1', [userId]
      );
      const creditBalance = cr.length ? cr[0].balance : 0;

      res.json({
        user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name },
        creditBalance,
        bundleCount,
        totals: {
          upcoming: upcoming.length,
          past: past.length,
          cancelled: cancelled.length
        },
        upcoming, past, cancelled
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: business analytics — bookings over time, revenue, cancellation,
  // popular classes. All computed from Postgres on demand.
  app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
      // Bookings per month (last 12 months) — split by package type
      const { rows: bookings } = await pool.query(`
        SELECT to_char(date_trunc('month', c.date::date), 'YYYY-MM') AS month,
               COUNT(*)::int                                           AS total,
               COUNT(*) FILTER (WHERE r.package_type = '4pack')::int   AS pack4,
               COUNT(*) FILTER (WHERE r.package_type = 'single')::int  AS single,
               COUNT(*) FILTER (WHERE r.package_type = 'credit')::int  AS credit
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE c.date::date >= (CURRENT_DATE - INTERVAL '12 months')
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      // Revenue per month. Single = $25 paid, 4pack = $85 paid (once),
      // credit = $0 (already paid via bundle). Separate paid vs pending.
      const { rows: revenue } = await pool.query(`
        SELECT to_char(date_trunc('month', c.date::date), 'YYYY-MM') AS month,
               COALESCE(SUM(
                 CASE WHEN r.payment_status = 'paid' THEN
                   CASE r.package_type
                     WHEN '4pack' THEN 85
                     WHEN 'single' THEN 25
                     ELSE 0 END
                 ELSE 0 END
               ), 0)::int AS collected,
               COALESCE(SUM(
                 CASE WHEN r.payment_status != 'paid' THEN
                   CASE r.package_type
                     WHEN '4pack' THEN 85
                     WHEN 'single' THEN 25
                     ELSE 0 END
                 ELSE 0 END
               ), 0)::int AS outstanding
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE c.date::date >= (CURRENT_DATE - INTERVAL '12 months')
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      // Cancellation stats — compare active + cancelled over the same 12-month window
      const { rows: activeTot } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE c.date::date >= (CURRENT_DATE - INTERVAL '12 months')
      `);
      const { rows: cancelTot } = await pool.query(`
        SELECT COUNT(*)::int AS n FROM cancelled_registrations
        WHERE cancelled_at >= (NOW() - INTERVAL '12 months')
      `);
      // Within/outside 24-hour bucket — use cancelled_at vs. class_date+class_time
      const { rows: cancelBuckets } = await pool.query(`
        SELECT
          SUM(CASE
                WHEN (class_date || 'T' || class_time)::timestamp - cancelled_at <= INTERVAL '24 hours'
                THEN 1 ELSE 0 END)::int AS within_24h,
          SUM(CASE
                WHEN (class_date || 'T' || class_time)::timestamp - cancelled_at >  INTERVAL '24 hours'
                THEN 1 ELSE 0 END)::int AS outside_24h
        FROM cancelled_registrations
        WHERE cancelled_at >= (NOW() - INTERVAL '12 months')
          AND class_date IS NOT NULL AND class_time IS NOT NULL
      `);
      const totalBookings = (activeTot[0]?.n || 0) + (cancelTot[0]?.n || 0);
      const cancelled    = cancelTot[0]?.n || 0;
      const cancelRate   = totalBookings > 0 ? Math.round((cancelled / totalBookings) * 1000) / 10 : 0;

      // Most popular classes — by title, aggregated across all time
      const { rows: popularByTitle } = await pool.query(`
        SELECT c.title AS label, COUNT(*)::int AS count
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 10
      `);

      // Most popular time slots (hour of day)
      const { rows: popularByTime } = await pool.query(`
        SELECT substring(c.time, 1, 5) AS label, COUNT(*)::int AS count
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 10
      `);

      // New user signups per month (last 12 months)
      const { rows: signups } = await pool.query(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
               COUNT(*)::int AS count
        FROM users
        WHERE created_at >= (NOW() - INTERVAL '12 months')
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      res.json({
        bookingsOverTime: bookings,
        revenueOverTime: revenue,
        cancellation: {
          totalBookings,
          cancelled,
          ratePercent: cancelRate,
          within24h: cancelBuckets[0]?.within_24h || 0,
          outside24h: cancelBuckets[0]?.outside_24h || 0
        },
        popularByTitle,
        popularByTime,
        signupsOverTime: signups
      });
    } catch (e) { console.error('Analytics error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: Clarity-pulled visitor insights. Cached 8h per bucket to stay under
  // Clarity's 10-calls-per-day limit. Pass ?refresh=1 to force fresh fetch.
  app.get('/api/admin/clarity-insights', requireAdmin, async (req, res) => {
    try {
      const token = await getSetting('clarity_api_token');
      if (!token) {
        return res.status(400).json({
          error: 'Clarity API token not configured. Add it in Admin → Settings → Microsoft Clarity.'
        });
      }
      const force = req.query.refresh === '1';
      const results = {};
      const errors  = [];
      let oldestFetch = null;

      for (const key of Object.keys(CLARITY_BUCKETS)) {
        try {
          const { data, fetchedAt, staleError } = await fetchClarityBucket(key, token, { force });
          results[key] = data;
          if (staleError) errors.push(`${key}: ${staleError} (showing cached)`);
          if (!oldestFetch || new Date(fetchedAt) < new Date(oldestFetch)) oldestFetch = fetchedAt;
        } catch (e) {
          errors.push(`${key}: ${e.message}`);
          results[key] = null;
        }
      }

      const normalized = normalizeClarityData({
        overview:  results.overview,
        geoDevice: results.geoDevice,
        pagesRefs: results.pagesRefs
      });

      res.json({
        insights: normalized,
        fetchedAt: oldestFetch,
        errors: errors.length ? errors : null,
        raw: results  // keep raw available for debugging
      });
    } catch (e) {
      console.error('Clarity insights error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
    }
  });

  // Admin: mark a registration as paid
  app.post('/api/admin/registrations/:id/mark-paid', requireAdmin, async (req, res) => {
    try {
      // Step 1 — look up the registration to check if it's part of a batch.
      // If it is, flipping this one also flips all sibling drop-ins in the
      // same batch (one payment, many classes). Idempotent: rows already
      // paid stay paid; the batch-transition is a no-op for them.
      const { rows: peek } = await pool.query(
        `SELECT id, payment_status, batch_id, package_type, email FROM registrations WHERE id = $1`,
        [req.params.id]
      );
      if (!peek.length) return res.status(404).json({ error: 'Registration not found' });
      if (peek[0].payment_status === 'paid') {
        return res.status(200).json({ success: true, alreadyPaid: true });
      }

      // Step 2 — flip this row + any pending siblings (only for single/batched bookings)
      const batchId = peek[0].batch_id;
      const isBatched = !!batchId && peek[0].package_type === 'single';

      const whereClause = isBatched
        ? `batch_id = $1 AND payment_status != 'paid'`
        : `id = $1 AND payment_status != 'paid'`;
      const { rows: updated } = await pool.query(
        `UPDATE registrations SET payment_status = 'paid'
         WHERE ${whereClause}
         RETURNING id, "firstName", "lastName", email, "classId", package_type, user_id`,
        [isBatched ? batchId : req.params.id]
      );

      if (!updated.length) {
        return res.status(200).json({ success: true, alreadyPaid: true });
      }

      const reg = updated[0];

      // Fetch class details. For a batch we pick the first class for the email
      // title but the email itself can list all classes.
      const { rows: clsRows } = await pool.query(
        `SELECT title, date, time, instructor, duration FROM classes WHERE id = $1`,
        [reg.classId]
      );
      const cls = clsRows[0] || { title: '(class removed)', date: '', time: '', instructor: '', duration: 0 };

      // 4-pack: add 3 credits (1 used for this class, 3 carry forward).
      // Never happens on the batched path because we guard package_type='single'.
      if (reg.package_type === '4pack') {
        const userId = reg.user_id;
        let creditsRemaining = 3;
        if (userId) {
          await pool.query(`
            INSERT INTO user_credits (user_id, balance, updated_at) VALUES ($1, 3, NOW())
            ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + 3, updated_at = NOW()
          `, [userId]);
          const { rows: cr } = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [userId]);
          creditsRemaining = cr.length ? cr[0].balance : 3;
        }
        res.json({ success: true, packageType: '4pack', creditsAdded: 3, creditsRemaining, classesPaid: 1 });
        sendPackageConfirmedEmail({ to: reg.email, firstName: reg.firstName, cls, creditsRemaining })
          .catch(e => console.error('Package confirmed email error:', e.message));
      } else {
        res.json({
          success: true,
          packageType: reg.package_type || 'single',
          classesPaid: updated.length,
          batchId: isBatched ? batchId : null
        });
        // Fetch class details for all paid rows so the confirmation email can
        // list every class the payment covered (when it was a batch)
        if (isBatched && updated.length > 1) {
          const { rows: allClasses } = await pool.query(`
            SELECT c.title, c.date, c.time, c.instructor, c.duration
            FROM registrations r JOIN classes c ON c.id = r."classId"
            WHERE r.batch_id = $1
            ORDER BY c.date ASC, c.time ASC
          `, [batchId]);
          sendPaymentConfirmedEmail({ to: reg.email, firstName: reg.firstName, cls, classes: allClasses })
            .catch(e => console.error('Payment confirmed email error:', e.message));
        } else {
          sendPaymentConfirmedEmail({ to: reg.email, firstName: reg.firstName, cls })
            .catch(e => console.error('Payment confirmed email error:', e.message));
        }
      }
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: manually adjust a user's credit balance
  app.post('/api/admin/users/:userId/credits', requireAdmin, async (req, res) => {
    const { adjustment } = req.body;
    if (adjustment === undefined || isNaN(adjustment)) return res.status(400).json({ error: 'Adjustment value required' });
    try {
      await pool.query(`
        INSERT INTO user_credits (user_id, balance, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET balance = GREATEST(0, user_credits.balance + $2), updated_at = NOW()
      `, [req.params.userId, parseInt(adjustment)]);
      const { rows } = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [req.params.userId]);
      res.json({ success: true, balance: rows.length ? rows[0].balance : 0 });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: remove a user from a class + send notification email
  app.delete('/api/admin/registrations/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.*, c.title, c.date, c.time, c.instructor
        FROM registrations r JOIN classes c ON c.id = r."classId"
        WHERE r.id = $1
      `, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Registration not found' });
      const reg = rows[0];
      await archiveRegistration(req.params.id, 'admin');
      await pool.query('DELETE FROM registrations WHERE id = $1', [req.params.id]);
      res.json({ success: true });
      sendRemovalEmail({
        to: reg.email, firstName: reg.firstName,
        cls: { title: reg.title, date: reg.date, time: reg.time, instructor: reg.instructor }
      }).catch(e => console.error('Removal email error:', e.message));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Cancel registration via email link
  app.get('/api/registrations/:id/cancel', async (req, res) => {
    const { id } = req.params;
    const { token } = req.query;
    if (!token || token !== cancelToken(id))
      return res.status(400).send('<h2>Invalid or expired cancellation link.</h2>');
    try {
      const { rows } = await pool.query(`
        SELECT r.*, c.date, c.time, c.title, c.instructor
        FROM registrations r JOIN classes c ON c.id = r."classId"
        WHERE r.id = $1
      `, [id]);
      if (rows.length === 0) return res.send('<h2>This booking has already been cancelled.</h2>');
      const reg = rows[0];
      const classStart = new Date(`${reg.date}T${reg.time}`);
      const hoursUntilClass = (classStart - new Date()) / (1000 * 60 * 60);
      const withinWindow = hoursUntilClass > 24;

      // Determine refund type (same rules as /api/my-registrations/:id)
      let refundType = 'none';
      if (withinWindow) {
        if (reg.package_type === 'single' && reg.payment_status === 'paid') {
          refundType = 'cash';
        } else if (reg.package_type === 'credit' ||
                  (reg.package_type === '4pack' && reg.payment_status === 'paid')) {
          refundType = 'credit';
          if (reg.user_id) {
            await pool.query(`
              INSERT INTO user_credits (user_id, balance, updated_at) VALUES ($1, 1, NOW())
              ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + 1, updated_at = NOW()
            `, [reg.user_id]);
          }
        }
      }

      await archiveRegistration(id, 'email-link');
      await pool.query('DELETE FROM registrations WHERE id = $1', [id]);

      // Also send a follow-up confirmation email (in addition to the HTML
      // response the user sees after clicking the cancel link in email)
      sendSelfCancellationEmail({
        to: reg.email,
        firstName: reg.firstName,
        cls: { title: reg.title, date: reg.date, time: reg.time, instructor: reg.instructor },
        refundType
      }).catch(e => console.error('Cancellation email error:', e.message));

      const policyLink = `<a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a>`;
      const refundNote =
        refundType === 'cash'   ? 'As you cancelled more than 24 hours before the class, your $25 payment will be refunded within 2–3 business days.'
      : refundType === 'credit' ? 'As you cancelled more than 24 hours before the class, 1 class credit has been returned to your account and is ready to use on any future class.'
      :                           `Cancellations within 24 hours of class start are not eligible for a refund or credit return per our ${policyLink}.`;

      res.send(emailWrap({
        heading: 'Booking Cancelled',
        subtitle: `Your booking for ${reg.title} has been successfully cancelled.`,
        detailRows: [
          ['Class', reg.title],
          ['Date', formatClassDate(reg.date)],
          ['Time', formatClassTime(reg.time)],
        ],
        body: `<p style="font-size:14px;color:#6b6b6b">${refundNote}</p>`,
        buttonLabel: 'Back to Red Maple Movement',
        buttonUrl: APP_URL
      }));
    } catch (e) { console.error(e); res.status(500).send('<h2>Something went wrong. Please try again.</h2>'); }
  });

  // Cron endpoint — runs hourly. Sends a '23 hour' reminder to anyone
  // booked for a class starting in the next 22-24 hours who hasn't already
  // had a reminder. The window is 22-24h (not exactly 23) so a slow cron
  // tick never misses a class, and reminder_sent_at guards against doubles.
  app.get('/api/cron/reminders', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const { rows } = await pool.query(`
        SELECT r.id, r."firstName", r.email, c.title, c.date, c.time, c.instructor, c.duration
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE r.reminder_sent_at IS NULL
          AND (c.date || 'T' || c.time)::timestamp - NOW() BETWEEN INTERVAL '22 hours' AND INTERVAL '24 hours'
      `);
      let sent = 0;
      const ids = [];
      for (const row of rows) {
        try {
          await sendReminderEmail({
            to: row.email, firstName: row.firstName, registrationId: row.id,
            cls: { title: row.title, date: row.date, time: row.time, instructor: row.instructor, duration: row.duration }
          });
          ids.push(row.id);
          sent++;
        } catch (e) {
          console.error(`Reminder failed for registration id=${row.id} (email-hash=${hashForLog(row.email)}):`, e.message);
        }
      }
      if (ids.length) {
        // Stamp reminder_sent_at only for successfully-sent rows so a
        // transient email error retries next hour instead of being lost
        await pool.query(
          `UPDATE registrations SET reminder_sent_at = NOW() WHERE id = ANY($1)`,
          [ids]
        );
      }
      res.json({ success: true, remindersSent: sent, candidates: rows.length });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Cron endpoint — runs every 30 min; alerts admin about unpaid registrations after 1 hour
  app.get('/api/cron/release-unpaid', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      // Find pending registrations older than 1 hour that haven't been flagged to admin yet
      const { rows: unpaid } = await pool.query(`
        SELECT r.id, r."firstName", r."lastName", r.email, r.phone, r."classId", r."registeredAt",
               c.title, c.date, c.time, c.instructor, c.duration
        FROM registrations r
        LEFT JOIN classes c ON c.id = r."classId"
        WHERE r.payment_status = 'pending'
          AND r.payment_alert_sent = FALSE
          AND r."registeredAt"::timestamptz < NOW() - INTERVAL '1 hour'
      `);

      if (unpaid.length === 0) return res.json({ success: true, alerted: 0 });

      // Mark all as alerted so we don't re-send
      const ids = unpaid.map(r => r.id);
      await pool.query(
        `UPDATE registrations SET payment_alert_sent = TRUE WHERE id = ANY($1)`,
        [ids]
      );

      // Send admin digest email
      const notifyEmail = await getSetting('booking_notify_email');
      const unpaidList = unpaid.map(row => ({
        reg: { id: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone, registeredAt: row.registeredAt },
        cls: row.title ? { title: row.title, date: row.date, time: row.time, instructor: row.instructor, duration: row.duration } : null
      }));
      await sendAdminPaymentAlertEmail({ notifyEmail, unpaidList })
        .catch(e => console.error('Admin payment alert error:', e.message));

      res.json({ success: true, alerted: unpaid.length });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin payment action — confirm payment received
  app.get('/api/admin/payment-action/:id/confirm', async (req, res) => {
    const { id } = req.params;
    const { token } = req.query;
    if (token !== paymentActionToken(id, 'confirm')) {
      return res.status(403).send(actionPage('Invalid or expired link.', false));
    }
    try {
      const { rows } = await pool.query(
        `UPDATE registrations SET payment_status = 'paid'
         WHERE id = $1 AND payment_status != 'paid'
         RETURNING "firstName", "lastName", email, "classId"`,
        [id]
      );
      if (rows.length === 0) return res.send(actionPage('This booking has already been processed.', true));
      const reg = rows[0];
      const { rows: clsRows } = await pool.query('SELECT * FROM classes WHERE id = $1', [reg.classId]);
      const cls = clsRows[0];
      sendPaymentConfirmedEmail({ to: reg.email, firstName: reg.firstName, cls })
        .catch(e => console.error('Payment confirmed email error:', e.message));
      res.send(actionPage(`✅ Payment confirmed for ${reg.firstName} ${reg.lastName}. A confirmation email has been sent to ${reg.email}.`, true));
    } catch (e) { console.error(e); res.status(500).send(actionPage('Server error. Please try again.', false)); }
  });

  // Admin payment action — no payment received, remove from class
  app.get('/api/admin/payment-action/:id/release', async (req, res) => {
    const { id } = req.params;
    const { token } = req.query;
    if (token !== paymentActionToken(id, 'release')) {
      return res.status(403).send(actionPage('Invalid or expired link.', false));
    }
    try {
      // Archive first (only archives if the row still exists and is pending)
      await archiveRegistration(id, 'unpaid-release');
      const { rows } = await pool.query(
        `DELETE FROM registrations WHERE id = $1 AND payment_status = 'pending'
         RETURNING "firstName", "lastName", email, "classId"`,
        [id]
      );
      if (rows.length === 0) return res.send(actionPage('This booking has already been processed or was already paid.', true));
      const reg = rows[0];
      const { rows: clsRows } = await pool.query('SELECT * FROM classes WHERE id = $1', [reg.classId]);
      const cls = clsRows[0];
      if (cls) {
        sendPaymentReleasedEmail({ to: reg.email, firstName: reg.firstName, cls })
          .catch(e => console.error('Payment released email error:', e.message));
      }
      res.send(actionPage(`❌ Booking removed for ${reg.firstName} ${reg.lastName}. A notification email has been sent to ${reg.email}.`, true));
    } catch (e) { console.error(e); res.status(500).send(actionPage('Server error. Please try again.', false)); }
  });

  function actionPage(message, success) {
    const color = success ? '#2d6a2d' : '#820000';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Red Maple Movement — Admin Action</title>
      <style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
      .card{background:#fff;border-radius:8px;padding:40px;max-width:480px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1)}
      h2{color:${color};margin-top:0}p{color:#555;line-height:1.6}
      a{display:inline-block;margin-top:20px;background:#820000;color:#fff;padding:10px 24px;border-radius:4px;text-decoration:none;font-weight:bold}</style>
    </head><body><div class="card">
      <h2>Red Maple Movement</h2>
      <p>${message}</p>
      <a href="/admin.html">Go to Admin Dashboard</a>
    </div></body></html>`;
  }

  // Waiver routes
  app.post('/api/waiver', async (req, res) => {
    const { firstName, lastName, email, phone, emergencyName, emergencyPhone, signatureData } = req.body;
    // Accept either 'health' (current client) or 'healthConditions' (legacy)
    const healthConditions = req.body.health || req.body.healthConditions || '';
    const pilatesExperience = req.body.pilatesExperience || '';
    if (!firstName || !lastName || !email || !signatureData)
      return res.status(400).json({ error: 'Missing required fields.' });
    if (!pilatesExperience)
      return res.status(400).json({ error: 'Please select your Pilates experience level.' });
    const userId = req.isAuthenticated() ? req.user.id : null;
    try {
      // Check for existing waiver by email
      const { rows: existing } = await pool.query(
        'SELECT id, signed_at FROM waivers WHERE LOWER(email) = LOWER($1)', [email]
      );
      if (existing.length > 0) {
        // Update existing waiver
        await pool.query(`
          UPDATE waivers SET first_name=$1, last_name=$2, phone=$3, emergency_name=$4,
            emergency_phone=$5, health_conditions=$6, signature_data=$7, signed_at=NOW(),
            user_id=COALESCE($8, user_id), pilates_experience=$10
          WHERE LOWER(email) = LOWER($9)`,
          [firstName, lastName, phone||'', emergencyName||'', emergencyPhone||'', healthConditions, signatureData, userId, email, pilatesExperience]
        );
        const { rows } = await pool.query('SELECT * FROM waivers WHERE LOWER(email) = LOWER($1)', [email]);
        res.json({ success: true, waiver: rows[0] });
        sendWaiverConfirmationEmail({ to: email, firstName, waiverId: rows[0].id, signedAt: rows[0].signed_at })
          .catch(e => console.error('Waiver email error:', e.message));
        return;
      }
      const id = Date.now().toString();
      await pool.query(`
        INSERT INTO waivers (id, user_id, first_name, last_name, email, phone, emergency_name, emergency_phone, health_conditions, signature_data, pilates_experience)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, userId, firstName, lastName, email.toLowerCase(), phone||'', emergencyName||'', emergencyPhone||'', healthConditions, signatureData, pilatesExperience]
      );
      const { rows } = await pool.query('SELECT * FROM waivers WHERE id = $1', [id]);
      res.status(201).json({ success: true, waiver: rows[0] });
      sendWaiverConfirmationEmail({ to: email, firstName, waiverId: id, signedAt: rows[0].signed_at })
        .catch(e => console.error('Waiver email error:', e.message));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Check whether a given email (or logged-in user) has a signed waiver
  app.get('/api/waiver/check', async (req, res) => {
    const email = req.query.email || (req.isAuthenticated() ? req.user.email : null);
    if (!email) return res.json({ signed: false });
    try {
      const userId = req.isAuthenticated() ? req.user.id : null;
      const { rows } = userId
        ? await pool.query(
            'SELECT id FROM waivers WHERE LOWER(email) = LOWER($1) OR user_id = $2 ORDER BY signed_at DESC LIMIT 1',
            [email, userId])
        : await pool.query(
            'SELECT id FROM waivers WHERE LOWER(email) = LOWER($1) ORDER BY signed_at DESC LIMIT 1',
            [email]);
      res.json({ signed: rows.length > 0 });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Human-readable label for the Pilates experience radio value
  function pilatesExperienceLabel(v) {
    switch (v) {
      case 'first_class': return 'This will be my first Pilates class';
      case 'under_5':     return 'Fewer than 5 classes';
      case 'over_5':      return 'More than 5 classes';
      default:            return '—';
    }
  }

  app.get('/api/waiver/my', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not signed in.' });
    try {
      const { rows } = await pool.query(
        'SELECT id, first_name, last_name, email, phone, emergency_name, emergency_phone, health_conditions, pilates_experience, signature_data, signed_at FROM waivers WHERE user_id = $1 OR LOWER(email) = LOWER($2) ORDER BY signed_at DESC LIMIT 1',
        [req.user.id, req.user.email]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'No waiver found.' });
      const w = rows[0];
      const viewUrl = `/api/waiver/view/${w.id}?token=${waiverViewToken(w.id)}`;
      res.json({ waiver: { ...w, viewUrl } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // --- Waiver HTML renderer (shared) ---
  // All waiver fields come from user input (signup + waiver form). We
  // HTML-escape every interpolated value, validate the signature data URL
  // against an allowlist (see safeSignatureSrc), and keep the Print button
  // handler out-of-line to satisfy CSP (no 'unsafe-inline' scriptSrc).
  function renderWaiverHtml(w, { titleSuffix } = {}) {
    const signedDate = new Date(w.signed_at).toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const fullName = `${escapeHtml(w.first_name || '')} ${escapeHtml(w.last_name || '')}`.trim();
    const safeSig = safeSignatureSrc(w.signature_data);
    const title = titleSuffix ? `Waiver — ${fullName || 'Red Maple Movement'}` : 'Signed Waiver — Red Maple Movement';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${escapeHtml(title)}</title>
        <style>
          body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 1.5rem;color:#333}
          h1{color:#8B1A1A} .field{margin:8px 0;padding:10px 14px;background:#f9f9f9;border-radius:6px;border-left:3px solid #8B1A1A}
          .label{font-size:0.78rem;color:#888;text-transform:uppercase;letter-spacing:.05em} .value{font-weight:600;margin-top:2px;white-space:pre-wrap}
          .sig img{max-width:100%;border:1px solid #ddd;border-radius:4px;margin-top:8px}
          .badge{display:inline-block;background:#2e7d32;color:#fff;padding:4px 12px;border-radius:20px;font-size:0.85rem;margin-bottom:1.5rem}
          #printBtn{background:#8B1A1A;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:1rem}
          @media print{#printBtn{display:none}}
        </style>
      </head><body>
        <h1>Red Maple Movement — Signed Waiver</h1>
        <div class="badge">✓ Signed on ${escapeHtml(signedDate)}</div>
        <div class="field"><div class="label">Full Name</div><div class="value">${fullName || '—'}</div></div>
        <div class="field"><div class="label">Email</div><div class="value">${escapeHtml(w.email || '—')}</div></div>
        <div class="field"><div class="label">Phone</div><div class="value">${escapeHtml(w.phone || '—')}</div></div>
        <div class="field"><div class="label">Emergency Contact</div><div class="value">${escapeHtml(w.emergency_name || '—')}${w.emergency_phone ? ' · ' + escapeHtml(w.emergency_phone) : ''}</div></div>
        <div class="field"><div class="label">Pilates Experience</div><div class="value">${escapeHtml(pilatesExperienceLabel(w.pilates_experience) || '—')}</div></div>
        <div class="field"><div class="label">Health Conditions</div><div class="value">${escapeHtml(w.health_conditions || 'None stated')}</div></div>
        ${safeSig ? `<div class="field sig"><div class="label">Signature</div><img src="${safeSig}" alt="Signature"></div>` : ''}
        <p style="margin-top:2rem"><button id="printBtn" type="button">Print / Save PDF</button></p>
        <script src="/js/waiver-view.js"></script>
      </body></html>`;
  }

  // Secure waiver view page (linked from confirmation email)
  app.get('/api/waiver/view/:id', async (req, res) => {
    const { token } = req.query;
    if (!token || token !== waiverViewToken(req.params.id))
      return res.status(400).send('<h2>Invalid or expired waiver link.</h2>');
    try {
      const { rows } = await pool.query('SELECT * FROM waivers WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).send('<h2>Waiver not found.</h2>');
      res.send(renderWaiverHtml(rows[0]));
    } catch (e) { console.error(e); res.status(500).send('<h2>Something went wrong.</h2>'); }
  });

  // Admin: view a specific waiver (session-protected)
  app.get('/api/admin/waiver/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM waivers WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).send('<h2>Waiver not found.</h2>');
      res.send(renderWaiverHtml(rows[0], { titleSuffix: true }));
    } catch (e) { console.error(e); res.status(500).send('<h2>Something went wrong.</h2>'); }
  });

  // Admin-only test email endpoint
  app.get('/api/admin/test-email', requireAdmin, async (req, res) => {
    const { to } = req.query;
    if (!to) return res.status(400).json({ error: 'Missing ?to= address' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY env var not set' });
    try {
      const { data, error } = await getResend().emails.send({
        from: FROM_ADDRESS,
        to,
        subject: 'Red Maple Movement — Email Test',
        html: '<p>This is a test email from Red Maple Movement. If you received this, email sending is working correctly!</p>'
      });
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true, message: `Test email sent to ${to}`, id: data.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/waivers', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, first_name, last_name, email, phone, emergency_name, emergency_phone, health_conditions, signed_at FROM waivers ORDER BY signed_at DESC'
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: get settings
  app.get('/api/admin/settings', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT key, value FROM settings');
      const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
      res.json(settings);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: update a setting
  app.post('/api/admin/settings', requireAdmin, async (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    try {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value || '']
      );
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Test email endpoint — sends a sample of any email type to a specified address
  app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
    const { emailType, testEmail } = req.body;
    if (!testEmail) return res.status(400).json({ error: 'Please enter a test email address.' });
    if (!process.env.RESEND_API_KEY) return res.status(400).json({ error: 'RESEND_API_KEY not configured — emails cannot be sent.' });

    const sampleCls = { id: 'test', title: 'Mat Pilates', instructor: 'Amanda Stevens', date: '2026-04-09', time: '11:00', duration: 50, capacity: 12 };
    const sampleRegId = 'test-' + Date.now();

    try {
      switch (emailType) {
        case 'booking_confirmed':
          await sendConfirmationEmail({ to: testEmail, firstName: 'Test', lastName: 'User', cls: sampleCls, registrationId: sampleRegId, packageType: 'single' });
          break;
        case 'booking_confirmed_4pack':
          await sendConfirmationEmail({ to: testEmail, firstName: 'Test', lastName: 'User', cls: sampleCls, registrationId: sampleRegId, packageType: '4pack' });
          break;
        case 'payment_confirmed':
          await sendPaymentConfirmedEmail({ to: testEmail, firstName: 'Test', cls: sampleCls });
          break;
        case 'booking_cancelled':
          await sendRemovalEmail({ to: testEmail, firstName: 'Test', cls: sampleCls });
          break;
        case 'class_reminder':
          await sendReminderEmail({ to: testEmail, firstName: 'Test', cls: sampleCls, registrationId: sampleRegId });
          break;
        case 'payment_released':
          await sendPaymentReleasedEmail({ to: testEmail, firstName: 'Test', cls: sampleCls });
          break;
        case 'waiver_signed':
          await sendWaiverConfirmationEmail({ to: testEmail, firstName: 'Test', waiverId: 'test-waiver', signedAt: new Date().toISOString() });
          break;
        case 'new_booking_admin':
          await sendNewBookingNotification({ notifyEmail: testEmail, registrant: { firstName: 'Test', lastName: 'User', email: 'test@example.com', phone: '555-0000' }, cls: sampleCls });
          break;
        case 'payment_alert_admin':
          await sendAdminPaymentAlertEmail({ notifyEmail: testEmail, unpaidList: [{ reg: { id: sampleRegId, firstName: 'Test', lastName: 'User', email: 'test@example.com', phone: '555-0000', registeredAt: new Date().toISOString() }, cls: sampleCls }] });
          break;
        default:
          return res.status(400).json({ error: 'Unknown email type.' });
      }
      res.json({ success: true });
    } catch (e) {
      console.error('Test email error:', e);
      res.status(500).json({ error: e.message || 'Failed to send test email.' });
    }
  });

  // 6. Return app — caller decides whether to listen or export
  return app;
}

// Traditional server mode (Railway / local dev)
async function main() {
  const app = await createApp();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Red Maple Movement running on port ${PORT}`);
  });
  process.on('SIGTERM', () => {
    server.close(() => { pool.end(); console.log('Server closed.'); });
  });
}

// Serverless mode (Vercel) — cache the app across warm invocations
let _appCache = null;
async function getApp() {
  if (!_appCache) _appCache = await createApp();
  return _appCache;
}

if (require.main === module) {
  // Direct execution — start HTTP server (Railway / local)
  main().catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
} else {
  // Imported as module — export serverless handler (Vercel)
  module.exports = async (req, res) => {
    const app = await getApp();
    app(req, res);
  };
}
