import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore("studio-data");
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const body = await req.json();
  const { classId, firstName, lastName, email, phone } = body;

  if (!classId || !firstName || !lastName || !email) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers });
  }

  let classes = await store.get("classes", { type: "json" });
  if (classes === null) classes = [];

  const cls = classes.find(c => c.id === classId);
  if (!cls) {
    return new Response(JSON.stringify({ error: "Class not found" }), { status: 404, headers });
  }

  let registrations = await store.get("registrations", { type: "json" });
  if (registrations === null) registrations = [];

  const count = registrations.filter(r => r.classId === classId).length;
  if (count >= cls.capacity) {
    return new Response(JSON.stringify({ error: "Class is full" }), { status: 409, headers });
  }

  const alreadyRegistered = registrations.find(
    r => r.classId === classId && r.email.toLowerCase() === email.toLowerCase()
  );
  if (alreadyRegistered) {
    return new Response(JSON.stringify({ error: "You are already registered for this class" }), { status: 409, headers });
  }

  const reg = {
    id: Date.now().toString(),
    classId,
    firstName,
    lastName,
    email,
    phone: phone || "",
    registeredAt: new Date().toISOString()
  };

  registrations.push(reg);
  await store.setJSON("registrations", registrations);

  return new Response(
    JSON.stringify({ success: true, message: `You're booked! See you in class, ${firstName}.` }),
    { status: 201, headers }
  );
};
