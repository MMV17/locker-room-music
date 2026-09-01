/**
 * Speaker selection for the team, not just the coach.
 *
 * Same underlying machinery as the Admin endpoints in admin.ts — scanning is an
 * allowlisted command, selecting writes a `settings` row that the Pi reconciles
 * against on its next beacon. What differs is the gate: these are open to any
 * player whose phone is currently connected to the box, and closed while
 * somebody else's song is playing. See speakerAccess.ts for why that is the
 * permission rather than a new code.
 *
 * The Admin versions stay ungated. A coach with the password can always take
 * the speaker back, including when nobody is connected at all — which is the
 * state the presence rule cannot help with, and the reason it is not the only
 * way in.
 */
import { Hono } from "hono";
import type { Env } from "./types";
import { isMacAddress, normaliseMac } from "./piControl";
import { listDevices, getSelection, getSelectionName, setSelection } from "./speakers";
import { mayChangeSpeaker, isScanFresh } from "./speakerAccess";

export const speakerRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

const STALE_DISPATCH_MS = 5 * 60_000;

speakerRoutes.get("/api/speakers", async (c) => {
  const userId = c.get("userId");
  const [devices, selected, selectedName, hb, permission] = await Promise.all([
    listDevices(c.env),
    getSelection(c.env),
    getSelectionName(c.env),
    c.env.DB.prepare(
      `SELECT output_kind, output_card, relay_connected, relay_error
         FROM heartbeats ORDER BY last_seen_at DESC LIMIT 1`,
    ).first<{
      output_kind: string | null;
      output_card: string | null;
      relay_connected: number | null;
      relay_error: string | null;
    }>(),
    mayChangeSpeaker(c.env, userId),
  ]);

  // Is there a scan running right now? The player needs to be told to wait
  // rather than left looking at a stale list wondering if the button worked.
  const staleCutoff = new Date(Date.now() - STALE_DISPATCH_MS).toISOString();
  const running = await c.env.DB.prepare(
    `SELECT dispatched_at FROM pi_commands
      WHERE command = 'scan-speakers' AND completed_at IS NULL
        AND (dispatched_at IS NULL OR dispatched_at > ?)
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(staleCutoff)
    .first<{ dispatched_at: string | null }>();

  const scannedAt = await c.env.DB.prepare(
    "SELECT MAX(scanned_at) AS at FROM bt_devices",
  ).first<{ at: string | null }>();

  // A scan older than ten minutes is not shown to the team at all. It is a
  // picker, not a record of every device name that has been near the room.
  const fresh = isScanFresh(scannedAt?.at);

  return c.json({
    devices: fresh ? devices : [],
    scanned_at: fresh ? scannedAt?.at : null,
    scanning: running ? (running.dispatched_at ? "scanning" : "queued") : null,
    selected,
    selected_name: selectedName || null,
    output: hb?.output_kind ? { kind: hb.output_kind, card: hb.output_card } : null,
    relay_connected: hb?.relay_connected == null ? null : hb.relay_connected === 1,
    relay_error: hb?.relay_error ?? null,
    can_change: permission.allowed,
    reason: permission.reason,
  });
});

speakerRoutes.post("/api/speakers/scan", async (c) => {
  const permission = await mayChangeSpeaker(c.env, c.get("userId"));
  if (!permission.allowed) return c.json({ error: permission.reason }, 403);

  // The same one-at-a-time rule the admin channel uses. Queueing three scans
  // because the first appeared to do nothing would occupy the radio for a
  // minute, and the radio is also carrying the music.
  const staleCutoff = new Date(Date.now() - STALE_DISPATCH_MS).toISOString();
  const outstanding = await c.env.DB.prepare(
    `SELECT id FROM pi_commands
      WHERE completed_at IS NULL
        AND (dispatched_at IS NULL OR dispatched_at > ?)`,
  )
    .bind(staleCutoff)
    .first<{ id: string }>();
  if (outstanding) return c.json({ error: "The AuxGoat is already busy" }, 409);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO pi_commands (id, command, created_at) VALUES (?, ?, ?)",
  )
    .bind(id, "scan-speakers", new Date().toISOString())
    .run();
  return c.json({ ok: true, id });
});

speakerRoutes.put("/api/speakers", async (c) => {
  const userId = c.get("userId");
  const permission = await mayChangeSpeaker(c.env, userId);
  if (!permission.allowed) return c.json({ error: permission.reason }, 403);

  type Body = { mac?: string | null; name?: string | null };
  const b = await c.req.json<Body>().catch(() => ({}) as Body);

  if (b.mac === null || b.mac === undefined) {
    await setSelection(c.env, null, null);
    await recordWhoChangedIt(c.env, userId);
    return c.json({ ok: true, selected: "" });
  }

  if (!isMacAddress(b.mac)) return c.json({ error: "That is not a MAC address" }, 400);

  // Only a device the box actually reported seeing. This is not about
  // injection — the MAC is validated and passed as an argv element either way —
  // it is about not pointing the speaker at something nobody scanned, which
  // would be a selection that can never connect and cannot be explained.
  const mac = normaliseMac(b.mac)!;
  const known = await c.env.DB.prepare("SELECT name FROM bt_devices WHERE mac = ?")
    .bind(mac)
    .first<{ name: string | null }>();
  if (!known) {
    return c.json({ error: "That speaker isn't in the last scan. Scan again." }, 400);
  }

  await setSelection(c.env, mac, known.name);
  await recordWhoChangedIt(c.env, userId);
  return c.json({ ok: true, selected: mac, selected_name: known.name });
});

/**
 * Who moved the speaker, and when.
 *
 * Not enforcement — anyone connected may do this, by design. It is so that
 * "the music went to the wrong speaker" has an answer other than a shrug, in a
 * room where 75 people can all reach the control.
 */
async function recordWhoChangedIt(env: Env, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('relay_speaker_set_by', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(userId, now)
    .run();
}
