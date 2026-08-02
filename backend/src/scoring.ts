/**
 * Rating math (spec section 7).
 *
 * Raw vote counts are never used for ranking: a song played once to three
 * people would otherwise beat a song played twenty times to the whole room.
 * Every ranking here is damped.
 */

/** Damping constant for track scores. */
export const TRACK_K = 5;
/** Shrinkage weight pulling DJs toward the team average. */
export const DJ_M = 3;
/** Below this many counted plays a DJ is hidden from the public board. */
export const DJ_MIN_PLAYS = 5;

/**
 * track_score = (up - down) / (up + down + k)
 *
 * Roughly -1..+1, pulled toward 0 when the sample is small. 2up/0down scores
 * 0.29; 30up/2down scores 0.76 — that is the correct ordering.
 */
export function trackScore(upvotes: number, downvotes: number, k: number = TRACK_K): number {
  const total = upvotes + downvotes;
  if (total === 0) return 0;
  return (upvotes - downvotes) / (total + k);
}

/**
 * dj_score = (sum(track_scores) + m * global_mean) / (n + m)
 *
 * Bayesian shrinkage toward the team average, so a DJ needs a real body of
 * work before topping the board. One universally loved song does not outrank
 * a forty-song track record.
 */
export function djScore(
  playScores: number[],
  globalMeanScore: number,
  m: number = DJ_M,
): number {
  const n = playScores.length;
  const sum = playScores.reduce((a, b) => a + b, 0);
  return (sum + m * globalMeanScore) / (n + m);
}

export function qualifiesForLeaderboard(countedPlays: number): boolean {
  return countedPlays >= DJ_MIN_PLAYS;
}

export function playsUntilQualified(countedPlays: number): number {
  return Math.max(0, DJ_MIN_PLAYS - countedPlays);
}

/**
 * Deliberately out of scope for v1 (spec 7.4): troll detection (users whose
 * votes anticorrelate with everyone else) and per-user vote weighting. They
 * would slot in here — weight each vote before the tallies feed trackScore.
 * Build the honest version first, look at real data, then decide.
 */
