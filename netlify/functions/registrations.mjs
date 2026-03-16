import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "pilates2024";

export default async (req, context) => {
  const store = getStore("studio-data");
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const url = new URL(req.url);
  const password = url.searchParams.get("password");

  if (password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers });
  }

  let registrations = await store.get("registrations", { type: "json" });
  if (registrations === null) registrations = [];

  let classes = await store.get("classes", { type: "json" });
  if (classes === null) classes = [];

  const enriched = registrations.map(r => ({
    ...r,
    class: classes.find(c => c.id === r.classId) || null
  }));

  return new Response(JSON.stringify(enriched), { headers });
};
