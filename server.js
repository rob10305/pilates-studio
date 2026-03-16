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

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pilates2024';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

// --- Database Pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Middleware ---
app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || 'redmaple-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Passport Serialize / Deserialize ---
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name FROM users WHERE id = $1', [id]
    );
    done(null, rows[0] || false);
  } catch (e) { done(e); }
});

// --- Passport: Local Strategy ---
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

// --- Passport: Google Strategy ---
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

      // Look up by Google ID or matching email
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE google_id = $1' + (email ? ' OR LOWER(email) = LOWER($2)' : ''),
        email ? [profile.id, email] : [profile.id]
      );
      let user = rows[0];

      if (user) {
        if (!user.google_id) {
          await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.id, user.id]);
        }
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

// --- Passport: Facebook Strategy ---
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
        if (!user.facebook_id) {
          await pool.query('UPDATE users SET facebook_id = $1 WHERE id = $2', [profile.id, user.id]);
        }
        return done(null, user);
      }

      // Facebook may not return an email — use synthetic placeholder to satisfy NOT NULL
      const insertEmail = email ? email.toLowerCase() : `fb_${profile.id}@noemail.local`;
      const { rows: created } = await pool.query(
        'INSERT INTO users (email, facebook_id, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING *',
        [insertEmail, profile.id, firstName, lastName]
      );
      return done(null, created[0]);
    } catch (e) { return done(e); }
  }));
}

// --- Database Init ---
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
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid    VARCHAR NOT NULL,
      sess   JSON    NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON user_sessions (expire);
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

// --- Auth API ---
app.get('/auth/config', (req, res) => {
  res.json({
    googleEnabled:   !!(process.env.GOOGLE_CLIENT_ID   && process.env.GOOGLE_CLIENT_SECRET),
    facebookEnabled: !!(process.env.FACEBOOK_APP_ID    && process.env.FACEBOOK_APP_SECRET)
  });
});

app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ user: null });
  const { id, email, first_name, last_name } = req.user;
  res.json({ user: { id, email, firstName: first_name, lastName: last_name } });
});

app.post('/auth/signup', async (req, res) => {
  const { email, password, firstName, lastName } = req.body;
  if (!email || !password || !firstName || !lastName)
    return res.status(400).json({ error: 'All fields are required.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]
    );
    if (existing.length > 0)
      return res.status(409).json({ error: 'An account with that email already exists.' });

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

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login.html?error=google' }),
    (req, res) => res.redirect('/')
  );
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  app.get('/auth/facebook', passport.authenticate('facebook', { scope: ['email'] }));
  app.get('/auth/facebook/callback',
    passport.authenticate('facebook', { failureRedirect: '/login.html?error=facebook' }),
    (req, res) => res.redirect('/')
  );
}

// --- Classes API ---
app.get('/api/classes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, COUNT(r.id)::int AS "registeredCount"
      FROM classes c
      LEFT JOIN registrations r ON r."classId" = c.id
      GROUP BY c.id
      ORDER BY c.date, c.time
    `);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/classes', async (req, res) => {
  const { password, title, instructor, date, time, duration, capacity, description } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  if (!title || !date || !time || !capacity) return res.status(400).json({ error: 'Missing required fields' });

  const newClass = {
    id: Date.now().toString(), title,
    instructor: instructor || 'Studio Instructor',
    date, time,
    duration: parseInt(duration) || 60,
    capacity: parseInt(capacity),
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

app.delete('/api/classes/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  try {
    const { rowCount } = await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// --- Registrations API ---
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
      'SELECT id FROM registrations WHERE "classId" = $1 AND LOWER(email) = LOWER($2)',
      [classId, email]
    );
    if (dupRows.length > 0) return res.status(409).json({ error: 'You are already registered for this class' });

    await pool.query(
      `INSERT INTO registrations (id,"classId","firstName","lastName",email,phone,"registeredAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [Date.now().toString(), classId, firstName, lastName, email, phone || '', new Date().toISOString()]
    );
    res.status(201).json({ success: true, message: `You're booked! See you in class, ${firstName}.` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/registrations', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  try {
    const { rows } = await pool.query(`
      SELECT r.*, c.title, c.date, c.time, c.instructor
      FROM registrations r
      LEFT JOIN classes c ON c.id = r."classId"
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

// --- Start ---
initDB()
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Red Maple Movement running on port ${PORT}`);
    });
    process.on('SIGTERM', () => {
      server.close(() => { pool.end(); console.log('Server closed.'); });
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
