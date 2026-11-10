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
import type { AppEnv, Env } from "./types";
import {
  listDevices,
  getSelection,
  getSelectionName,
  setSelection,
  playerDevices,
  playerOutput,
  resolveSpeakerId,
  scrubMacs,
  speakerId,
} from "./speakers";
import { readJson } from "./http";
import { hasOutstandingCommand, queueCommand, staleCutoff } from "./piCommands";
import { putSetting } from "./settings";
import {
  mayChangeSpeaker,
  isScanFresh,
  scanProblem,
  isAudiblyPlaying,
  newestLivePlay,
} from "./speakerAccess";

export const speakerRoutes = new Hono<AppEnv>();

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
  const running = await c.env.DB.prepare(
    `SELECT dispatched_at FROM pi_commands
      WHERE command = 'scan-speakers' AND completed_at IS NULL
        AND (dispatched_at IS NULL OR dispatched_at > ?)
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(staleCutoff())
    .first<{ dispatched_at: string | null }>();

  const scannedAt = await c.env.DB.prepare(
    "SELECT MAX(scanned_at) AS at FROM bt_devices",
  ).first<{ at: string | null }>();

  // A scan older than ten minutes is not shown to the team at all. It is a
  // picker, not a record of every device name that has been near the room.
  const fresh = isScanFresh(scannedAt?.at);

  // The last scan's outcome, so a refused or failed one says why instead of
  // looking like a button that did nothing. Only while nothing newer is running.
  const lastScan = running
    ? null
    : await c.env.DB.prepare(
        `SELECT ok, result, completed_at FROM pi_commands
          WHERE command = 'scan-speakers' AND completed_at IS NOT NULL
          ORDER BY completed_at DESC LIMIT 1`,
      ).first<{ ok: number | null; result: string | null; completed_at: string | null }>();

  // NO RAW MAC leaves this handler (speakers.ts explains why): devices are
  // audio-class only and carry an opaque id, the selection is that same id,
  // and the relay's "card" (a MAC) and any MAC inside an error are withheld.
  const salt = c.env.MAC_SALT;
  return c.json({
    devices: fresh ? await playerDevices(devices, salt) : [],
    scanned_at: fresh ? scannedAt?.at : null,
    scanning: running ? (running.dispatched_at ? "scanning" : "queued") : null,
    scan_problem: scanProblem(lastScan),
    // null = never chosen, "" = wired output, otherwise the speaker's id.
    selected: selected ? await speakerId(selected, salt) : selected,
    selected_name: selectedName || null,
    output: playerOutput(hb?.output_kind, hb?.output_card),
    relay_connected: hb?.relay_connected == null ? null : hb.relay_connected === 1,
    relay_error: scrubMacs(hb?.relay_error),
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
  if (await hasOutstandingCommand(c.env)) {
    return c.json({ error: "The AuxGoat is already busy" }, 409);
  }

  // The Pi refuses to scan under a playing song (it would stutter the room).
  // Say so now, rather than after a minute of "Waiting for the AuxGoat…" that
  // ends in an empty list. Paused is fine - nothing is streaming.
  const playing = await newestLivePlay(c.env);
  if (isAudiblyPlaying(playing)) {
    return c.json(
      { error: "Pause the music first. The AuxGoat can't look for speakers while a song is playing." },
      409,
    );
  }

  const id = await queueCommand(c.env, "scan-speakers");
  return c.json({ ok: true, id });
});

speakerRoutes.put("/api/speakers", async (c) => {
  const userId = c.get("userId");
  const permission = await mayChangeSpeaker(c.env, userId);
  if (!permission.allowed) return c.json({ error: permission.reason }, 403);

  // `id` is the opaque speaker id GET /api/speakers hands out. A `null` id -
  // or a null `mac`, which is what a page loaded before this change sends for
  // "Use the cable instead" - selects wired output. A body naming neither is
  // refused rather than read as "clear": a stale page tapping "Use this" sends
  // `{}` (its devices no longer carry a MAC), and that must not silently
  // switch the room to the cable.
  type Body = { id?: unknown; mac?: unknown };
  const b: Body = (await readJson<Body>(c)) ?? {};

  if (b.id === null || (b.id === undefined && b.mac === null)) {
    await setSelection(c.env, null, null);
    await recordWhoChangedIt(c.env, userId);
    return c.json({ ok: true, selected: "" });
  }

  if (typeof b.id !== "string" || !b.id) {
    return c.json({ error: "Pick a speaker from the list. If this keeps happening, reload the page." }, 400);
  }

  // Only a device the box actually reported seeing, and only one a player may
  // see at all (audio class). Resolved to its MAC here, never by the client.
  const known = await resolveSpeakerId(await listDevices(c.env), b.id, c.env.MAC_SALT);
  if (!known) {
    return c.json({ error: "That speaker isn't in the last scan. Scan again." }, 400);
  }

  await setSelection(c.env, known.mac, known.name);
  await recordWhoChangedIt(c.env, userId);
  return c.json({ ok: true, selected: b.id, selected_name: known.name });
});

/**
 * Who moved the speaker, and when.
 *
 * Not enforcement — anyone connected may do this, by design. It is so that
 * "the music went to the wrong speaker" has an answer other than a shrug, in a
 * room where 75 people can all reach the control.
 */
async function recordWhoChangedIt(env: Env, userId: string): Promise<void> {
  await putSetting(env, "relay_speaker_set_by", userId);
}
