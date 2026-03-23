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

async function sendConfirmationEmail({ to, firstName, cls, registrationId }) {
  if (!process.env.RESEND_API_KEY) return;
  const cancelUrl = `${APP_URL}/api/registrations/${registrationId}/cancel?token=${cancelToken(registrationId)}`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Booking Confirmed: ${cls.title} on ${formatClassDate(cls.date)}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#8B1A1A;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">Red Maple Movement</h1>
        </div>
        <div style="padding:32px">
          <h2 style="color:#8B1A1A">You're booked, ${firstName}!</h2>
          <p>Your spot in <strong>${cls.title}</strong> has been confirmed.</p>
          <div style="background:#f9f9f9;border-left:4px solid #8B1A1A;padding:16px;margin:24px 0;border-radius:4px">
            <p style="margin:4px 0"><strong>Class:</strong> ${cls.title}</p>
            <p style="margin:4px 0"><strong>Date:</strong> ${formatClassDate(cls.date)}</p>
            <p style="margin:4px 0"><strong>Time:</strong> ${formatClassTime(cls.time)}</p>
            <p style="margin:4px 0"><strong>Instructor:</strong> ${cls.instructor}</p>
            <p style="margin:4px 0"><strong>Duration:</strong> ${cls.duration} minutes</p>
          </div>
          <p>We'll send you a reminder 24 hours before your class.</p>
          <p>Need to cancel? <a href="${cancelUrl}" style="color:#8B1A1A">Click here to cancel your booking</a>.</p>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#666">
          Red Maple Movement &mdash; <a href="${APP_URL}" style="color:#8B1A1A">${APP_URL}</a>
        </div>
      </div>`
  });
}

function waiverViewToken(waiverId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret')
    .update(`waiver-${waiverId}`).digest('hex');
}

async function sendWaiverConfirmationEmail({ to, firstName, waiverId, signedAt }) {
  if (!process.env.RESEND_API_KEY) return;
  const viewUrl = `${APP_URL}/api/waiver/view/${waiverId}?token=${waiverViewToken(waiverId)}`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Your Red Maple Movement Waiver — Signed Successfully',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#8B1A1A;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">Red Maple Movement</h1>
        </div>
        <div style="padding:32px">
          <h2 style="color:#8B1A1A">Waiver Received, ${firstName}!</h2>
          <p>Thank you — your liability waiver has been successfully signed and is on file with Red Maple Movement.</p>
          <div style="background:#f9f9f9;border-left:4px solid #8B1A1A;padding:16px;margin:24px 0;border-radius:4px">
            <p style="margin:4px 0"><strong>Signed by:</strong> ${firstName}</p>
            <p style="margin:4px 0"><strong>Date:</strong> ${new Date(signedAt).toLocaleDateString('en-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</p>
            <p style="margin:4px 0"><strong>Email:</strong> ${to}</p>
          </div>
          <p>You can view and download a copy of your signed waiver at any time using the link below.</p>
          <a href="${viewUrl}" style="display:inline-block;background:#8B1A1A;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold">View My Waiver</a>
          <p style="margin-top:24px;font-size:0.85rem;color:#999">Keep this email — the link above provides permanent access to your waiver copy.</p>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#666">
          Red Maple Movement &mdash; <a href="${APP_URL}" style="color:#8B1A1A">${APP_URL}</a>
        </div>
      </div>`
  });
}

async function sendRemovalEmail({ to, firstName, cls }) {
  if (!process.env.RESEND_API_KEY) return;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Your booking for ${cls.title} has been cancelled`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#8B1A1A;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">Red Maple Movement</h1>
        </div>
        <div style="padding:32px">
          <h2 style="color:#8B1A1A">Booking Cancelled, ${firstName}</h2>
          <p>We wanted to let you know that your spot in the following class has been cancelled by the studio:</p>
          <div style="background:#f9f9f9;border-left:4px solid #8B1A1A;padding:16px;margin:24px 0;border-radius:4px">
            <p style="margin:4px 0"><strong>Class:</strong> ${cls.title}</p>
            <p style="margin:4px 0"><strong>Date:</strong> ${formatClassDate(cls.date)}</p>
            <p style="margin:4px 0"><strong>Time:</strong> ${formatClassTime(cls.time)}</p>
            <p style="margin:4px 0"><strong>Instructor:</strong> ${cls.instructor}</p>
          </div>
          <p>If you have any questions, please contact us directly.</p>
          <a href="${APP_URL}" style="display:inline-block;background:#8B1A1A;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold">Visit Red Maple Movement</a>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#666">
          Red Maple Movement &mdash; <a href="${APP_URL}" style="color:#8B1A1A">${APP_URL}</a>
        </div>
      </div>`
  });
}

async function sendReminderEmail({ to, firstName, cls, registrationId }) {
  if (!process.env.RESEND_API_KEY) return;
  const cancelUrl = `${APP_URL}/api/registrations/${registrationId}/cancel?token=${cancelToken(registrationId)}`;
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `Reminder: ${cls.title} is tomorrow at ${formatClassTime(cls.time)}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
        <div style="background:#8B1A1A;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">Red Maple Movement</h1>
        </div>
        <div style="padding:32px">
          <h2 style="color:#8B1A1A">See you tomorrow, ${firstName}!</h2>
          <p>This is a friendly reminder about your class tomorrow.</p>
          <div style="background:#f9f9f9;border-left:4px solid #8B1A1A;padding:16px;margin:24px 0;border-radius:4px">
            <p style="margin:4px 0"><strong>Class:</strong> ${cls.title}</p>
            <p style="margin:4px 0"><strong>Date:</strong> ${formatClassDate(cls.date)}</p>
            <p style="margin:4px 0"><strong>Time:</strong> ${formatClassTime(cls.time)}</p>
            <p style="margin:4px 0"><strong>Instructor:</strong> ${cls.instructor}</p>
            <p style="margin:4px 0"><strong>Duration:</strong> ${cls.duration} minutes</p>
          </div>
          <p>Can't make it? Please cancel so your spot can go to someone else.</p>
          <a href="${cancelUrl}" style="display:inline-block;background:#8B1A1A;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold">Cancel My Booking</a>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#666">
          Red Maple Movement &mdash; <a href="${APP_URL}" style="color:#8B1A1A">${APP_URL}</a>
        </div>
      </div>`
  });
}

async function getSetting(key) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  } catch { return null; }
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

  // Seed sample data if empty
  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM classes');
  if (parseInt(rows[0].n) === 0) {
    const insert = `INSERT INTO classes (id,title,instructor,date,time,duration,capacity,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const seed = [
      ['1001','Foundations Pilates','Sophie Andrews','2026-04-07','09:00',45,10,'Perfect for beginners — build core strength and learn the fundamentals.'],
      ['1002','Mat Pilates','Claire Holt','2026-04-07','11:00',60,12,'Classic mat-based Pilates for full-body conditioning.'],
      ['1003','Power Pilates','James Reid','2026-04-08','07:30',50,8,'High-energy workout for those ready to level up.'],
      ['1004','Pilates & Flow','Sophie Andrews','2026-04-09','10:00',60,10,'A mindful blend of Pilates and gentle yoga flow.'],
      ['1005','Reformer Pilates','Claire Holt','2026-04-10','09:30',55,6,'Spring-loaded resistance on the iconic reformer machine.'],
      ['1006','Prenatal Pilates','Emma Walsh','2026-04-11','10:30',45,8,'Gentle and safe Pilates for expectant mothers.'],
      ['1007','Mat Pilates','James Reid','2026-04-14','18:00',60,12,'Unwind after your workday with an evening mat class.'],
      ['1008','Power Pilates','Claire Holt','2026-04-16','07:00',50,8,'Start your Wednesday strong.'],
      ['1009','Pilates & Flow','Emma Walsh','2026-04-18','11:00',60,10,'End your week with balance and calm.'],
      ['1010','Foundations Pilates','Sophie Andrews','2026-04-21','09:00',45,10,'Perfect for beginners.'],
    ];
    for (const row of seed) await pool.query(insert, row);
    console.log('Database seeded with sample classes.');
  }
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

  app.post('/auth/logout', (req, res, next) => {
    req.logout(err => {
      if (err) return next(err);
      res.json({ success: true });
    });
  });

  app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google-not-configured');
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
  });
  app.get('/auth/google/callback', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google-not-configured');
    passport.authenticate('google', (err, user) => {
      if (err) { console.error('Google auth error:', err.message || err); return res.redirect('/login.html?error=google'); }
      if (!user) { console.error('Google auth: no user returned'); return res.redirect('/login.html?error=google'); }
      req.login(user, (loginErr) => {
        if (loginErr) { console.error('Google login error:', loginErr.message || loginErr); return res.redirect('/login.html?error=google'); }
        return res.redirect('/');
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

  app.delete('/api/classes/:id', requireAdmin, async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.post('/api/register', async (req, res) => {
    const { classId, firstName, lastName, email, phone } = req.body;
    if (!classId || !firstName || !lastName || !email)
      return res.status(400).json({ error: 'Missing required fields' });
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
      await pool.query(
        `INSERT INTO registrations (id,"classId","firstName","lastName",email,phone,"registeredAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [registrationId, classId, firstName, lastName, email, phone || '', new Date().toISOString()]
      );
      res.status(201).json({ success: true, message: `You're booked! See you in class, ${firstName}.` });
      sendConfirmationEmail({ to: email, firstName, cls, registrationId }).catch(e => console.error('Confirmation email error:', e.message));
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
        registeredAt: r.registeredAt,
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
               c.title, c.date, c.time, c.instructor, c.duration, c.description
        FROM registrations r
        JOIN classes c ON c.id = r."classId"
        WHERE LOWER(r.email) = LOWER($1)
        ORDER BY c.date ASC, c.time ASC
      `, [req.user.email]);
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  app.delete('/api/my-registrations/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM registrations WHERE id = $1 AND LOWER(email) = LOWER($2)',
        [req.params.id, req.user.email]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Registration not found' });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
  });

  // Admin: list all admin users
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.is_admin, u.created_at,
               w.id AS waiver_id, w.signed_at AS waiver_signed_at
        FROM users u
        LEFT JOIN waivers w ON w.user_id = u.id OR LOWER(w.email) = LOWER(u.email)
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
      const { rowCount } = await pool.query('DELETE FROM registrations WHERE id = $1', [id]);
      if (rowCount === 0) return res.send('<h2>This booking has already been cancelled.</h2>');
      res.send(`
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:80px auto;text-align:center;color:#333">
          <div style="background:#8B1A1A;padding:20px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0">Red Maple Movement</h1>
          </div>
          <div style="border:1px solid #ddd;border-top:none;padding:40px;border-radius:0 0 8px 8px">
            <h2 style="color:#8B1A1A">Booking Cancelled</h2>
            <p>Your booking has been successfully cancelled. We hope to see you in a future class!</p>
            <a href="${APP_URL}" style="display:inline-block;background:#8B1A1A;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;margin-top:16px">Back to Red Maple Movement</a>
          </div>
        </div>`);
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
        'SELECT id, first_name, last_name, email, phone, emergency_name, emergency_phone, health_conditions, signature_data, signed_at FROM waivers WHERE user_id = $1 ORDER BY signed_at DESC LIMIT 1',
        [req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'No waiver found.' });
      res.json({ waiver: rows[0] });
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
