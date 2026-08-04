import { Hono } from "hono";
import type { Env } from "./types";
import { normalize } from "./trackKey";
import { PI_COMMANDS, isPiCommand } from "./piControl";
import { runBackup, listBackups } from "./backup";

export const admin = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

/* Roster CRUD */

/** Must stay identical to the key built in POST /api/session. */
const identityKey = (first: string, last: string, jersey: string | null) =>
  `${normalize(first)}|${normalize(last)}|${normalize(jersey ?? "")}`;

admin.get("/api/admin/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT *, TRIM(first_name || ' ' || last_name) AS name
       FROM users ORDER BY last_name, first_name`,
  ).all();
  return c.json({ users: results });
});

/**
 * Players normally sign themselves up; this stays for the one who cannot —
 * a broken phone, a name the team code holder needs to fix.
 */
admin.post("/api/admin/users", async (c) => {
  const b = await c.req.json<{
    first_name: string;
    last_name: string;
    jersey_number?: string;
  }>();
  const first = (b.first_name ?? "").trim();
  const last = (b.last_name ?? "").trim();
  if (!first || !last) {
    return c.json({ error: "first_name and last_name are required" }, 400);
  }
  const jersey = (b.jersey_number ?? "").trim() || null;

  const id = crypto.randomUUID();
  const r = await c.env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, jersey_number, identity_key, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(identity_key) DO NOTHING`,
  )
    .bind(id, first, last, jersey, identityKey(first, last, jersey), nowIso())
    .run();
  if (!r.meta.changes) return c.json({ error: "That player already exists" }, 409);
  return c.json({ ok: true, id });
});

admin.patch("/api/admin/users/:id", async (c) => {
  const b = await c.req.json<{
    first_name?: string;
    last_name?: string;
    jersey_number?: string;
    active?: boolean;
  }>();
  const id = c.req.param("id");

  const current = await c.env.DB.prepare(
    "SELECT first_name, last_name, jersey_number FROM users WHERE id = ?",
  )
    .bind(id)
    .first<{ first_name: string; last_name: string; jersey_number: string | null }>();
  if (!current) return c.json({ error: "Unknown player" }, 404);

  // identity_key has to be recomputed here, not just stored once at signup.
  // If an admin fixes a misspelled name and the key keeps the old spelling,
  // that player's next sign-in matches nothing, creates a second row, and
  // their play history silently splits in two.
  const first = b.first_name?.trim() || current.first_name;
  const last = b.last_name?.trim() || current.last_name;
  const jersey =
    b.jersey_number === undefined ? current.jersey_number : b.jersey_number.trim() || null;

  const r = await c.env.DB.prepare(
    `UPDATE users SET
       first_name = ?, last_name = ?, jersey_number = ?, identity_key = ?,
       active = COALESCE(?, active)
     WHERE id = ?`,
  )
    .bind(
      first,
      last,
      jersey,
      identityKey(first, last, jersey),
      b.active === undefined ? null : b.active ? 1 : 0,
      id,
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
            TRIM(u.first_name || ' ' || u.last_name) AS owner_name,
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
            TRIM(u.first_name || ' ' || u.last_name) AS dj_name
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

/* Pi remote control.

   Admin-gated because it acts on physical hardware. The allowlist is enforced
   here as well as on the Pi: a command that is not on it never reaches the
   queue, so a mistyped name fails loudly at the point of entry rather than
   sitting queued forever waiting for a Pi that will refuse it. */

admin.get("/api/admin/pi/commands", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, command, created_at, dispatched_at, completed_at, ok, result
       FROM pi_commands ORDER BY created_at DESC LIMIT 20`,
  ).all();
  return c.json({ commands: results, allowed: PI_COMMANDS });
});

admin.post("/api/admin/pi/commands", async (c) => {
  const b = await c.req.json<{ command?: string }>().catch(() => ({}) as any);
  if (!isPiCommand(b.command)) {
    return c.json({ error: `Unknown command. Allowed: ${PI_COMMANDS.join(", ")}` }, 400);
  }

  // One outstanding command at a time. Queueing three reboots because the
  // first appeared to do nothing would reboot the Pi three times.
  const outstanding = await c.env.DB.prepare(
    "SELECT id FROM pi_commands WHERE completed_at IS NULL",
  ).first<{ id: string }>();
  if (outstanding) {
    return c.json({ error: "A command is already queued or running" }, 409);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO pi_commands (id, command, created_at) VALUES (?, ?, ?)",
  )
    .bind(id, b.command, nowIso())
    .run();
  return c.json({ ok: true, id, command: b.command });
});

/* Backups. The cron runs daily; these exist so a backup can be taken before
   something risky, and so "is this actually running?" has an answer. */

admin.get("/api/admin/backups", async (c) => c.json(await listBackups(c.env)));

admin.post("/api/admin/backups", async (c) => {
  const r = await runBackup(c.env, new Date());
  return c.json(r, r.ok ? 200 : 500);
});
