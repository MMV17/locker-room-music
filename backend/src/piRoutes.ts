/**
 * Pi -> server: plays, the legacy heartbeat, and the beacon that carries
 * liveness and remote control.
 *
 * Every route here is gated by requireDeviceKey individually rather than by a
 * prefix: /api/plays/:id/results shares the prefix and is a PLAYER route.
 */
import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { hashMac, macHint } from "./crypto";
import { trackKey } from "./trackKey";
import { lookupArtwork } from "./artwork";
import { parseScan, replaceDevices, getSelection, getForgetTarget } from "./speakers";
import { parseReport, storeReport } from "./piReports";
import { requireDeviceKey } from "./middleware";
import { nowIso, uuid } from "./util";

export const piRoutes = new Hono<AppEnv>();

/**
 * Upsert a play, creating track and device rows as needed. Idempotent: the
 * Pi retries after ambiguous timeouts and must be able to do so safely.
 */
piRoutes.post("/api/plays", requireDeviceKey, async (c) => {
  const body = await c.req.json<{
    play_id: string;
    device_mac: string;
    device_alias?: string;
    title?: string;
    artist?: string;
    album?: string;
    duration_ms?: number | null;
    started_at: string;
    incomplete?: boolean;
  }>();

  if (!body.play_id || !body.started_at) {
    return c.json({ error: "play_id and started_at are required" }, 400);
  }

  const title = (body.title ?? "").trim();
  const artist = (body.artist ?? "").trim();
  const key = trackKey(title, artist);

  // Track: dedupe on track_key so repeat plays aggregate onto one track.
  let track = await c.env.DB.prepare("SELECT id FROM tracks WHERE track_key = ?")
    .bind(key)
    .first<{ id: string }>();
  if (!track) {
    const trackId = uuid();
    await c.env.DB.prepare(
      `INSERT INTO tracks (id, track_key, title, artist, album, artwork_state)
       VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(track_key) DO NOTHING`,
    )
      .bind(trackId, key, title || "(unknown)", artist || null, body.album ?? null)
      .run();
    track = await c.env.DB.prepare("SELECT id FROM tracks WHERE track_key = ?")
      .bind(key)
      .first<{ id: string }>();
    // Artwork lookup runs after the response; never block the Pi on it.
    // The album comes from AVRCP and tells us which *release* is playing,
    // which is what disambiguates a song that appears on a single, an
    // album, a soundtrack, and three greatest-hits compilations.
    if (track) {
      c.executionCtx.waitUntil(
        lookupArtwork(c.env, track.id, title, artist, body.album ?? null),
      );
    }
  }
  if (!track) return c.json({ error: "could not resolve track" }, 500);

  // Device: store only a salted hash plus a two-octet hint.
  let deviceHash: string | null = null;
  let userId: string | null = null;
  if (body.device_mac) {
    deviceHash = await hashMac(body.device_mac, c.env.MAC_SALT);
    await c.env.DB.prepare(
      // COALESCE, not a bare overwrite: the Pi retries play writes and a
      // retry may omit the alias. Clobbering it to null would erase the
      // only human-readable handle on the device claim list.
      `INSERT INTO devices (mac_hash, mac_hint, alias, first_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(mac_hash) DO UPDATE SET
         alias = COALESCE(excluded.alias, devices.alias)`,
    )
      .bind(deviceHash, macHint(body.device_mac), body.device_alias ?? null, nowIso())
      .run();

    const owner = await c.env.DB.prepare(
      "SELECT user_id FROM devices WHERE mac_hash = ?",
    )
      .bind(deviceHash)
      .first<{ user_id: string | null }>();
    userId = owner?.user_id ?? null;
  }

  await c.env.DB.prepare(
    `INSERT INTO plays (id, track_id, device_hash, user_id, started_at, duration_ms, counted)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       track_id = excluded.track_id,
       device_hash = excluded.device_hash,
       duration_ms = excluded.duration_ms`,
  )
    .bind(
      body.play_id,
      track.id,
      deviceHash,
      userId,
      body.started_at,
      body.duration_ms ?? null,
    )
    .run();

  return c.json({ ok: true, play_id: body.play_id, track_id: track.id });
});

piRoutes.patch("/api/plays/:id", requireDeviceKey, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    ended_at?: string;
    played_ms?: number;
    counted?: boolean;
  }>();

  const result = await c.env.DB.prepare(
    `UPDATE plays SET
       ended_at = COALESCE(?, ended_at),
       played_ms = COALESCE(?, played_ms),
       counted = COALESCE(?, counted)
     WHERE id = ?`,
  )
    .bind(
      body.ended_at ?? null,
      body.played_ms ?? null,
      body.counted === undefined ? null : body.counted ? 1 : 0,
      id,
    )
    .run();

  // A close can arrive before its create if the outbox drains out of order;
  // report it rather than silently dropping the update.
  if (!result.meta.changes) return c.json({ error: "play not found" }, 404);
  return c.json({ ok: true });
});

const touchHeartbeat = (env: Env, speakerName: string) =>
  env.DB.prepare(
    `INSERT INTO heartbeats (speaker_name, last_seen_at) VALUES (?, ?)
     ON CONFLICT(speaker_name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(speakerName, nowIso())
    .run();

/** What the Pi reports about the aux. Raw MACs in, hashes only ever stored. */
interface AuxReport {
  holder?: { mac?: string; alias?: string; free_in_ms?: number | null } | null;
  waiting?: { mac?: string; alias?: string }[];
}

/**
 * Record who has the aux and who is waiting for it.
 *
 * MACs are hashed here and never stored raw, exactly as they are for a play —
 * same salt, so the hash joins straight to `devices` and therefore to a
 * person. That is what lets the site say "Mack has the aux" instead of naming
 * a phone at someone.
 *
 * Written on every beacon, including when nothing is connected: the site has
 * to be able to learn that the aux is FREE, and only a write can tell it that.
 */
async function recordAux(env: Env, speakerName: string, aux: AuxReport | undefined) {
  if (!aux) return;
  const holderHash = aux.holder?.mac
    ? await hashMac(aux.holder.mac, env.MAC_SALT)
    : null;
  const waiting = [];
  for (const w of aux.waiting ?? []) {
    if (!w?.mac) continue;
    waiting.push({ hash: await hashMac(w.mac, env.MAC_SALT), alias: w.alias ?? null });
  }
  // `?? null` rather than `|| null`: 0 is the meaningful "the aux is free
  // right now" reading, and `||` would turn it back into "no countdown".
  const freeInMs = aux.holder?.free_in_ms ?? null;
  await env.DB.prepare(
    `UPDATE heartbeats
        SET aux_holder_hash = ?, aux_holder_alias = ?, aux_waiting = ?,
            aux_free_in_ms = ?
      WHERE speaker_name = ?`,
  )
    .bind(
      holderHash,
      aux.holder?.alias ?? null,
      JSON.stringify(waiting),
      freeInMs,
      speakerName,
    )
    .run();
}

/**
 * What the box is actually playing through, and whether the chosen speaker is
 * connected.
 *
 * Stored on `heartbeats` for the same reasons the aux state is: volatile,
 * single writer, same beacon, same request, no join. Everything is nullable, so
 * a Pi running older code simply reports nothing and the screen says unknown
 * rather than showing a confident wrong answer.
 */
async function recordOutput(
  env: Env,
  speakerName: string,
  output: { kind?: string; card?: string } | undefined,
  relay: { mac?: string | null; connected?: boolean; last_error?: string | null } | undefined,
): Promise<void> {
  if (!output && !relay) return;
  await env.DB.prepare(
    `UPDATE heartbeats
        SET output_kind = ?, output_card = ?, relay_connected = ?, relay_error = ?
      WHERE speaker_name = ?`,
  )
    .bind(
      output?.kind ?? null,
      output?.card ?? null,
      relay ? (relay.connected ? 1 : 0) : null,
      relay?.last_error ?? null,
      speakerName,
    )
    .run();
}

/**
 * Superseded by /api/pi/beacon, kept because the Pi's outbox may still hold
 * unsent rows addressed here. Removing it would strand them: the drain treats
 * a 404 as non-retryable, backs off hard, and keeps the row forever.
 */
piRoutes.post("/api/heartbeat", requireDeviceKey, async (c) => {
  const body = await c.req.json<{ speaker_name?: string }>().catch(() => ({}) as any);
  await touchHeartbeat(c.env, body.speaker_name ?? "AuxGoat");
  return c.json({ ok: true });
});

/**
 * Liveness and remote control in one request. See piControl.ts for why the
 * Pi has to poll rather than be reached.
 *
 * Deliberately NOT queued in the Pi's outbox: this is a live exchange. If it
 * fails, the next one is 60 seconds away and the stale one was worthless.
 */
piRoutes.post("/api/pi/beacon", requireDeviceKey, async (c) => {
  const body = await c.req
    .json<{
      speaker_name?: string;
      result?: { id: string; ok: boolean; output?: string };
      current_play?: { id: string; status?: string; played_ms?: number };
      aux?: AuxReport;
      // What a scan found. Its own payload rather than the command result,
      // which is truncated to 2000 characters below - a room with thirty
      // phones overflows that, and a truncated device list is worse than none.
      scan?: { at?: string; devices?: unknown };
      // A diagnostic dump or a repair log. Its own payload for the same reason
      // `scan` is: the result field below is cut to 2000 characters, and a
      // truncated dump hides the line you went looking for. See piReports.ts.
      report?: { kind?: string; at?: string; body?: string; ok?: boolean };
      // Whether the chosen speaker is actually playing, and why not when it is
      // not. A selection that stores fine and then fails to connect is the
      // likeliest thing to happen in a locker room.
      relay?: { mac?: string | null; connected?: boolean; last_error?: string | null };
      // What audio-route.sh actually selected: usb, jack or relay.
      output?: { kind?: string; card?: string };
    }>()
    .catch(() => ({}) as any);

  const speakerName = body.speaker_name ?? "AuxGoat";
  await touchHeartbeat(c.env, speakerName);
  // After the heartbeat, never before: the UPDATE needs the row to exist, and
  // on a brand new speaker the very first beacon is what creates it.
  await recordAux(c.env, speakerName, body.aux);

  // The song still on the speaker. This is what keeps the vote window open
  // through a pause: without it the window closes on wall-clock time, which
  // does not stop when the music does. played_ms comes from the Pi and
  // already excludes paused time, so the site can show a bar that freezes.
  if (body.current_play?.id) {
    await c.env.DB.prepare(
      `UPDATE plays SET keepalive_at = ?, play_status = ?, played_ms = COALESCE(?, played_ms)
       WHERE id = ? AND ended_at IS NULL`,
    )
      .bind(
        nowIso(),
        body.current_play.status ?? "playing",
        body.current_play.played_ms ?? null,
        body.current_play.id,
      )
      .run();
  }

  // A scan replaces the device list wholesale. An empty result still clears
  // it: "I looked and found nothing" is a real answer, and leaving last week's
  // devices on screen would misrepresent it.
  //
  // Stamped with the SERVER's clock, not body.scan.at. The Pi has no RTC and
  // the locker room network allows outbound 443 and little else, so NTP may
  // never reach it and its clock can sit hours or days behind. The team screen
  // hides any scan older than ten minutes (isScanFresh), so a Pi-stamped scan
  // from a slow clock arrived already "stale" and every device vanished. The
  // scan is reported on the beacon straight after it runs, so arrival time is
  // the scan time to within seconds.
  if (body.scan) {
    await replaceDevices(c.env, parseScan(body.scan.devices), nowIso());
  }

  // A full diagnostic dump or a repair log, stored whole. Replaced per kind, so
  // a repair's log does not overwrite the diagnostic that justified running it.
  // Anything malformed is dropped rather than stored - parseReport is the gate.
  if (body.report) {
    const report = parseReport(body.report);
    if (report) await storeReport(c.env, report);
  }

  // What the box is actually playing through, so the admin screen can say so
  // rather than inferring it from what was selected - the two disagree exactly
  // when something is wrong, which is when it matters.
  await recordOutput(c.env, speakerName, body.output, body.relay);

  // Report on whatever we handed out last time, before taking anything new.
  if (body.result?.id) {
    await c.env.DB.prepare(
      `UPDATE pi_commands SET completed_at = ?, ok = ?, result = ?
       WHERE id = ? AND completed_at IS NULL`,
    )
      .bind(
        nowIso(),
        body.result.ok ? 1 : 0,
        (body.result.output ?? "").slice(0, 2000),
        body.result.id,
      )
      .run();
  }

  // One at a time, oldest first. Claimed by stamping dispatched_at, so a
  // command is handed out once even if the Pi beacons twice in quick
  // succession — "reboot" running twice is not what anyone asked for.
  const pending = await c.env.DB.prepare(
    `SELECT id, command FROM pi_commands
     WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 1`,
  ).first<{ id: string; command: string }>();

  // The chosen speaker rides every response, pending command or not. It is
  // STATE, not a command: the Pi reconciles what it is connected to against
  // this on each beacon, so a missed response costs one interval rather than
  // stranding a selection forever. Three values, all meaningful - see
  // speakers.ts getSelection().
  const relaySpeaker = await getSelection(c.env);

  // Which device a forget-selected-phone would remove. State, like the relay
  // speaker, and sent on every response for the same reason: the Pi validates
  // it on arrival and a missed beacon costs one interval rather than stranding
  // the instruction. Null when nothing is pending.
  const forgetDevice = await getForgetTarget(c.env);

  if (!pending) {
    return c.json({
      ok: true,
      command: null,
      relay_speaker: relaySpeaker,
      forget_device: forgetDevice,
    });
  }

  // reboot is fire-and-forget: the Pi is killed before it can report, so
  // record the outcome now rather than leaving a row that never completes.
  const isReboot = pending.command === "reboot";
  await c.env.DB.prepare(
    isReboot
      ? `UPDATE pi_commands SET dispatched_at = ?, completed_at = ?, ok = 1,
           result = 'reboot issued - the Pi cannot report back, watch for the speaker coming online'
         WHERE id = ?`
      : "UPDATE pi_commands SET dispatched_at = ? WHERE id = ?",
  )
    .bind(...(isReboot ? [nowIso(), nowIso(), pending.id] : [nowIso(), pending.id]))
    .run();

  return c.json({
    ok: true,
    command: { id: pending.id, name: pending.command },
    relay_speaker: relaySpeaker,
    forget_device: forgetDevice,
  });
});
