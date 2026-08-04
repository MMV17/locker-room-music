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

/* Devices and plays.
   The public /api/devices/unclaimed only lists orphans, and /api/history hides
   anything still inside its vote window - neither is a basis for the two
   corrective actions below, so admin gets its own unfiltered view. */

admin.get("/api/admin/devices", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.mac_hash, d.mac_hint, d.alias, d.first_seen, d.claimed_at,
            u.name AS owner_name,
            COUNT(p.id) AS plays
     FROM devices d
     LEFT JOIN users u ON u.id = d.user_id
     LEFT JOIN plays p ON p.device_hash = d.mac_hash
     GROUP BY d.mac_hash
     ORDER BY plays DESC`,
  ).all();
  return c.json({ devices: results });
});

admin.get("/api/admin/plays", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.started_at, p.counted, p.voided,
            t.title, t.artist,
            u.name AS dj_name
     FROM plays p
     JOIN tracks t ON t.id = p.track_id
     LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.started_at DESC
     LIMIT 50`,
  ).all();
  return c.json({ plays: results });
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
