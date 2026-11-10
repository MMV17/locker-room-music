import type { PlayRow } from "./types";

/**
 * The only columns the vote-window rule actually reads.
 *
 * PlayRow satisfies this structurally, so every existing caller is unaffected.
 * It exists so the leaderboard queries - which select per-play window columns
 * alongside track and DJ fields, and never build a whole PlayRow - can ask the
 * same question rather than re-deriving the rule in SQL.
 */
export type VoteWindowPlay = Pick<
  PlayRow,
  "started_at" | "ended_at" | "duration_ms" | "voided" | "keepalive_at"
>;

/** Grace after a play ends, for sync lag and slow thumbs (spec 6.3). */
export const VOTE_GRACE_MS = 30_000;

/**
 * How stale the Pi's keepalive may be before we stop believing the song is
 * still on the speaker. The beacon runs every 60s, so this allows one missed
 * beacon plus margin.
 */
export const KEEPALIVE_STALE_MS = 150_000;

/**
 * When voting on a play closes.
 *
 * Primary: ended_at + grace.
 *
 * While the play is still open, the Pi's beacon keeps stamping keepalive_at.
 * A song that is PAUSED is still on the speaker and still deserves an open
 * vote window - so as long as that stamp is fresh, the window stays open.
 * This is the fix for a real bug: the old fallback below runs on wall-clock
 * time, which keeps ticking through a pause, and voting on "POWER" expired
 * while the track sat paused mid-song.
 *
 * The wall-clock fallback still applies once the Pi goes quiet - it is what
 * stops a window hanging open forever when the Pi dies mid-song, which is
 * what spec 6.3 wrote it for.
 */
export function voteWindowClosesAt(play: VoteWindowPlay, now: number = Date.now()): number {
  if (play.ended_at) {
    return Date.parse(play.ended_at) + VOTE_GRACE_MS;
  }

  const started = Date.parse(play.started_at);
  const duration = play.duration_ms ?? 0;
  const wallClockFallback = started + duration + VOTE_GRACE_MS;

  if (play.keepalive_at) {
    const seen = Date.parse(play.keepalive_at);
    if (now - seen < KEEPALIVE_STALE_MS) {
      // Still live. Hold the window open, rolling forward with each beacon.
      return Math.max(wallClockFallback, seen + KEEPALIVE_STALE_MS + VOTE_GRACE_MS);
    }
  }
  return wallClockFallback;
}

export function isVoteWindowOpen(play: VoteWindowPlay, now: number = Date.now()): boolean {
  if (play.voided) return false;
  return now < voteWindowClosesAt(play, now);
}

/**
 * Whether this play's votes may appear in a public aggregate.
 *
 * Spec 6.3 in one place. Every endpoint that publishes a derivative of vote
 * data - the track board, the DJ board, history - asks this and nothing else,
 * so the rule cannot drift apart between them again. It did: the boards
 * filtered on `counted = 1 AND voided = 0`, and `counted` DEFAULTS to 1 at
 * INSERT, so a song still on the speaker was already being published. See
 * test/tallyVisibility.test.ts for the arithmetic that made it a full leak.
 *
 * NOT the same as `!isVoteWindowOpen`. That is false for a voided play - its
 * window is not open - which negates to "safe to publish", the exact opposite
 * of what a voided play deserves.
 */
export function tallyVisible(play: VoteWindowPlay, now: number = Date.now()): boolean {
  if (play.voided) return false;
  return !isVoteWindowOpen(play, now);
}

/**
 * The play the now-playing screen is allowed to call "now", or null.
 *
 * `/api/now` used to hand back `ORDER BY started_at DESC LIMIT 1` with no
 * liveness condition at all, which meant the last song ever played stayed on
 * screen forever. Found in production 2026-08-09: the site read
 * "Now on aux: Mack Vinton" with nobody connected to the speaker, showing a
 * play that had started AND ended four days earlier. The Pi had closed it
 * correctly; nothing was ever going to take it off the screen.
 *
 * The vote window is the right rule rather than a new one, and reusing it is
 * the point. This screen exists so someone can rate what is on the speaker —
 * once voting has closed there is nothing to do here, so the screen should say
 * nothing is playing. It also inherits every case that logic already gets
 * right: the 30s grace stays votable, a PAUSED song stays up because the Pi is
 * still stamping keepalive_at, and a play the Pi opened and never closed falls
 * out on the wall-clock fallback instead of hanging around forever.
 *
 * NOTE this says nothing about whether a phone is CONNECTED to the speaker,
 * and deliberately still does not. That gap was closed elsewhere on
 * 2026-08-09: the beacon now carries who holds the aux and who is waiting, and
 * /api/now exposes it as `aux`. It is kept out of HERE because this function
 * answers "can this song still be voted on", which is a question about the
 * song and not about the room.
 */
export function presentablePlay(play: PlayRow | null, now: number = Date.now()): PlayRow | null {
  if (!play) return null;
  return isVoteWindowOpen(play, now) ? play : null;
}

/**
 * The latest moment this play's window could possibly have been open, judged
 * from what is stored rather than from "now".
 *
 * voteWindowClosesAt() asks "is the keepalive fresh NOW?", which is the right
 * question for a live screen and the wrong one for a sweep: a song paused for
 * two hours whose Pi died three minutes ago has a stale keepalive, so it falls
 * back to wall-clock time and looks closed for two hours. Here the keepalive
 * always counts, so that play reads as closed from (keepalive + 150s + 30s).
 */
export function lastPossibleClose(play: VoteWindowPlay): number {
  if (play.ended_at) return Date.parse(play.ended_at) + VOTE_GRACE_MS;
  const wallClock = Date.parse(play.started_at) + (play.duration_ms ?? 0) + VOTE_GRACE_MS;
  if (!play.keepalive_at) return wallClock;
  return Math.max(wallClock, Date.parse(play.keepalive_at) + KEEPALIVE_STALE_MS + VOTE_GRACE_MS);
}

/**
 * How far in the future a play may claim to have started.
 *
 * The Pi has no clock battery. A play stamped well ahead of the server's
 * clock is a clock fault, and since `/api/now` takes the NEWEST play, one such
 * row would sit on top of the real current song for as long as the error
 * lasts.
 */
export const FUTURE_START_TOLERANCE_MS = 60_000;

/** How many of the newest plays `/api/now` reads to find its candidate. */
export const NOW_CANDIDATES = 5;

/**
 * The `/api/now` candidate among the newest plays (newest first).
 *
 * Picked in code from a fixed handful of rows, not with `WHERE voided = 0`
 * in SQL: after "Clear history" voids every play, that WHERE walked the whole
 * table on every 7.5s poll looking for a row that did not exist. Five rows
 * always covers the play still on the speaker, which void-all spares.
 */
export function nowCandidate<T extends Pick<PlayRow, "started_at" | "voided">>(
  rows: T[],
  now: number = Date.now(),
): T | null {
  for (const r of rows) {
    if (r.voided) continue;
    const t = Date.parse(r.started_at);
    if (Number.isFinite(t) && t - now > FUTURE_START_TOLERANCE_MS) continue;
    return r;
  }
  return null;
}

/** How many of the newest plays the "is a song playing?" checks look at. */
export const LIVE_PLAY_CANDIDATES = 20;

/**
 * The open play that is actually LIVE, among the newest plays (newest first):
 * not closed by the Pi, and still inside its vote window.
 *
 * `ended_at IS NULL` alone is not "playing". A play the Pi forgot to close (a
 * listener restart mid-song) stays open forever, and one such orphan made the
 * speaker picker say "Someone's song is playing" to everybody, permanently.
 */
export function liveOpenPlay<T extends VoteWindowPlay>(
  rows: T[],
  now: number = Date.now(),
): T | null {
  for (const r of rows) {
    if (r.ended_at || r.voided) continue;
    if (isVoteWindowOpen(r, now)) return r;
  }
  return null;
}
