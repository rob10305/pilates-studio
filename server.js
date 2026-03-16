const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pilates2024';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database setup ---
const DB_DIR = process.env.DATABASE_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'pilates.db'));

db.exec(`
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
    id           TEXT PRIMARY KEY,
    classId      TEXT NOT NULL,
    firstName    TEXT NOT NULL,
    lastName     TEXT NOT NULL,
    email        TEXT NOT NULL,
    phone        TEXT NOT NULL DEFAULT '',
    registeredAt TEXT NOT NULL,
    FOREIGN KEY (classId) REFERENCES classes(id) ON DELETE CASCADE
  );
`);

// Seed sample classes if empty
const isEmpty = db.prepare('SELECT COUNT(*) as n FROM classes').get().n === 0;
if (isEmpty) {
  const insert = db.prepare(`
    INSERT INTO classes (id, title, instructor, date, time, duration, capacity, description)
    VALUES (@id, @title, @instructor, @date, @time, @duration, @capacity, @description)
  `);
  const seed = db.transaction((rows) => rows.forEach(r => insert.run(r)));
  seed([
    { id:'1001', title:'Foundations Pilates', instructor:'Sophie Andrews', date:'2026-04-07', time:'09:00', duration:45, capacity:10, description:'Perfect for beginners — build core strength and learn the fundamentals.' },
    { id:'1002', title:'Mat Pilates',         instructor:'Claire Holt',    date:'2026-04-07', time:'11:00', duration:60, capacity:12, description:'Classic mat-based Pilates for full-body conditioning.' },
    { id:'1003', title:'Power Pilates',       instructor:'James Reid',     date:'2026-04-08', time:'07:30', duration:50, capacity:8,  description:'High-energy workout for those ready to level up.' },
    { id:'1004', title:'Pilates & Flow',      instructor:'Sophie Andrews', date:'2026-04-09', time:'10:00', duration:60, capacity:10, description:'A mindful blend of Pilates and gentle yoga flow.' },
    { id:'1005', title:'Reformer Pilates',    instructor:'Claire Holt',    date:'2026-04-10', time:'09:30', duration:55, capacity:6,  description:'Spring-loaded resistance on the iconic reformer machine.' },
    { id:'1006', title:'Prenatal Pilates',    instructor:'Emma Walsh',     date:'2026-04-11', time:'10:30', duration:45, capacity:8,  description:'Gentle and safe Pilates for expectant mothers.' },
    { id:'1007', title:'Mat Pilates',         instructor:'James Reid',     date:'2026-04-14', time:'18:00', duration:60, capacity:12, description:'Unwind after your workday with an evening mat class.' },
    { id:'1008', title:'Power Pilates',       instructor:'Claire Holt',    date:'2026-04-16', time:'07:00', duration:50, capacity:8,  description:'Start your Wednesday strong.' },
    { id:'1009', title:'Pilates & Flow',      instructor:'Emma Walsh',     date:'2026-04-18', time:'11:00', duration:60, capacity:10, description:'End your week with balance and calm.' },
    { id:'1010', title:'Foundations Pilates', instructor:'Sophie Andrews', date:'2026-04-21', time:'09:00', duration:45, capacity:10, description:'Perfect for beginners.' },
  ]);
  console.log('Database seeded with sample classes.');
}

// --- Classes API ---
app.get('/api/classes', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(r.id) as registeredCount
    FROM classes c
    LEFT JOIN registrations r ON r.classId = c.id
    GROUP BY c.id
  `).all();
  res.json(rows);
});

app.post('/api/classes', (req, res) => {
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
  db.prepare(`
    INSERT INTO classes (id, title, instructor, date, time, duration, capacity, description)
    VALUES (@id, @title, @instructor, @date, @time, @duration, @capacity, @description)
  `).run(newClass);
  res.status(201).json(newClass);
});

app.delete('/api/classes/:id', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const result = db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Class not found' });
  res.json({ success: true });
});

// --- Registrations API ---
app.post('/api/register', (req, res) => {
  const { classId, firstName, lastName, email, phone } = req.body;
  if (!classId || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const count = db.prepare('SELECT COUNT(*) as n FROM registrations WHERE classId = ?').get(classId).n;
  if (count >= cls.capacity) return res.status(409).json({ error: 'Class is full' });

  const duplicate = db.prepare(
    'SELECT id FROM registrations WHERE classId = ? AND LOWER(email) = LOWER(?)'
  ).get(classId, email);
  if (duplicate) return res.status(409).json({ error: 'You are already registered for this class' });

  db.prepare(`
    INSERT INTO registrations (id, classId, firstName, lastName, email, phone, registeredAt)
    VALUES (@id, @classId, @firstName, @lastName, @email, @phone, @registeredAt)
  `).run({
    id: Date.now().toString(),
    classId,
    firstName,
    lastName,
    email,
    phone: phone || '',
    registeredAt: new Date().toISOString()
  });

  res.status(201).json({ success: true, message: `You're booked! See you in class, ${firstName}.` });
});

app.get('/api/registrations', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

  const rows = db.prepare(`
    SELECT r.*, c.title, c.date, c.time, c.instructor
    FROM registrations r
    LEFT JOIN classes c ON c.id = r.classId
    ORDER BY r.registeredAt DESC
  `).all();

  // Shape to match what the frontend expects
  const enriched = rows.map(r => ({
    id: r.id, classId: r.classId, firstName: r.firstName,
    lastName: r.lastName, email: r.email, phone: r.phone,
    registeredAt: r.registeredAt,
    class: r.title ? { title: r.title, date: r.date, time: r.time, instructor: r.instructor } : null
  }));
  res.json(enriched);
});

app.listen(PORT, () => {
  console.log(`Red Maple Movement running at http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
