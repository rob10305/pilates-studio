import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "pilates2024";

const SEED_CLASSES = [
  { id: "1001", title: "Foundations Pilates", instructor: "Sophie Andrews", date: "2026-03-17", time: "09:00", duration: 45, capacity: 10, description: "Perfect for beginners — build core strength and learn the fundamentals." },
  { id: "1002", title: "Mat Pilates", instructor: "Claire Holt", date: "2026-03-17", time: "11:00", duration: 60, capacity: 12, description: "Classic mat-based Pilates for full-body conditioning." },
  { id: "1003", title: "Power Pilates", instructor: "James Reid", date: "2026-03-18", time: "07:30", duration: 50, capacity: 8, description: "High-energy workout for those ready to level up their practice." },
  { id: "1004", title: "Pilates & Flow", instructor: "Sophie Andrews", date: "2026-03-19", time: "10:00", duration: 60, capacity: 10, description: "A mindful blend of Pilates and gentle yoga flow." },
  { id: "1005", title: "Reformer Pilates", instructor: "Claire Holt", date: "2026-03-20", time: "09:30", duration: 55, capacity: 6, description: "Spring-loaded resistance training on the iconic reformer machine." },
  { id: "1006", title: "Foundations Pilates", instructor: "Sophie Andrews", date: "2026-03-21", time: "09:00", duration: 45, capacity: 10, description: "Perfect for beginners — build core strength and learn the fundamentals." },
  { id: "1007", title: "Prenatal Pilates", instructor: "Emma Walsh", date: "2026-03-22", time: "10:30", duration: 45, capacity: 8, description: "Gentle and safe Pilates designed for expectant mothers." },
  { id: "1008", title: "Mat Pilates", instructor: "James Reid", date: "2026-03-24", time: "18:00", duration: 60, capacity: 12, description: "Unwind after your workday with a refreshing evening mat class." },
  { id: "1009", title: "Power Pilates", instructor: "Claire Holt", date: "2026-03-26", time: "07:00", duration: 50, capacity: 8, description: "Start your Wednesday strong with our most energising class." },
  { id: "1010", title: "Pilates & Flow", instructor: "Emma Walsh", date: "2026-03-28", time: "11:00", duration: 60, capacity: 10, description: "End your week with balance and calm." },
];

async function getClasses(store) {
  const data = await store.get("classes", { type: "json" });
  if (data) return data;
  // Seed initial data on first access
  await store.setJSON("classes", SEED_CLASSES);
  return SEED_CLASSES;
}

async function getRegistrations(store) {
  const data = await store.get("registrations", { type: "json" });
  return data || [];
}

export default async (req, context) => {
  const store = getStore("studio-data");
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/classes
  if (method === "GET") {
    const classes = await getClasses(store);
    const registrations = await getRegistrations(store);
    const enriched = classes.map((c) => ({
      ...c,
      registeredCount: registrations.filter((r) => r.classId === c.id).length,
    }));
    return Response.json(enriched);
  }

  // POST /api/classes
  if (method === "POST") {
    const body = await req.json();
    const { password, title, instructor, date, time, duration, capacity, description } = body;

    if (password !== ADMIN_PASSWORD) {
      return Response.json({ error: "Invalid password" }, { status: 401 });
    }
    if (!title || !date || !time || !capacity) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    const classes = await getClasses(store);
    const newClass = {
      id: Date.now().toString(),
      title,
      instructor: instructor || "Studio Instructor",
      date,
      time,
      duration: duration || 60,
      capacity: parseInt(capacity),
      description: description || "",
    };
    classes.push(newClass);
    await store.setJSON("classes", classes);
    return Response.json(newClass, { status: 201 });
  }

  // DELETE /api/classes/:id
  if (method === "DELETE") {
    const pathParts = url.pathname.replace("/.netlify/functions/classes", "").split("/").filter(Boolean);
    const classId = pathParts[0];

    if (!classId) {
      return Response.json({ error: "Missing class ID" }, { status: 400 });
    }

    const body = await req.json();
    if (body.password !== ADMIN_PASSWORD) {
      return Response.json({ error: "Invalid password" }, { status: 401 });
    }

    const classes = await getClasses(store);
    const filtered = classes.filter((c) => c.id !== classId);
    if (filtered.length === classes.length) {
      return Response.json({ error: "Class not found" }, { status: 404 });
    }

    await store.setJSON("classes", filtered);
    return Response.json({ success: true });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const config = {
  path: ["/api/classes", "/api/classes/*"],
};
