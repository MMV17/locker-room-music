import { Hono } from "hono";
import type { Env } from "./types";

export const admin = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

/* Roster CRUD */

admin.get("/api/admin/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM users ORDER BY name",
  ).all();
  return c.json({ users: results });
});

admin.post("/api/admin/users", async (c) => {
  const b = await c.req.json<{
    name: string;
    jersey_number?: string;
    position?: string;
  }>();
  if (!b.name?.trim()) return c.json({ error: "name is required" }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO users (id, name, jersey_number, position, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
  )
    .bind(id, b.name.trim(), b.jersey_number ?? null, b.position ?? null, nowIso())
    .run();
  return c.json({ ok: true, id });
});

admin.patch("/api/admin/users/:id", async (c) => {
  const b = await c.req.json<{
    name?: string;
    jersey_number?: string;
    position?: string;
    active?: boolean;
  }>();
  const r = await c.env.DB.prepare(
    `UPDATE users SET
       name = COALESCE(?, name),
       jersey_number = COALESCE(?, jersey_number),
       position = COALESCE(?, position),
       active = COALESCE(?, active)
     WHERE id = ?`,
  )
    .bind(
      b.name ?? null,
      b.jersey_number ?? null,
      b.position ?? null,
      b.active === undefined ? null : b.active ? 1 : 0,
      c.req.param("id"),
    )
    .run();
  if (!r.meta.changes) return c.json({ error: "Unknown player" }, 404);
  return c.json({ ok: true });
});

/* Un-claim a device */

admin.post("/api/admin/devices/:hash/unclaim", async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE devices SET user_id = NULL, claimed_at = NULL WHERE mac_hash = ?",
  )
    .bind(c.req.param("hash"))
    .run();
  if (!r.meta.changes) return c.json({ error: "Unknown device" }, 404);
  return c.json({ ok: true });
});

/* Voiding. Rows are never deleted - voided rows drop out of every ranking
   but stay on disk, because a season of data is not reproducible. */

admin.post("/api/admin/plays/:id/void", async (c) => {
  const r = await c.env.DB.prepare("UPDATE plays SET voided = 1 WHERE id = ?")
    .bind(c.req.param("id"))
    .run();
  if (!r.meta.changes) return c.json({ error: "Unknown play" }, 404);
  return c.json({ ok: true });
});

admin.post("/api/admin/votes/:id/void", async (c) => {
  const r = await c.env.DB.prepare("UPDATE votes SET voided = 1 WHERE id = ?")
    .bind(c.req.param("id"))
    .run();
  if (!r.meta.changes) return c.json({ error: "Unknown vote" }, 404);
  return c.json({ ok: true });
});
