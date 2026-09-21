import { Hono } from "hono";
import type { Env } from "./types";
import { normalize } from "./trackKey";
import { PI_COMMANDS, isPiCommand, normaliseMac, OFFLINE_AFTER_MS } from "./piControl";
import { listReports } from "./piReports";
import {
  listDevices,
  getSelection,
  getSelectionName,
  setSelection,
} from "./speakers";
import { runBackup, listBackups } from "./backup";
import { lookupArtwork } from "./artwork";
import { isVoteWindowOpen } from "./voteWindow";
import type { PlayRow } from "./types";

export const admin = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

/**
 * Re-run artwork lookup for tracks that came back empty.
 *
 * Artwork is cached forever per spec 6.4, which is right — but it means a
 * track that failed once shows a colour block for the rest of the season even
 * after the cause is fixed. "Imma Be" resolved to nothing because the artist
 * matcher could not see past a leading "The"; without this, fixing the matcher
 * would not have healed the row it broke.
 *
 * Only retries `artwork_state = 'none'`. A track that already has a cover is
 * left alone, so this can never churn a good result into a worse one.
 */
admin.post("/api/admin/artwork/retry", async (c) => {
  // `all` redoes tracks that already have a cover too. Needed after the
  // matcher itself improves: "Imma Be" was state='found' pointing at a
  // compilation, which no amount of retrying the failures would have fixed.
  const body = await c.req
    .json<{ all?: boolean }>()
    .catch((): { all?: boolean } => ({}));
  const { results } = await c.env.DB.prepare(
    body.all
      ? `SELECT id, title, artist, album FROM tracks`
      : `SELECT id, title, artist, album FROM tracks WHERE artwork_state = 'none'`,
  ).all<{ id: string; title: string; artist: string | null; album: string | null }>();

  let found = 0;
  for (const t of results) {
    await lookupArtwork(c.env, t.id, t.title, t.artist ?? "", t.album);
    const after = await c.env.DB.prepare(
      "SELECT artwork_state FROM tracks WHERE id = ?",
    )
      .bind(t.id)
      .first<{ artwork_state: string }>();
    if (after?.artwork_state === "found") found++;
  }
  return c.json({ retried: results.length, found });
});

/* Roster CRUD */

/** Must stay identical to the key built in POST /api/session. */
const identityKey = (first: string, last: string, jersey: string | null) =>
  `${normalize(first)}|${normalize(last)}|${normalize(jersey ?? "")}`;

admin.get("/api/admin/users", async (c) => {
  // The play and vote counts are not decoration: deleting a player is
  // irreversible, and the confirm has to be able to say what is about to
  // happen to their history rather than asking for a blind yes.
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, TRIM(u.first_name || ' ' || u.last_name) AS name,
            (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id) AS plays,
            (SELECT COUNT(*) FROM votes v WHERE v.user_id = u.id) AS votes
       FROM users u ORDER BY u.last_name, u.first_name`,
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

/**
 * Delete a player outright.
 *
 * Deactivating is still the right tool for someone who left the team — it
 * keeps their record and their name on the leaderboard. This is for the rows
 * that should never have existed: a typo, a duplicate, a test signup. Players
 * sign themselves up with nothing but the team code, so those accumulate.
 *
 * The songs survive. A play is a thing that happened in the room, and it stays
 * on record; it just loses its DJ and reads as "Unclaimed", exactly as it did
 * before anyone claimed the phone. Their phones go back to unclaimed too, so
 * whoever actually owns one can claim it.
 *
 * Their VOTES are deleted rather than voided, and that is forced: votes.user_id
 * is NOT NULL and references users(id), so a voided row would be left pointing
 * at a player who no longer exists. The visible effect is identical either way
 * — those votes stop counting toward every tally.
 *
 * Ordering is deliberate. Children first, parent last, so this is correct
 * whether or not foreign keys are being enforced. D1 runs a batch as one
 * transaction, so a player is never half-deleted.
 */
admin.delete("/api/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!user) return c.json({ error: "Unknown player" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM votes WHERE user_id = ?").bind(id),
    c.env.DB.prepare("UPDATE plays SET user_id = NULL WHERE user_id = ?").bind(id),
    c.env.DB.prepare(
      "UPDATE devices SET user_id = NULL, claimed_at = NULL WHERE user_id = ?",
    ).bind(id),
    // Signs them out everywhere. Without this their phone keeps a valid
    // session cookie pointing at a user row that is gone, and every request
    // it makes 401s in a way that looks like a bug rather than a deletion.
    c.env.DB.prepare("DELETE FROM device_tokens WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
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
  // `total` is every play on record, not the 50 below. The clear-history
  // confirm has to name how many songs it is about to void, and naming 50
  // when it means 300 is worse than saying nothing.
  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM plays WHERE voided = 0",
  ).first<{ n: number }>();
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
  return c.json({ plays: results, total: total?.n ?? 0 });
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

/**
 * Delete a phone.
 *
 * For clearing out rows that are noise — a visitor's phone, a laptop that
 * paired once, a duplicate from before a MAC_SALT change. The songs it played
 * stay in history, but they lose the phone they came from, which means an
 * unclaimed one can never be claimed afterwards: claiming works by picking
 * your phone off the list, and there is nothing else tying a play to a person.
 * The UI says so before asking.
 *
 * This is not a way to stop a phone being tracked. The Pi re-creates the row
 * from its MAC hash the next time that phone plays anything.
 */
admin.delete("/api/admin/devices/:hash", async (c) => {
  const hash = c.req.param("hash");
  const device = await c.env.DB.prepare("SELECT mac_hash FROM devices WHERE mac_hash = ?")
    .bind(hash)
    .first<{ mac_hash: string }>();
  if (!device) return c.json({ error: "Unknown device" }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE plays SET device_hash = NULL WHERE device_hash = ?").bind(hash),
    c.env.DB.prepare("DELETE FROM devices WHERE mac_hash = ?").bind(hash),
  ]);
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

/**
 * Void every song on record at once.
 *
 * For the end of a test run or the start of a season: the leaderboards are
 * cumulative, so a week of experiments would otherwise sit on top of the first
 * real one forever.
 *
 * Voids rather than deletes, like every other corrective action here — a
 * season of data is not reproducible, and a voided row drops out of every
 * ranking while staying on disk. Nothing in the UI un-voids, but the rows are
 * all still there if it ever needs to be undone by hand.
 *
 * A play still on the speaker is deliberately spared. "History" is what has
 * finished; voiding the song currently playing would pull it out from under a
 * room that is mid-vote on it, which is a confusing way to lose a song.
 */
admin.post("/api/admin/plays/void-all", async (c) => {
  // "Still on the speaker" is isVoteWindowOpen, NOT `ended_at IS NULL`.
  //
  // That distinction is the whole correctness of this endpoint. A play the Pi
  // opened and never closed — killed by a listener restart mid-song, so the
  // close never reached the outbox — also has a null ended_at, and production
  // had six of them, the oldest five days old.
  //
  // Sparing those was worse than cosmetic. /api/history requires ended_at, so
  // they were invisible; but `counted` DEFAULTS to 1, and the leaderboards
  // filter on `counted = 1 AND voided = 0`, so they had been quietly inflating
  // DJ play counts and dragging track scores down with zero votes the whole
  // time. Clearing history has to reach them, and now does.
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM plays WHERE voided = 0",
  ).all<PlayRow>();
  const live = results.filter((p) => isVoteWindowOpen(p));
  const liveIds = live.map((p) => p.id);

  // Usually zero or one id, so the NOT IN stays tiny. Built with placeholders
  // rather than interpolation — these are database values, not literals.
  const holes = liveIds.map(() => "?").join(",");
  const sql = liveIds.length
    ? `UPDATE plays SET voided = 1 WHERE voided = 0 AND id NOT IN (${holes})`
    : "UPDATE plays SET voided = 1 WHERE voided = 0";
  const r = await c.env.DB.prepare(sql)
    .bind(...liveIds)
    .run();

  return c.json({ ok: true, voided: r.meta.changes ?? 0, spared: liveIds.length });
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

/**
 * A dispatched command that has not reported back within this long is treated
 * as finished for queueing purposes. `reboot` never reports - the Pi is gone
 * before it can - so without this the first reboot would block every command
 * that followed it.
 */
const STALE_DISPATCH_MS = 5 * 60_000;

admin.get("/api/admin/pi/commands", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, command, created_at, dispatched_at, completed_at, ok, result
       FROM pi_commands ORDER BY created_at DESC LIMIT 20`,
  ).all();
  return c.json({ commands: results, allowed: PI_COMMANDS });
});

/**
 * The long-form output `report-full` and `run-repair` send up.
 *
 * Separate from /pi/commands because it is separate storage, for the reason
 * migration 007 records: a diagnostic dump does not fit in the 2000 characters
 * `pi_commands.result` keeps, and cutting it loses precisely the line that was
 * worth collecting.
 */
admin.get("/api/admin/pi/reports", async (c) => {
  return c.json({ reports: await listReports(c.env) });
});

admin.post("/api/admin/pi/commands", async (c) => {
  const b = await c.req.json<{ command?: string }>().catch(() => ({}) as any);
  if (!isPiCommand(b.command)) {
    return c.json({ error: `Unknown command. Allowed: ${PI_COMMANDS.join(", ")}` }, 400);
  }

  // One outstanding command at a time. Queueing three reboots because the
  // first appeared to do nothing would reboot the Pi three times.
  //
  // "Outstanding" excludes commands dispatched long ago and never reported.
  // Without that escape hatch a Pi that died mid-command would block the
  // queue forever - and `reboot` does exactly that every single time, because
  // the process is killed before it can report back. One reboot used to
  // wedge remote control permanently.
  const staleCutoff = new Date(Date.now() - STALE_DISPATCH_MS).toISOString();
  const outstanding = await c.env.DB.prepare(
    `SELECT id FROM pi_commands
      WHERE completed_at IS NULL
        AND (dispatched_at IS NULL OR dispatched_at > ?)`,
  )
    .bind(staleCutoff)
    .first<{ id: string }>();
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

/* The relay speaker: what the box plays OUT through.

   Read the design before changing the shape of this: choosing a speaker is
   deliberately NOT a parameterised command. `pi_commands` maps a fixed name to
   a fixed argv on both ends, and an argument column is the first crack in the
   property its schema comment is protecting. Scanning is an action that takes
   no parameters, so it is just another allowlisted name; the chosen MAC is
   state and rides the beacon response instead.

   docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md */

admin.get("/api/admin/pi/speakers", async (c) => {
  const [devices, selected, selectedName, hb] = await Promise.all([
    listDevices(c.env),
    getSelection(c.env),
    getSelectionName(c.env),
    c.env.DB.prepare(
      `SELECT output_kind, output_card, relay_connected, relay_error, last_seen_at
         FROM heartbeats ORDER BY last_seen_at DESC LIMIT 1`,
    ).first<{
      output_kind: string | null;
      output_card: string | null;
      relay_connected: number | null;
      relay_error: string | null;
      last_seen_at: string;
    }>(),
  ]);

  return c.json({
    devices,
    // "" is a real answer meaning "wired output, deliberately". The UI has to
    // be able to tell it from "never chosen", which is null.
    selected,
    selected_name: selectedName || null,
    output: hb?.output_kind
      ? { kind: hb.output_kind, card: hb.output_card }
      : null,
    relay_connected: hb?.relay_connected === null ? null : hb?.relay_connected === 1,
    relay_error: hb?.relay_error ?? null,
    speaker_online: hb ? Date.now() - Date.parse(hb.last_seen_at) < OFFLINE_AFTER_MS : false,
  });
});

admin.put("/api/admin/pi/speakers", async (c) => {
  type Body = { mac?: string | null; name?: string | null };
  const b = await c.req.json<Body>().catch(() => ({}) as Body);

  // null clears the selection: wired output. Stored as "" rather than by
  // deleting the row, because a deleted row means "never configured" and the
  // Pi would fall back to config.toml and turn the speaker straight back on.
  if (b.mac === null || b.mac === undefined) {
    await setSelection(c.env, null, null);
    return c.json({ ok: true, selected: "", selected_name: null });
  }

  const mac = normaliseMac(b.mac);
  if (!mac) {
    // Validated here AND again on the Pi. This value becomes an argv element
    // for bluetoothctl, and neither gate is redundant: this one keeps junk out
    // of the database, the Pi's keeps a compromised server from being the only
    // thing between a locker room speaker and a subprocess.
    return c.json({ error: "That is not a MAC address" }, 400);
  }

  const name =
    typeof b.name === "string" && b.name.trim() !== ""
      ? b.name.trim().slice(0, 64)
      : null;
  await setSelection(c.env, mac, name);

  // Deliberately no command is queued. The Pi reconciles against this on its
  // next beacon - which is seconds away, because picking a speaker means a
  // scan was just run and the box is in attentive mode.
  return c.json({ ok: true, selected: mac, selected_name: name });
});

/* Backups. The cron runs daily; these exist so a backup can be taken before
   something risky, and so "is this actually running?" has an answer. */

admin.get("/api/admin/backups", async (c) => c.json(await listBackups(c.env)));

admin.post("/api/admin/backups", async (c) => {
  const r = await runBackup(c.env, new Date());
  return c.json(r, r.ok ? 200 : 500);
});
