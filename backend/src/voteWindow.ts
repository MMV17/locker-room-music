import type { PlayRow } from "./types";

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
export function voteWindowClosesAt(play: PlayRow, now: number = Date.now()): number {
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

export function isVoteWindowOpen(play: PlayRow, now: number = Date.now()): boolean {
  if (play.voided) return false;
  return now < voteWindowClosesAt(play, now);
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
 * NOTE this says nothing about whether a phone is CONNECTED to the speaker.
 * The Pi knows — SessionManager tracks mac, alias and connected_at — but that
 * never reaches the server, because the beacon only carries the open play. A
 * connected phone playing nothing is indistinguishable here from no phone at
 * all. Closing that gap needs a Pi deploy; see STATE.md.
 */
export function presentablePlay(play: PlayRow | null, now: number = Date.now()): PlayRow | null {
  if (!play) return null;
  return isVoteWindowOpen(play, now) ? play : null;
}
