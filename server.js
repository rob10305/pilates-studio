const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'classes.json');
const REGISTRATIONS_FILE = path.join(__dirname, 'data', 'registrations.json');
const ADMIN_PASSWORD = 'pilates2024';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---
function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- Classes API ---
app.get('/api/classes', (req, res) => {
  const classes = readJSON(DATA_FILE);
  const registrations = readJSON(REGISTRATIONS_FILE);
  const enriched = classes.map(c => ({
    ...c,
    registeredCount: registrations.filter(r => r.classId === c.id).length
  }));
  res.json(enriched);
});

app.post('/api/classes', (req, res) => {
  const { password, title, instructor, date, time, duration, capacity, description } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  if (!title || !date || !time || !capacity) return res.status(400).json({ error: 'Missing required fields' });

  const classes = readJSON(DATA_FILE);
  const newClass = {
    id: Date.now().toString(),
    title,
    instructor: instructor || 'Studio Instructor',
    date,
    time,
    duration: duration || 60,
    capacity: parseInt(capacity),
    description: description || ''
  };
  classes.push(newClass);
  writeJSON(DATA_FILE, classes);
  res.status(201).json(newClass);
});

app.delete('/api/classes/:id', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const classes = readJSON(DATA_FILE);
  const filtered = classes.filter(c => c.id !== req.params.id);
  if (filtered.length === classes.length) return res.status(404).json({ error: 'Class not found' });
  writeJSON(DATA_FILE, filtered);
  res.json({ success: true });
});

// --- Registrations API ---
app.post('/api/register', (req, res) => {
  const { classId, firstName, lastName, email, phone } = req.body;
  if (!classId || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const classes = readJSON(DATA_FILE);
  const cls = classes.find(c => c.id === classId);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const registrations = readJSON(REGISTRATIONS_FILE);
  const count = registrations.filter(r => r.classId === classId).length;
  if (count >= cls.capacity) return res.status(409).json({ error: 'Class is full' });

  const alreadyRegistered = registrations.find(r => r.classId === classId && r.email.toLowerCase() === email.toLowerCase());
  if (alreadyRegistered) return res.status(409).json({ error: 'You are already registered for this class' });

  const reg = {
    id: Date.now().toString(),
    classId,
    firstName,
    lastName,
    email,
    phone: phone || '',
    registeredAt: new Date().toISOString()
  };
  registrations.push(reg);
  writeJSON(REGISTRATIONS_FILE, registrations);
  res.status(201).json({ success: true, message: `You're booked! See you in class, ${firstName}.` });
});

app.get('/api/registrations', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const registrations = readJSON(REGISTRATIONS_FILE);
  const classes = readJSON(DATA_FILE);
  const enriched = registrations.map(r => ({
    ...r,
    class: classes.find(c => c.id === r.classId) || null
  }));
  res.json(enriched);
});

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DATA_FILE)) writeJSON(DATA_FILE, []);
if (!fs.existsSync(REGISTRATIONS_FILE)) writeJSON(REGISTRATIONS_FILE, []);

app.listen(PORT, () => {
  console.log(`Pilates Studio running at http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
