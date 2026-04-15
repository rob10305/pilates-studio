const express    = require('express');
const { Pool }   = require('pg');
const path       = require('path');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const passport   = require('passport');
const { Strategy: LocalStrategy }    = require('passport-local');
const { Strategy: GoogleStrategy }   = require('passport-google-oauth20');
const { Strategy: FacebookStrategy } = require('passport-facebook');
const bcrypt     = require('bcryptjs');
const { Resend } = require('resend');
const crypto     = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pilates2024';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// --- Email ---
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function cancelToken(registrationId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret')
    .update(registrationId).digest('hex');
}

function paymentActionToken(registrationId, action) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret')
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
      <div style="text-align:center;padding:24px 0 0">
        <p style="font-size:13px;color:#6b6b6b;margin:0 0 4px">Red Maple Movement</p>
        <a href="${APP_URL}" style="font-size:13px;color:#820000;text-decoration:none">redmaplemovement.ca</a>
      </div>
    </div>`;
}

async function sendConfirmationEmail({ to, firstName, lastName, cls, registrationId }) {
  if (!process.env.RESEND_API_KEY) return;
  const cancelUrl = `${APP_URL}/api/registrations/${registrationId}/cancel?token=${cancelToken(registrationId)}`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Booking Confirmed: ${cls.title} on ${formatClassDate(cls.date)}`,
    html: emailWrap({
      heading: 'Booking Confirmed',
      subtitle: `Your spot is reserved for the next hour. Please complete payment to confirm your spot in class.`,
      detailRows: [
        ['Name', `${firstName} ${lastName}`],
        ['Email', to],
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
        ['Instructor', cls.instructor],
      ],
      body: `
        <div style="background:#FAF7F2;border:1px solid #e8e3dd;border-radius:8px;padding:16px;margin-bottom:8px">
          <p style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#6b6b6b;margin:0 0 4px;font-weight:700">SECURE YOUR SPOT</p>
          <p style="font-family:Georgia,serif;font-size:22px;color:#820000;font-weight:700;margin:0 0 6px">$25 CAD</p>
          <p style="font-size:13px;color:#6b6b6b;margin:0 0 2px">Send via Interac e-Transfer to</p>
          <p style="font-size:15px;font-weight:700;color:#3a3a3a;margin:0">amanda@redmaplemovement.ca</p>
        </div>
        <p style="font-size:12px;color:#b0b0b0;margin:8px 0 0">Your spot is held for 1 hour pending payment. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>
        <p style="font-size:13px;color:#6b6b6b;margin:12px 0 0">Need to cancel? <a href="${cancelUrl}" style="color:#820000">Cancel your booking</a></p>`,
      buttonLabel: 'Manage My Booking',
      buttonUrl: `${APP_URL}/my-schedule.html`
    })
  });
}

function waiverViewToken(waiverId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret')
    .update(`waiver-${waiverId}`).digest('hex');
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
        ['Email', to],
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

async function sendReminderEmail({ to, firstName, cls, registrationId }) {
  if (!process.env.RESEND_API_KEY) return;
  const cancelUrl = `${APP_URL}/api/registrations/${registrationId}/cancel?token=${cancelToken(registrationId)}`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Reminder: ${cls.title} is tomorrow at ${formatClassTime(cls.time)}`,
    html: emailWrap({
      heading: `See You Tomorrow, ${firstName}!`,
      subtitle: 'This is a friendly reminder about your class.',
      detailRows: [
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
        ['Instructor', cls.instructor],
        ['Duration', `${cls.duration} minutes`],
      ],
      body: `<p style="font-size:14px;color:#6b6b6b">Can't make it? <a href="${cancelUrl}" style="color:#820000">Cancel your booking</a> so your spot can go to someone else.</p>`,
      buttonLabel: 'Manage My Booking',
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
      <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:20px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:bold">${reg.firstName} ${reg.lastName}</p>
        <p style="margin:0 0 2px;font-size:13px;color:#555">${reg.email} &nbsp;·&nbsp; ${reg.phone || '—'}</p>
        <p style="margin:4px 0 12px;font-size:13px">
          <strong>${cls ? cls.title : 'Unknown class'}</strong>
          ${cls ? ` — ${formatClassDate(cls.date)} at ${formatClassTime(cls.time)}` : ''}
        </p>
        <p style="margin:0 0 12px;font-size:12px;color:#888">Registered: ${new Date(reg.registeredAt).toLocaleString('en-CA')}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="${confirmUrl}" style="display:inline-block;background:#2d6a2d;color:#fff;padding:10px 22px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:14px">✅ Payment Received</a>
          <a href="${releaseUrl}" style="display:inline-block;background:#820000;color:#fff;padding:10px 22px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:14px">❌ No Payment — Remove</a>
        </div>
      </div>`;
  }).join('');

  await getResend().emails.send({
    from: FROM_ADDRESS,
    to: notifyEmail,
    subject: `Payment Alert: ${unpaidList.length} unpaid booking${unpaidList.length > 1 ? 's' : ''} require your attention`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#333">
        <div style="background:#820000;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">Red Maple Movement</h1>
        </div>
        <div style="padding:32px">
          <h2 style="color:#820000;margin-top:0">Payment Required — Action Needed</h2>
          <p>The following ${unpaidList.length > 1 ? `<strong>${unpaidList.length} bookings have</strong>` : 'booking has'} been pending for over 1 hour without recorded payment. Please confirm or remove each registration.</p>
          ${rows}
          <p style="font-size:12px;color:#999;margin-top:24px">Each button above is a one-click action — no login required. Clicking "Payment Received" marks the booking as paid and sends a confirmation to the attendee. Clicking "No Payment — Remove" cancels the booking and notifies the attendee.</p>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#666">
          Red Maple Movement &mdash; <a href="${APP_URL}/admin.html" style="color:#820000">Admin Dashboard</a>
        </div>
      </div>`
  });
}

async function sendPaymentConfirmedEmail({ to, firstName, cls }) {
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Payment Confirmed — See you in ${cls.title}!`,
    html: emailWrap({
      heading: `Payment Confirmed`,
      subtitle: `You're all set, ${firstName}! We can't wait to see you on the mat.`,
      detailRows: [
        ['Class', cls.title],
        ['Date', formatClassDate(cls.date)],
        ['Time', formatClassTime(cls.time)],
        ['Instructor', cls.instructor],
        ['Duration', `${cls.duration} minutes`],
      ],
      body: `<p style="font-size:13px;color:#b0b0b0">Cancellations more than 24 hours before class are fully refundable. <a href="${APP_URL}/cancellation-policy.html" style="color:#820000">Cancellation Policy</a></p>`,
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
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#8B1A1A;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">Red Maple Movement</h1>
        </div>
        <div style="padding:32px">
          <h2 style="color:#8B1A1A">New Class Booking</h2>
          <p>A new registration has been received:</p>
          <div style="background:#f9f9f9;border-left:4px solid #8B1A1A;padding:16px;margin:24px 0;border-radius:4px">
            <p style="margin:4px 0"><strong>Name:</strong> ${registrant.firstName} ${registrant.lastName}</p>
            <p style="margin:4px 0"><strong>Email:</strong> ${registrant.email}</p>
            <p style="margin:4px 0"><strong>Phone:</strong> ${registrant.phone || '—'}</p>
            <p style="margin:4px 0"><strong>Class:</strong> ${cls.title}</p>
            <p style="margin:4px 0"><strong>Date:</strong> ${formatClassDate(cls.date)}</p>
            <p style="margin:4px 0"><strong>Time:</strong> ${formatClassTime(cls.time)}</p>
            <p style="margin:4px 0"><strong>Instructor:</strong> ${cls.instructor}</p>
          </div>
          <a href="${APP_URL}/admin.html" style="display:inline-block;background:#8B1A1A;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold">View Admin Dashboard</a>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#666">
          Red Maple Movement &mdash; <a href="${APP_URL}" style="color:#8B1A1A">${APP_URL}</a>
        </div>
      </div>`
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
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
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

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

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

  // 2. Session middleware — DB tables are guaranteed to exist now
  app.use(session({
    store: new pgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: false  // table was just created above
    }),
    secret: process.env.SESSION_SECRET || 'redmaple-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  }));

  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

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

  app.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ user: null });
    const { id, email, first_name, last_name, is_admin } = req.user;
    res.json({ user: { id, email, firstName: first_name, lastName: last_name, isAdmin: !!is_admin } });
  });

  app.post('/auth/signup', async (req, res) => {
    const { email, password, firstName, lastName } = req.body;
    if (!email || !password || !firstName || !lastName)
      return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
      const { rows: existing } = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (existing.length > 0) return res.status(409).json({ error: 'An account with that email already exists.' });
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

  app.post('/auth/login', (req, res, next) => {
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
  app.post('/auth/forgot-password', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    try {
      const { rows } = await pool.query(
        'SELECT id, email, first_name, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
        [email.trim()]
      );
      if (rows.length) {
        const user = rows[0];
        // If they only have social login (no password_hash), skip — but still return success
        if (user.password_hash) {
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
          sendPasswordResetEmail({ to: user.email, firstName: user.first_name, resetUrl })
            .catch(e => console.error('Reset email error:', e.message));
        }
      }
      // Always respond success for privacy
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Reset password — consumes the one-time token and sets a new password
  app.post('/auth/reset-password', async (req, res) => {
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

  app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google-not-configured');
    if (req.query.returnTo) req.session.authReturnTo = req.query.returnTo;
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
  });
  app.get('/auth/google/callback', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google-not-configured');
    passport.authenticate('google', (err, user) => {
      if (err) { console.error('Google auth error:', err.message || err); return res.redirect('/login.html?error=google'); }
      if (!user) { console.error('Google auth: no user returned'); return res.redirect('/login.html?error=google'); }
      req.login(user, (loginErr) => {
        if (loginErr) { console.error('Google login error:', loginErr.message || loginErr); return res.redirect('/login.html?error=google'); }
        const returnTo = req.session.authReturnTo || '/';
        delete req.session.authReturnTo;
        return res.redirect(returnTo.startsWith('http') ? returnTo : '/' + returnTo);
      });
    })(req, res, next);
  });

  app.get('/auth/facebook', (req, res, next) => {
    if (!process.env.FACEBOOK_APP_ID) return res.redirect('/login.html?error=facebook-not-configured');
    passport.authenticate('facebook', { scope: ['email'] })(req, res, next);
  });
  app.get('/auth/facebook/callback', (req, res, next) => {
    if (!process.env.FACEBOOK_APP_ID) return res.redirect('/login.html?error=facebook-not-configured');
    passport.authenticate('facebook', { failureRedirect: '/login.html?error=facebook' })(req, res, next);
  }, (req, res) => res.redirect('/'));

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

  app.post('/api/register', async (req, res) => {
    const { classId, firstName, lastName, email, phone, packageType, password } = req.body;
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
            // Brand new user — create account and log in
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
      await pool.query(
        `INSERT INTO registrations (id,"classId","firstName","lastName",email,phone,"registeredAt",payment_status,package_type,user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
        [registrationId, classId, firstName, lastName, email, phone || '', new Date().toISOString(), pkgType, userId]
      );
      res.status(201).json({ success: true, registrationId, packageType: pkgType, accountCreated });
      sendConfirmationEmail({ to: email, firstName, lastName, cls, registrationId }).catch(e => console.error('Confirmation email error:', e.message));
      getSetting('booking_notify_email').then(notifyEmail => {
        if (notifyEmail) sendNewBookingNotification({ notifyEmail, registrant: { firstName, lastName, email, phone }, cls }).catch(e => console.error('Notify email error:', e.message));
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
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
        packageType: r.package_type || 'single', userId: r.user_id,
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

      res.json({
        creditBalance,
        bundleCount,
        pendingPayments: pending[0]?.n || 0
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.delete('/api/my-registrations/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(`
        SELECT r.*, c.date, c.time FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE r.id = $1 AND LOWER(r.email) = LOWER($2)
      `, [req.params.id, req.user.email]);
      if (rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
      const reg = rows[0];
      const classStart = new Date(`${reg.date}T${reg.time}`);
      const hoursUntilClass = (classStart - new Date()) / (1000 * 60 * 60);
      const refundEligible = hoursUntilClass > 24;
      await archiveRegistration(req.params.id, 'user');
      await pool.query('DELETE FROM registrations WHERE id = $1', [req.params.id]);
      res.json({ success: true, refundEligible });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: list all admin users
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.is_admin, u.created_at,
               w.id AS waiver_id, w.signed_at AS waiver_signed_at,
               COALESCE(uc.balance, 0) AS credit_balance
        FROM users u
        LEFT JOIN waivers w ON w.user_id = u.id OR LOWER(w.email) = LOWER(u.email)
        LEFT JOIN user_credits uc ON uc.user_id = u.id
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
      // Archive all of this user's registrations before deleting the account
      const { rows: userRegs } = await pool.query('SELECT id FROM registrations WHERE user_id = $1', [userId]);
      for (const r of userRegs) await archiveRegistration(r.id, 'user-deleted');
      await pool.query('DELETE FROM registrations WHERE user_id = $1', [userId]);
      const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
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

  // Admin: mark a registration as paid
  app.post('/api/admin/registrations/:id/mark-paid', requireAdmin, async (req, res) => {
    try {
      // Atomic, idempotent transition: only flip to 'paid' if currently not 'paid'.
      // RETURNING the row tells us whether a state change actually happened — if no row
      // is returned it means the registration was already paid (or doesn't exist) and
      // we must NOT re-grant credits or re-send confirmation emails.
      const { rows: updated } = await pool.query(
        `UPDATE registrations SET payment_status = 'paid'
         WHERE id = $1 AND payment_status != 'paid'
         RETURNING id, "firstName", "lastName", email, "classId", package_type, user_id`,
        [req.params.id]
      );

      if (!updated.length) {
        // Either already paid or not found — distinguish so the UI can refresh cleanly
        const { rows: existing } = await pool.query(
          `SELECT payment_status FROM registrations WHERE id = $1`,
          [req.params.id]
        );
        if (!existing.length) return res.status(404).json({ error: 'Registration not found' });
        return res.status(200).json({ success: true, alreadyPaid: true });
      }

      const reg = updated[0];

      // Fetch class details for the email
      const { rows: clsRows } = await pool.query(
        `SELECT title, date, time, instructor, duration FROM classes WHERE id = $1`,
        [reg.classId]
      );
      const cls = clsRows[0] || { title: '(class removed)', date: '', time: '', instructor: '', duration: 0 };

      // 4-pack: add 3 credits (1 used for this class, 3 carry forward)
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
        res.json({ success: true, packageType: '4pack', creditsAdded: 3, creditsRemaining });
        sendPackageConfirmedEmail({ to: reg.email, firstName: reg.firstName, cls, creditsRemaining })
          .catch(e => console.error('Package confirmed email error:', e.message));
      } else {
        res.json({ success: true, packageType: reg.package_type || 'single' });
        sendPaymentConfirmedEmail({ to: reg.email, firstName: reg.firstName, cls })
          .catch(e => console.error('Payment confirmed email error:', e.message));
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
        SELECT r.*, c.date, c.time, c.title
        FROM registrations r JOIN classes c ON c.id = r."classId"
        WHERE r.id = $1
      `, [id]);
      if (rows.length === 0) return res.send('<h2>This booking has already been cancelled.</h2>');
      const reg = rows[0];
      const classStart = new Date(`${reg.date}T${reg.time}`);
      const hoursUntilClass = (classStart - new Date()) / (1000 * 60 * 60);
      const refundEligible = hoursUntilClass > 24;

      await archiveRegistration(id, 'email-link');
      await pool.query('DELETE FROM registrations WHERE id = $1', [id]);

      const refundNote = refundEligible
        ? 'As you cancelled more than 24 hours before the class, your $25 payment will be refunded within 2–3 business days.'
        : 'Cancellations within 24 hours of class start are not eligible for a refund per our <a href="' + APP_URL + '/cancellation-policy.html" style="color:#820000">Cancellation Policy</a>.';

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

  // Cron endpoint — called daily by Vercel cron to send 24hr reminders
  app.get('/api/cron/reminders', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().slice(0, 10);
      const { rows } = await pool.query(`
        SELECT r.id, r."firstName", r.email, c.title, c.date, c.time, c.instructor, c.duration
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE c.date = $1
      `, [tomorrowStr]);
      let sent = 0;
      for (const row of rows) {
        await sendReminderEmail({
          to: row.email, firstName: row.firstName, registrationId: row.id,
          cls: { title: row.title, date: row.date, time: row.time, instructor: row.instructor, duration: row.duration }
        }).catch(e => console.error(`Reminder failed for ${row.email}:`, e.message));
        sent++;
      }
      res.json({ success: true, remindersSent: sent, date: tomorrowStr });
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
    const { firstName, lastName, email, phone, emergencyName, emergencyPhone, healthConditions, signatureData } = req.body;
    if (!firstName || !lastName || !email || !signatureData)
      return res.status(400).json({ error: 'Missing required fields.' });
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
            user_id=COALESCE($8, user_id)
          WHERE LOWER(email) = LOWER($9)`,
          [firstName, lastName, phone||'', emergencyName||'', emergencyPhone||'', healthConditions||'', signatureData, userId, email]
        );
        const { rows } = await pool.query('SELECT * FROM waivers WHERE LOWER(email) = LOWER($1)', [email]);
        res.json({ success: true, waiver: rows[0] });
        sendWaiverConfirmationEmail({ to: email, firstName, waiverId: rows[0].id, signedAt: rows[0].signed_at })
          .catch(e => console.error('Waiver email error:', e.message));
        return;
      }
      const id = Date.now().toString();
      await pool.query(`
        INSERT INTO waivers (id, user_id, first_name, last_name, email, phone, emergency_name, emergency_phone, health_conditions, signature_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, userId, firstName, lastName, email.toLowerCase(), phone||'', emergencyName||'', emergencyPhone||'', healthConditions||'', signatureData]
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

  app.get('/api/waiver/my', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not signed in.' });
    try {
      const { rows } = await pool.query(
        'SELECT id, first_name, last_name, email, phone, emergency_name, emergency_phone, health_conditions, signature_data, signed_at FROM waivers WHERE user_id = $1 OR LOWER(email) = LOWER($2) ORDER BY signed_at DESC LIMIT 1',
        [req.user.id, req.user.email]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'No waiver found.' });
      const w = rows[0];
      const viewUrl = `/api/waiver/view/${w.id}?token=${waiverViewToken(w.id)}`;
      res.json({ waiver: { ...w, viewUrl } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Secure waiver view page (linked from confirmation email)
  app.get('/api/waiver/view/:id', async (req, res) => {
    const { token } = req.query;
    if (!token || token !== waiverViewToken(req.params.id))
      return res.status(400).send('<h2>Invalid or expired waiver link.</h2>');
    try {
      const { rows } = await pool.query('SELECT * FROM waivers WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).send('<h2>Waiver not found.</h2>');
      const w = rows[0];
      const signedDate = new Date(w.signed_at).toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Signed Waiver — Red Maple Movement</title>
        <style>
          body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 1.5rem;color:#333}
          h1{color:#8B1A1A} .field{margin:8px 0;padding:10px 14px;background:#f9f9f9;border-radius:6px;border-left:3px solid #8B1A1A}
          .label{font-size:0.78rem;color:#888;text-transform:uppercase;letter-spacing:.05em} .value{font-weight:600;margin-top:2px}
          .sig img{max-width:100%;border:1px solid #ddd;border-radius:4px;margin-top:8px}
          .badge{display:inline-block;background:#2e7d32;color:#fff;padding:4px 12px;border-radius:20px;font-size:0.85rem;margin-bottom:1.5rem}
          @media print{button{display:none}}
        </style>
      </head><body>
        <h1>Red Maple Movement — Signed Waiver</h1>
        <div class="badge">✓ Signed on ${signedDate}</div>
        <div class="field"><div class="label">Full Name</div><div class="value">${w.first_name} ${w.last_name}</div></div>
        <div class="field"><div class="label">Email</div><div class="value">${w.email}</div></div>
        <div class="field"><div class="label">Phone</div><div class="value">${w.phone || '—'}</div></div>
        <div class="field"><div class="label">Emergency Contact</div><div class="value">${w.emergency_name || '—'}${w.emergency_phone ? ' · ' + w.emergency_phone : ''}</div></div>
        <div class="field"><div class="label">Health Conditions</div><div class="value">${w.health_conditions || 'None stated'}</div></div>
        ${w.signature_data ? `<div class="field sig"><div class="label">Signature</div><img src="${w.signature_data}" alt="Signature"></div>` : ''}
        <p style="margin-top:2rem"><button onclick="window.print()" style="background:#8B1A1A;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:1rem">Print / Save PDF</button></p>
      </body></html>`);
    } catch (e) { console.error(e); res.status(500).send('<h2>Something went wrong.</h2>'); }
  });

  // Admin: view a specific waiver (session-protected)
  app.get('/api/admin/waiver/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM waivers WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).send('<h2>Waiver not found.</h2>');
      const w = rows[0];
      const signedDate = new Date(w.signed_at).toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Waiver — ${w.first_name} ${w.last_name}</title>
        <style>
          body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 1.5rem;color:#333}
          h1{color:#8B1A1A} .field{margin:8px 0;padding:10px 14px;background:#f9f9f9;border-radius:6px;border-left:3px solid #8B1A1A}
          .label{font-size:0.78rem;color:#888;text-transform:uppercase;letter-spacing:.05em} .value{font-weight:600;margin-top:2px}
          .sig img{max-width:100%;border:1px solid #ddd;border-radius:4px;margin-top:8px}
          .badge{display:inline-block;background:#2e7d32;color:#fff;padding:4px 12px;border-radius:20px;font-size:0.85rem;margin-bottom:1.5rem}
          @media print{button{display:none}}
        </style>
      </head><body>
        <h1>Red Maple Movement — Signed Waiver</h1>
        <div class="badge">✓ Signed on ${signedDate}</div>
        <div class="field"><div class="label">Full Name</div><div class="value">${w.first_name} ${w.last_name}</div></div>
        <div class="field"><div class="label">Email</div><div class="value">${w.email}</div></div>
        <div class="field"><div class="label">Phone</div><div class="value">${w.phone || '—'}</div></div>
        <div class="field"><div class="label">Emergency Contact</div><div class="value">${w.emergency_name || '—'}${w.emergency_phone ? ' · ' + w.emergency_phone : ''}</div></div>
        <div class="field"><div class="label">Health Conditions</div><div class="value">${w.health_conditions || 'None stated'}</div></div>
        ${w.signature_data ? `<div class="field sig"><div class="label">Signature</div><img src="${w.signature_data}" alt="Signature"></div>` : ''}
        <p style="margin-top:2rem"><button onclick="window.print()" style="background:#8B1A1A;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:1rem">Print / Save PDF</button></p>
      </body></html>`);
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
          await sendConfirmationEmail({ to: testEmail, firstName: 'Test', lastName: 'User', cls: sampleCls, registrationId: sampleRegId });
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
