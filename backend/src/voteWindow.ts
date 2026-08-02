import type { PlayRow } from "./types";

/** Grace after a play ends, for sync lag and slow thumbs (spec 6.3). */
export const VOTE_GRACE_MS = 30_000;

/**
 * When voting on a play closes.
 *
 * Primary: ended_at + grace. If the Pi never reported an end (lost
 * connectivity mid-song, say), fall back to the track's own duration so the
 * window still closes on its own rather than staying open forever.
 */
export function voteWindowClosesAt(play: PlayRow): number {
  if (play.ended_at) {
    return Date.parse(play.ended_at) + VOTE_GRACE_MS;
  }
  const started = Date.parse(play.started_at);
  const duration = play.duration_ms ?? 0;
  return started + duration + VOTE_GRACE_MS;
}

export function isVoteWindowOpen(play: PlayRow, now: number = Date.now()): boolean {
  if (play.voided) return false;
  return now < voteWindowClosesAt(play);
}
