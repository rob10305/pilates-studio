import { getStore } from "@netlify/blobs";

async function getClasses(store) {
  const data = await store.get("classes", { type: "json" });
  return data || [];
}

async function getRegistrations(store) {
  const data = await store.get("registrations", { type: "json" });
  return data || [];
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const store = getStore("studio-data");
  const body = await req.json();
  const { classId, firstName, lastName, email, phone } = body;

  if (!classId || !firstName || !lastName || !email) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  const classes = await getClasses(store);
  const cls = classes.find((c) => c.id === classId);
  if (!cls) {
    return Response.json({ error: "Class not found" }, { status: 404 });
  }

  const registrations = await getRegistrations(store);
  const count = registrations.filter((r) => r.classId === classId).length;
  if (count >= cls.capacity) {
    return Response.json({ error: "Class is full" }, { status: 409 });
  }

  const alreadyRegistered = registrations.find(
    (r) => r.classId === classId && r.email.toLowerCase() === email.toLowerCase()
  );
  if (alreadyRegistered) {
    return Response.json({ error: "You are already registered for this class" }, { status: 409 });
  }

  const reg = {
    id: Date.now().toString(),
    classId,
    firstName,
    lastName,
    email,
    phone: phone || "",
    registeredAt: new Date().toISOString(),
  };
  registrations.push(reg);
  await store.setJSON("registrations", registrations);

  return Response.json(
    { success: true, message: `You're booked! See you in class, ${firstName}.` },
    { status: 201 }
  );
};

export const config = {
  path: "/api/register",
};
