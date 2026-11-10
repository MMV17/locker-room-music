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
import { DISPATCH_SQL, REBOOT_COMPLETE_SQL } from "./piCommands";
import { readJson, badJson } from "./http";
import { nowIso, uuid } from "./util";
import {
  HEARTBEAT_UPSERT_SQL,
  HEARTBEAT_TOUCH_SQL,
  KEEPALIVE_SQL,
  heartbeatParams,
  heartbeatTouchParams,
  keepaliveParams,
  cleanText,
  intOrNull,
  speakerNameFrom,
  MAX_ALIAS,
  MAX_SHORT_FIELD,
  MAX_ERROR_TEXT,
} from "./beacon";
import type { AuxWrite, OutputWrite } from "./beacon";

export const piRoutes = new Hono<AppEnv>();

/**
 * Upsert a play, creating track and device rows as needed. Idempotent: the
 * Pi retries after ambiguous timeouts and must be able to do so safely.
 */
piRoutes.post("/api/plays", requireDeviceKey, async (c) => {
  const body = await readJson<{
    play_id: string;
    device_mac: string;
    device_alias?: string;
    title?: string;
    artist?: string;
    album?: string;
    duration_ms?: number | null;
    started_at: string;
    incomplete?: boolean;
  }>(c);
  if (!body) return badJson(c);

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

/**
 * The Pi closing a play. COALESCE, so a field the Pi omits keeps its value -
 * and a field it sends always wins, including over the values the orphan
 * sweep (maintenance.ts) closed a forgotten play with.
 */
export const PLAY_PATCH_SQL = `UPDATE plays SET
       ended_at = COALESCE(?, ended_at),
       played_ms = COALESCE(?, played_ms),
       counted = COALESCE(?, counted)
     WHERE id = ?`;

piRoutes.patch("/api/plays/:id", requireDeviceKey, async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{
    ended_at?: string;
    played_ms?: number;
    counted?: boolean;
  }>(c);
  if (!body) return badJson(c);

  const result = await c.env.DB.prepare(PLAY_PATCH_SQL)
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

/** What the Pi reports about the aux. Raw MACs in, hashes only ever stored. */
interface AuxReport {
  holder?: { mac?: string; alias?: string; free_in_ms?: number | null } | null;
  waiting?: { mac?: string; alias?: string }[];
}

/**
 * Who has the aux and who is waiting for it, as the columns store it.
 *
 * MACs are hashed here and never stored raw, exactly as they are for a play —
 * same salt, so the hash joins straight to `devices` and therefore to a
 * person. That is what lets the site say "Mack has the aux" instead of naming
 * a phone at someone.
 *
 * Reported on every beacon, including when nothing is connected: the site has
 * to be able to learn that the aux is FREE. Whether that costs a write is
 * decided in beacon.ts - only when something changed.
 */
async function auxColumns(env: Env, aux: AuxReport | undefined): Promise<AuxWrite | undefined> {
  if (!aux || typeof aux !== "object") return undefined;
  const holderHash = typeof aux.holder?.mac === "string" && aux.holder.mac
    ? await hashMac(aux.holder.mac, env.MAC_SALT)
    : null;
  const waiting = [];
  for (const w of Array.isArray(aux.waiting) ? aux.waiting : []) {
    if (typeof w?.mac !== "string" || !w.mac) continue;
    waiting.push({ hash: await hashMac(w.mac, env.MAC_SALT), alias: cleanText(w.alias, MAX_ALIAS) });
    if (waiting.length >= 16) break;
  }
  // `?? null` rather than `|| null`: 0 is the meaningful "the aux is free
  // right now" reading, and `||` would turn it back into "no countdown".
  const free = aux.holder?.free_in_ms;
  return {
    holderHash,
    holderAlias: cleanText(aux.holder?.alias, MAX_ALIAS),
    waitingJson: JSON.stringify(waiting),
    freeInMs: typeof free === "number" && Number.isFinite(free) ? Math.trunc(free) : null,
  };
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
function outputColumns(
  output: { kind?: string; card?: string } | undefined,
  relay: { mac?: string | null; connected?: boolean; last_error?: string | null } | undefined,
): OutputWrite | undefined {
  if (!output && !relay) return undefined;
  return {
    kind: cleanText(output?.kind, MAX_SHORT_FIELD),
    card: cleanText(output?.card, MAX_ALIAS),
    relayConnected: relay ? (relay.connected ? 1 : 0) : null,
    relayError: cleanText(relay?.last_error, MAX_ERROR_TEXT),
  };
}

/**
 * Superseded by /api/pi/beacon, kept because the Pi's outbox may still hold
 * unsent rows addressed here. Removing it would strand them: the drain treats
 * a 404 as non-retryable, backs off hard, and keeps the row forever.
 */
piRoutes.post("/api/heartbeat", requireDeviceKey, async (c) => {
  const body = (await readJson<{ speaker_name?: unknown }>(c)) ?? {};
  const now = nowIso();
  await c.env.DB.prepare(HEARTBEAT_TOUCH_SQL)
    .bind(...heartbeatTouchParams(speakerNameFrom(body?.speaker_name), now))
    .run();
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
  const body =
    (await readJson<{
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
    }>(c)) ?? {};

  // Bounded and cleaned, never rejected (beacon.ts): old listeners must keep
  // working, and unknown keys are simply ignored.
  const speakerName = speakerNameFrom(body.speaker_name);
  const now = nowIso();
  // Liveness, the aux and the output in ONE conditional upsert that writes
  // nothing when nothing changed. See beacon.ts for what forces a write.
  await c.env.DB.prepare(HEARTBEAT_UPSERT_SQL)
    .bind(
      ...heartbeatParams({
        speakerName,
        now,
        aux: await auxColumns(c.env, body.aux),
        output: outputColumns(body.output, body.relay),
      }),
    )
    .run();

  // The song still on the speaker. This is what keeps the vote window open
  // through a pause: without it the window closes on wall-clock time, which
  // does not stop when the music does. played_ms comes from the Pi and
  // already excludes paused time, so the site can show a bar that freezes.
  //
  // Throttled in SQL (beacon.ts): a write only on a status flip, a seek, or a
  // keepalive older than 30s.
  const playId = cleanText(body.current_play?.id, 64);
  if (playId) {
    await c.env.DB.prepare(KEEPALIVE_SQL)
      .bind(
        ...keepaliveParams(
          playId,
          cleanText(body.current_play?.status, MAX_SHORT_FIELD) ?? "playing",
          intOrNull(body.current_play?.played_ms),
          now,
        ),
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

  // Report on whatever we handed out last time, before taking anything new.
  if (typeof body.result?.id === "string" && body.result.id) {
    await c.env.DB.prepare(
      `UPDATE pi_commands SET completed_at = ?, ok = ?, result = ?
       WHERE id = ? AND completed_at IS NULL`,
    )
      .bind(
        nowIso(),
        body.result.ok ? 1 : 0,
        (typeof body.result.output === "string" ? body.result.output : "").slice(0, 2000),
        body.result.id,
      )
      .run();
  }

  // One at a time, oldest first, claimed atomically (piCommands.ts), so a
  // command is handed out once even if the Pi beacons twice in quick
  // succession — "reboot" running twice is not what anyone asked for.
  const pending = await c.env.DB.prepare(DISPATCH_SQL)
    .bind(now)
    .first<{ id: string; command: string }>();

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
  if (pending.command === "reboot") {
    await c.env.DB.prepare(REBOOT_COMPLETE_SQL).bind(now, pending.id).run();
  }

  return c.json({
    ok: true,
    command: { id: pending.id, name: pending.command },
    relay_speaker: relaySpeaker,
    forget_device: forgetDevice,
  });
});
