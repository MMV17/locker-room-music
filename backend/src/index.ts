import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, PlayRow } from "./types";
import {
  hashMac,
  macHint,
  hashToken,
  newToken,
  safeEqual,
  normalizeTeamCode,
  fallbackColor,
} from "./crypto";
import { trackKey, normalize } from "./trackKey";
import { isVoteWindowOpen, voteWindowClosesAt } from "./voteWindow";
import { trackScore } from "./scoring";
import { lookupArtwork } from "./artwork";
import { boards } from "./leaderboards";
import { devices } from "./devices";
import { admin } from "./admin";
import { theme } from "./theme";
import { runBackup } from "./backup";

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/**
 * Bare-domain redirect. Temporary scaffolding for beta: the URL gets said out
 * loud in a loud room, and people type "auxgoat.com" without the school in
 * front of it. Without this they get "server cannot be found" and give up.
 *
 * 302, deliberately, NOT 301. This is meant to be removed once a second
 * school exists and the apex becomes a landing page that does not favour any
 * one team. A 301 is cached by browsers effectively forever, so every phone
 * that ever hit the apex would keep bouncing to Holy Cross long after the
 * rule was deleted, with no way to fix it from the server side.
 *
 * Registered before every other route so it runs first.
 */
const BARE_HOSTS = new Set(["auxgoat.com", "www.auxgoat.com"]);
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (BARE_HOSTS.has(url.hostname)) {
    url.hostname = "hc.auxgoat.com";
    return c.redirect(url.toString(), 302);
  }
  await next();
});

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/** Pi -> server. Shared secret in X-Device-Key. */
const requireDeviceKey = async (c: any, next: any) => {
  const key = c.req.header("X-Device-Key") ?? "";
  if (!c.env.DEVICE_KEY || !safeEqual(key, c.env.DEVICE_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

/** Teammate session, established by POST /api/session. */
const requireSession = async (c: any, next: any) => {
  const token = getCookie(c, "lr_token");
  if (!token) return c.json({ error: "Not signed in" }, 401);

  const db: D1Database = c.env.DB;
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare("SELECT user_id FROM device_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ user_id: string }>();
  if (!row) return c.json({ error: "Not signed in" }, 401);

  c.set("userId", row.user_id);
  await db
    .prepare("UPDATE device_tokens SET last_seen_at = ? WHERE token_hash = ?")
    .bind(nowIso(), tokenHash)
    .run();
  await next();
};

const requireAdmin = async (c: any, next: any) => {
  const pw = c.req.header("X-Admin-Password") ?? "";
  if (!c.env.ADMIN_PASSWORD || !safeEqual(pw, c.env.ADMIN_PASSWORD)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

/* ------------------------------------------------------------------ *
 * Pi -> server
 * ------------------------------------------------------------------ */

/**
 * Upsert a play, creating track and device rows as needed. Idempotent: the
 * Pi retries after ambiguous timeouts and must be able to do so safely.
 */
app.post("/api/plays", requireDeviceKey, async (c) => {
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

app.patch("/api/plays/:id", requireDeviceKey, async (c) => {
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

/**
 * Superseded by /api/pi/beacon, kept because the Pi's outbox may still hold
 * unsent rows addressed here. Removing it would strand them: the drain treats
 * a 404 as non-retryable, backs off hard, and keeps the row forever.
 */
app.post("/api/heartbeat", requireDeviceKey, async (c) => {
  const body = await c.req.json<{ speaker_name?: string }>().catch(() => ({}) as any);
  await touchHeartbeat(c.env, body.speaker_name ?? "Locker Room Speaker");
  return c.json({ ok: true });
});

/**
 * Liveness and remote control in one request. See piControl.ts for why the
 * Pi has to poll rather than be reached.
 *
 * Deliberately NOT queued in the Pi's outbox: this is a live exchange. If it
 * fails, the next one is 60 seconds away and the stale one was worthless.
 */
app.post("/api/pi/beacon", requireDeviceKey, async (c) => {
  const body = await c.req
    .json<{
      speaker_name?: string;
      result?: { id: string; ok: boolean; output?: string };
      current_play?: { id: string; status?: string; played_ms?: number };
    }>()
    .catch(() => ({}) as any);

  await touchHeartbeat(c.env, body.speaker_name ?? "Locker Room Speaker");

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

  if (!pending) return c.json({ ok: true, command: null });

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

  return c.json({ ok: true, command: { id: pending.id, name: pending.command } });
});

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

/**
 * Sign up / sign in. Players enter their own name and number behind the team
 * code; there is no admin-curated roster.
 *
 * The trade this makes, stated plainly: the team code is the only gate, so
 * anyone holding it can register under any name, including a teammate's. The
 * admin screen can deactivate a bad row after the fact. That was accepted as
 * the price of not making someone maintain a hundred-player roster by hand.
 *
 * Idempotent on identity. Re-running this with the same name and number
 * returns the SAME user rather than making a new one — otherwise clearing
 * cookies or switching phones would split a player's history across two rows
 * and quietly halve their DJ score.
 */
app.post("/api/session", async (c) => {
  const body = await c.req.json<{
    team_code: string;
    first_name: string;
    last_name: string;
    jersey_number?: string;
  }>();
  // Matched case-insensitively and whitespace-trimmed — see normalizeTeamCode.
  if (
    !safeEqual(
      normalizeTeamCode(body.team_code ?? ""),
      normalizeTeamCode(c.env.TEAM_CODE),
    )
  ) {
    return c.json({ error: "Wrong team code" }, 403);
  }

  const first = (body.first_name ?? "").trim();
  const last = (body.last_name ?? "").trim();
  const jersey = (body.jersey_number ?? "").trim();
  if (!first || !last) {
    return c.json({ error: "First and last name are required" }, 400);
  }

  const identityKey = `${normalize(first)}|${normalize(last)}|${normalize(jersey)}`;

  await c.env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, jersey_number, identity_key, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(identity_key) DO NOTHING`,
  )
    .bind(uuid(), first, last, jersey || null, identityKey, nowIso())
    .run();

  const user = await c.env.DB.prepare(
    "SELECT id, first_name, last_name, active FROM users WHERE identity_key = ?",
  )
    .bind(identityKey)
    .first<{ id: string; first_name: string; last_name: string; active: number }>();
  if (!user) return c.json({ error: "Could not create player" }, 500);

  // Deactivated by an admin — reactivating on a fresh signup would make the
  // admin's only corrective tool useless.
  if (!user.active) {
    return c.json({ error: "This player has been removed by an admin" }, 403);
  }

  const token = newToken();
  await c.env.DB.prepare(
    "INSERT INTO device_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)",
  )
    .bind(await hashToken(token), user.id, nowIso())
    .run();

  setCookie(c, "lr_token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return c.json({
    ok: true,
    user: { id: user.id, name: `${user.first_name} ${user.last_name}`.trim() },
  });
});

/**
 * Composed server-side so `name` stays the shape every consumer already
 * expects — leaderboards, now-playing, and the claim list all read it.
 *
 * Session-gated: nothing on the join path needs it any more now that players
 * type their own name, so there is no reason to let an unauthenticated caller
 * enumerate the team.
 */
app.get("/api/roster", requireSession, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, TRIM(first_name || ' ' || last_name) AS name, first_name, last_name, jersey_number
       FROM users WHERE active = 1 ORDER BY last_name, first_name`,
  ).all();
  return c.json({ users: results });
});

/* ------------------------------------------------------------------ *
 * Now playing
 * ------------------------------------------------------------------ */

/**
 * THE most important rule in the spec (6.3): while the vote window is open
 * this response carries the caller's own vote and nothing else. No tallies,
 * not even hidden ones — if someone opens devtools and sees the song at -6,
 * they pile on, and the data stops measuring taste and starts measuring
 * social momentum.
 */
app.get("/api/now", requireSession, async (c) => {
  const userId = c.get("userId");

  const play = await c.env.DB.prepare(
    `SELECT * FROM plays WHERE voided = 0 ORDER BY started_at DESC LIMIT 1`,
  ).first<PlayRow>();

  const hb = await c.env.DB.prepare(
    "SELECT last_seen_at FROM heartbeats ORDER BY last_seen_at DESC LIMIT 1",
  ).first<{ last_seen_at: string }>();
  const speakerOnline = hb
    ? Date.now() - Date.parse(hb.last_seen_at) < 3 * 60_000
    : false;

  const viewer = await c.env.DB.prepare(
    "SELECT id, TRIM(first_name || ' ' || last_name) AS name, jersey_number FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: string; name: string; jersey_number: string | null }>();

  if (!play) {
    return c.json({ play: null, speaker_online: speakerOnline, viewer: viewer ?? null });
  }

  const track = await c.env.DB.prepare("SELECT * FROM tracks WHERE id = ?")
    .bind(play.track_id)
    .first<any>();

  const dj = play.user_id
    ? await c.env.DB.prepare(
        "SELECT id, TRIM(first_name || ' ' || last_name) AS name, jersey_number FROM users WHERE id = ?",
      )
        .bind(play.user_id)
        .first<any>()
    : null;

  const myVote = await c.env.DB.prepare(
    "SELECT value FROM votes WHERE play_id = ? AND user_id = ? AND voided = 0",
  )
    .bind(play.id, userId)
    .first<{ value: number }>();

  // Only when nobody owns the device: the claim screen needs something a
  // human can recognise their own phone by. Both fields are already
  // non-identifying - the hint is two octets (spec 6.1).
  const unclaimed = !play.user_id && !!play.device_hash;
  const device = unclaimed
    ? await c.env.DB.prepare("SELECT mac_hash, mac_hint, alias FROM devices WHERE mac_hash = ?")
        .bind(play.device_hash)
        .first<{ mac_hash: string; mac_hint: string; alias: string | null }>()
    : null;

  const open = isVoteWindowOpen(play);

  return c.json({
    speaker_online: speakerOnline,
    // Who the caller is. The client cannot work this out on its own, and it
    // needs it for both the DJ state below and the switch-user affordance.
    viewer: viewer
      ? { id: viewer.id, name: viewer.name, jersey_number: viewer.jersey_number }
      : null,
    play: {
      id: play.id,
      started_at: play.started_at,
      ended_at: play.ended_at,
      duration_ms: play.duration_ms,
      title: track?.title ?? "(unknown)",
      artist: track?.artist ?? null,
      album: track?.album ?? null,
      artwork_url: track?.artwork_url ?? null,
      artwork_fallback: fallbackColor(track?.track_key ?? ""),
      dj: dj ? { id: dj.id, name: dj.name, jersey_number: dj.jersey_number } : null,
      device_unclaimed: unclaimed,
      device: device
        ? { mac_hash: device.mac_hash, mac_hint: device.mac_hint, alias: device.alias }
        : null,
      // The DJ cannot vote on their own song (see POST /api/votes). The client
      // shows their standing where the vote controls would be.
      i_am_dj: play.user_id === userId,
      vote_window_open: open,
      vote_closes_at: new Date(voteWindowClosesAt(play)).toISOString(),
      // 'paused' freezes the progress bar. Without this the client
      // interpolates from started_at against the wall clock and counts
      // straight through a pause.
      play_status: play.play_status ?? "playing",
      played_ms: play.played_ms ?? null,
      my_vote: myVote?.value ?? null,
      // Deliberately absent while open: up/down counts. See spec 6.3.
    },
  });
});

/* ------------------------------------------------------------------ *
 * Voting
 * ------------------------------------------------------------------ */

app.post("/api/votes", requireSession, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ play_id: string; value: number }>();

  if (body.value !== 1 && body.value !== -1) {
    return c.json({ error: "Vote must be 1 or -1" }, 400);
  }

  const play = await c.env.DB.prepare("SELECT * FROM plays WHERE id = ?")
    .bind(body.play_id)
    .first<PlayRow>();
  if (!play) return c.json({ error: "Unknown song" }, 404);

  // A DJ rating their own song is padding their own leaderboard position.
  // Enforced here rather than only in the UI - the client hiding the controls
  // is the visible half of this rule, not the rule itself.
  if (play.user_id && play.user_id === userId) {
    return c.json({ error: "You can't rate your own song" }, 403);
  }

  // Server-enforced, no exceptions.
  if (!isVoteWindowOpen(play)) {
    return c.json({ error: "Voting closed for this song" }, 409);
  }

  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO votes (id, play_id, user_id, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(play_id, user_id) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind(uuid(), body.play_id, userId, body.value, ts, ts)
    .run();

  return c.json({ ok: true, my_vote: body.value });
});

/** Tallies. 403 while the window is still open. */
app.get("/api/plays/:id/results", requireSession, async (c) => {
  const play = await c.env.DB.prepare("SELECT * FROM plays WHERE id = ?")
    .bind(c.req.param("id"))
    .first<PlayRow>();
  if (!play) return c.json({ error: "Unknown song" }, 404);

  if (isVoteWindowOpen(play)) {
    return c.json({ error: "Voting is still open for this song" }, 403);
  }

  const tally = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END)  AS up,
       SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down
     FROM votes WHERE play_id = ? AND voided = 0`,
  )
    .bind(play.id)
    .first<{ up: number | null; down: number | null }>();

  const up = tally?.up ?? 0;
  const down = tally?.down ?? 0;
  const track = await c.env.DB.prepare("SELECT title, artist FROM tracks WHERE id = ?")
    .bind(play.track_id)
    .first<any>();

  return c.json({
    play_id: play.id,
    title: track?.title,
    artist: track?.artist,
    upvotes: up,
    downvotes: down,
    voters: up + down,
    score: trackScore(up, down),
    counted: !!play.counted,
  });
});

/* ------------------------------------------------------------------ *
 * Mounted sub-apps
 * ------------------------------------------------------------------ */

app.use("/api/leaderboard/*", requireSession);
app.use("/api/history", requireSession);
app.use("/api/me/*", requireSession);
app.route("/", boards);

app.use("/api/devices/*", requireSession);
app.route("/", devices);

app.use("/api/admin/*", requireAdmin);
app.route("/", admin);

// GET /api/theme is public (the join screen is branded before anyone signs
// in); PUT /api/admin/theme is covered by the requireAdmin middleware above,
// which is why this is mounted after it.
app.route("/", theme);

app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "Something went wrong" }, 500);
});

/* ------------------------------------------------------------------ *
 * Static site
 * ------------------------------------------------------------------ */

/**
 * Client-side routes (/songs, /djs, /admin, ...) have no matching file, so
 * they fall through to here and get the app shell.
 *
 * This must stay at the very bottom: it matches everything, and anything
 * registered after it would be unreachable. An unknown /api path is answered
 * as JSON instead - handing a caller of a mistyped endpoint a page of HTML
 * with a 200 on it is worse than useless when debugging the Pi.
 *
 * Real asset requests never reach this handler at all. wrangler.toml sets
 * not_found_handling = "none", so the assets runtime serves matching files
 * itself and only forwards misses.
 */
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
});

/**
 * Hono handles fetch; the cron trigger needs its own entry point, so the
 * default export becomes an object rather than the app itself.
 */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runBackup(env, new Date()).then((r) => {
        // Logged either way: a backup that quietly stopped running is worse
        // than one that never existed, because it looks like insurance.
        if (r.ok) console.log(`backup ok key=${r.key} bytes=${r.bytes} rows=${r.rows} pruned=${r.pruned}`);
        else console.error(`backup FAILED: ${r.error}`);
      }),
    );
  },
};
