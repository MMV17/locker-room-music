/**
 * Housekeeping the crons run: closing plays the Pi forgot, and pruning tables
 * that otherwise only grow.
 */
import type { Env } from "./types";
import type { VoteWindowPlay } from "./voteWindow";
import { lastPossibleClose } from "./voteWindow";

/* ------------------------------------------------------------------ *
 * Orphaned plays
 * ------------------------------------------------------------------ */

/** How long a play's window must have been shut before the sweep closes it. */
export const ORPHAN_AFTER_MS = 15 * 60_000;
/** How far back the sweep looks. Orphans are recent by nature. */
export const ORPHAN_SCAN_LIMIT = 200;
/** A play counts once it has played this long - the Pi's own rule. */
export const COUNTED_MIN_MS = 30_000;

export type SweepPlay = VoteWindowPlay & { id: string; played_ms: number | null };

/**
 * The values to close an orphan with, or null to leave the play alone.
 *
 * An orphan is a play the Pi opened and never closed: a listener restart
 * mid-song loses the close before it reaches the outbox. Nothing else ever
 * closes it, so it stays "open" forever - which made the speaker picker refuse
 * everybody with "Someone's song is playing".
 *
 * Closed at the last moment the Pi vouched for it (keepalive_at), else at
 * start + what played. Counted only if 30s were actually heard, so a song
 * killed in its first seconds does not credit a DJ.
 *
 * A late PATCH from the Pi still wins: PATCH /api/plays/:id writes
 * `ended_at = COALESCE(?, ended_at)` etc., so its real values overwrite these.
 */
export function orphanClose(
  play: SweepPlay,
  now: number = Date.now(),
): { ended_at: string; counted: 0 | 1 } | null {
  if (play.ended_at || play.voided) return null;
  if (now - lastPossibleClose(play) < ORPHAN_AFTER_MS) return null;
  const started = Date.parse(play.started_at);
  if (!Number.isFinite(started)) return null;
  const endMs = play.keepalive_at
    ? Date.parse(play.keepalive_at)
    : started + (play.played_ms ?? play.duration_ms ?? 0);
  if (!Number.isFinite(endMs)) return null;
  return {
    ended_at: new Date(endMs).toISOString(),
    counted: (play.played_ms ?? 0) >= COUNTED_MIN_MS ? 1 : 0,
  };
}

export const ORPHAN_CANDIDATES_SQL = `SELECT id, started_at, ended_at, duration_ms, played_ms,
       keepalive_at, voided
  FROM plays ORDER BY started_at DESC LIMIT ${ORPHAN_SCAN_LIMIT}`;

/** `AND ended_at IS NULL`: never overwrite a close that landed meanwhile. */
export const ORPHAN_CLOSE_SQL =
  "UPDATE plays SET ended_at = ?, counted = ? WHERE id = ? AND ended_at IS NULL";

export async function sweepOrphanPlays(env: Env, now: number = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(ORPHAN_CANDIDATES_SQL).all<SweepPlay>();
  const stmts: D1PreparedStatement[] = [];
  for (const p of results ?? []) {
    const close = orphanClose(p, now);
    if (close) stmts.push(env.DB.prepare(ORPHAN_CLOSE_SQL).bind(close.ended_at, close.counted, p.id));
  }
  if (!stmts.length) return 0;
  const out = await env.DB.batch(stmts);
  return out.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

/**
 * The 5-minute cron fires twelve times an hour; the sweep only needs one. Gated
 * on the trigger's own scheduled time (the :00 tick), so the gate costs no
 * database read at all.
 */
export function isHourlyTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 5;
}

/* ------------------------------------------------------------------ *
 * Pruning (daily)
 * ------------------------------------------------------------------ */

/**
 * auth_attempts rows past the LONGEST throttle window are dead: a window that
 * has elapsed is replaced on the next attempt anyway. One cutoff for every
 * bucket keeps this a single statement; the longest window is the global
 * team-code bucket (see throttle.ts).
 */
export const AUTH_ATTEMPT_MAX_WINDOW_MS = 60 * 60_000;

/** Sessions nobody has used in 180 days. requireSession refuses them past 120. */
export const TOKEN_PRUNE_AFTER_MS = 180 * 86_400_000;

export function pruneCutoffs(now: number = Date.now()) {
  return {
    authWindowStart: now - AUTH_ATTEMPT_MAX_WINDOW_MS,
    tokenSeenBefore: new Date(now - TOKEN_PRUNE_AFTER_MS).toISOString(),
  };
}

export const PRUNE_AUTH_SQL = "DELETE FROM auth_attempts WHERE window_start < ?";
export const PRUNE_TOKENS_SQL =
  "DELETE FROM device_tokens WHERE COALESCE(last_seen_at, created_at) < ?";

export async function prune(
  env: Env,
  now: number = Date.now(),
): Promise<{ attempts: number; tokens: number }> {
  const c = pruneCutoffs(now);
  const [a, t] = await env.DB.batch([
    env.DB.prepare(PRUNE_AUTH_SQL).bind(c.authWindowStart),
    env.DB.prepare(PRUNE_TOKENS_SQL).bind(c.tokenSeenBefore),
  ]);
  return { attempts: a.meta?.changes ?? 0, tokens: t.meta?.changes ?? 0 };
}
