/**
 * What a player does: see what is on, load a cover, vote, see the result.
 */
import { Hono } from "hono";
import type { AppEnv, Env, PlayRow } from "./types";
import { fallbackColor } from "./crypto";
import {
  isVoteWindowOpen,
  voteWindowClosesAt,
  presentablePlay,
  nowCandidate,
  NOW_CANDIDATES,
} from "./voteWindow";
import { trackScore } from "./scoring";
import { freshCountdown } from "./auxCountdown";
import { serveArt } from "./artProxy";
import { OFFLINE_AFTER_MS } from "./piControl";
import { requireSession } from "./middleware";
import { nowIso, uuid } from "./util";

export const playRoutes = new Hono<AppEnv>();

/**
 * Turn the speaker's raw aux report into something a screen can say.
 *
 * The holder is named by ROSTER NAME when their phone is claimed and by its
 * Bluetooth alias when it is not — the alias is all that exists for an
 * unclaimed phone, and "Molly's iPhone has the aux" still beats silence.
 *
 * `you_are_waiting` is the whole point of the waiting list being here. It is
 * the only way a specific player learns that the reason nothing happened is
 * them, rather than everyone reading a banner about somebody else.
 */
async function auxState(
  env: Env,
  hb: {
    last_seen_at: string;
    aux_holder_hash: string | null;
    aux_holder_alias: string | null;
    aux_waiting: string | null;
    aux_free_in_ms: number | null;
  },
  userId: string,
) {
  let waiting: { hash: string; alias: string | null }[] = [];
  try {
    waiting = hb.aux_waiting ? JSON.parse(hb.aux_waiting) : [];
  } catch {
    // Malformed JSON must not take down the whole now-playing screen for a
    // decoration. An empty list reads as "nobody waiting", which is wrong but
    // harmless, where a 500 is neither.
    waiting = [];
  }

  const ownerOf = async (hash: string | null) =>
    hash
      ? await env.DB.prepare(
          `SELECT TRIM(u.first_name || ' ' || u.last_name) AS name, u.id
             FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.mac_hash = ?`,
        )
          .bind(hash)
          .first<{ name: string; id: string }>()
      : null;

  const holderOwner = await ownerOf(hb.aux_holder_hash);

  const freeInMs = freshCountdown(hb.aux_free_in_ms, hb.last_seen_at);

  let youAreWaiting = false;
  for (const w of waiting) {
    const owner = await ownerOf(w.hash);
    if (owner?.id === userId) {
      youAreWaiting = true;
      break;
    }
  }

  return {
    // null means the aux is free — nobody is connected at all.
    holder: hb.aux_holder_hash
      ? {
          name: holderOwner?.name ?? null,
          alias: hb.aux_holder_alias,
          is_you: holderOwner?.id === userId,
          free_in_ms: freeInMs,
        }
      : null,
    waiting: waiting.length,
    you_are_waiting: youAreWaiting,
  };
}

/**
 * Album covers through our own origin, so a network that blocks the music
 * CDNs still shows them. See artProxy.ts. Not behind requireSession: the
 * coach's cover test in Admin runs without a player session, and the proxy
 * only fetches from the two image hosts the artwork lookup stores.
 */
playRoutes.get("/api/art", (c) => serveArt(c));

/**
 * THE most important rule in the spec (6.3): while the vote window is open
 * this response carries the caller's own vote and nothing else. No tallies,
 * not even hidden ones — if someone opens devtools and sees the song at -6,
 * they pile on, and the data stops measuring taste and starts measuring
 * social momentum.
 */
playRoutes.get("/api/now", requireSession, async (c) => {
  const userId = c.get("userId");

  // The newest row is only a CANDIDATE. Without presentablePlay() the last
  // song ever played stays on screen forever — production read "Now on aux:
  // Mack Vinton" on 2026-08-09 for a play that started and ended on 08-05,
  // with nobody connected to the speaker.
  //
  // The newest few rows, filtered in code (nowCandidate): skips voided rows
  // without walking the whole table after "Clear history", and ignores a play
  // stamped more than 60s in the future by a Pi with a wrong clock.
  const { results: newest } = await c.env.DB.prepare(
    `SELECT * FROM plays ORDER BY started_at DESC LIMIT ${NOW_CANDIDATES}`,
  ).all<PlayRow>();
  const play = presentablePlay(nowCandidate(newest ?? []));

  const hb = await c.env.DB.prepare(
    `SELECT last_seen_at, aux_holder_hash, aux_holder_alias, aux_waiting,
            aux_free_in_ms
       FROM heartbeats ORDER BY last_seen_at DESC LIMIT 1`,
  ).first<{
    last_seen_at: string;
    aux_holder_hash: string | null;
    aux_holder_alias: string | null;
    aux_waiting: string | null;
    aux_free_in_ms: number | null;
  }>();
  // Sent so the speaker icon can say WHEN, not just whether. "Offline" with no
  // timestamp is the least actionable thing a status light can say — two
  // minutes ago is a blip, two hours ago is a box to go and look at.
  const speakerLastSeen = hb?.last_seen_at ?? null;
  const speakerOnline = hb
    ? Date.now() - Date.parse(hb.last_seen_at) < OFFLINE_AFTER_MS
    : false;

  // Who has the aux, resolved to a person where the phone has been claimed.
  //
  // Gated on speakerOnline: this is a snapshot of a moment, and a stale one is
  // worse than none. Telling somebody "Molly has the aux" from a speaker that
  // went offline twenty minutes ago would stop them connecting for no reason.
  const aux = speakerOnline ? await auxState(c.env, hb!, userId) : null;

  const viewer = await c.env.DB.prepare(
    "SELECT id, TRIM(first_name || ' ' || last_name) AS name, jersey_number FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: string; name: string; jersey_number: string | null }>();

  if (!play) {
    // `aux` matters MOST here. This is the "Nothing playing" screen, which
    // used to tell everyone to connect over Bluetooth regardless of whether
    // somebody else was already holding the speaker — and it is the exact
    // screen a blocked player is looking at.
    return c.json({
      play: null,
      speaker_online: speakerOnline,
      speaker_last_seen: speakerLastSeen,
      viewer: viewer ?? null,
      aux,
    });
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
    speaker_last_seen: speakerLastSeen,
    // Who has the speaker. Null when it is offline or nothing has reported.
    aux,
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
      // How stale played_ms is, in ms. The Pi measured it at its last beacon,
      // which is up to a beacon interval before this response — and the client
      // was treating the reading as current, so the bar ran a steady few
      // seconds behind the phone. Sending the age lets the client correct for
      // it without either side needing a synchronised clock.
      played_ms_age_ms:
        play.played_ms != null && play.keepalive_at
          ? Math.max(0, Date.now() - Date.parse(play.keepalive_at))
          : 0,
      my_vote: myVote?.value ?? null,
      // Deliberately absent while open: up/down counts. See spec 6.3.
    },
  });
});

/* ------------------------------------------------------------------ *
 * Voting
 * ------------------------------------------------------------------ */

playRoutes.post("/api/votes", requireSession, async (c) => {
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
playRoutes.get("/api/plays/:id/results", requireSession, async (c) => {
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
