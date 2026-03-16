import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "pilates2024";

export default async (req, context) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(req.url);
  const password = url.searchParams.get("password");

  if (password !== ADMIN_PASSWORD) {
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  const store = getStore("studio-data");
  const registrations = (await store.get("registrations", { type: "json" })) || [];
  const classes = (await store.get("classes", { type: "json" })) || [];

  const enriched = registrations.map((r) => ({
    ...r,
    class: classes.find((c) => c.id === r.classId) || null,
  }));

  return Response.json(enriched);
};

export const config = {
  path: "/api/registrations",
};
