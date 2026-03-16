const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pilates2024';

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Add a PostgreSQL database to your Railway project, or set DATABASE_URL locally.');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/classes', async (req, res) => {
  const { password, title, instructor, date, time, duration, capacity, description } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  if (!title || !date || !time || !capacity) return res.status(400).json({ error: 'Missing required fields' });

  const newClass = {
    id: Date.now().toString(),
    title,
    instructor: instructor || 'Studio Instructor',
    date,
    time,
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/classes/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  try {
    const { rowCount } = await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Class not found' });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Registrations API ---
app.post('/api/register', async (req, res) => {
  const { classId, firstName, lastName, email, phone } = req.body;
  if (!classId || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const { rows: clsRows } = await pool.query('SELECT * FROM classes WHERE id = $1', [classId]);
    if (clsRows.length === 0) return res.status(404).json({ error: 'Class not found' });
    const cls = clsRows[0];

    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM registrations WHERE "classId" = $1', [classId]);
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start
initDB()
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Red Maple Movement running on port ${PORT}`);
    });

    // Graceful shutdown — lets Railway restart containers cleanly
    process.on('SIGTERM', () => {
      server.close(() => {
        pool.end();
        console.log('Server closed.');
      });
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
