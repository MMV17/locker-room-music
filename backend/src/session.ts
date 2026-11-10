/**
 * Session authorization, as a rule rather than as a shape of SQL.
 */

/** What the session lookup selects: the token's owner and their standing. */
export interface SessionRow {
  user_id: string;
  /** users.active for that owner. Null when the join found no user at all. */
  active: number | null;
  /** device_tokens.last_seen_at. Written at most hourly; see TOUCH_INTERVAL_MS. */
  last_seen_at?: string | null;
  /** device_tokens.created_at, the idle clock for a token never touched. */
  created_at?: string | null;
}

/**
 * A session nobody has used for this long is refused.
 *
 * The cookie lives a year, and these are shared locker-room phones: a token
 * left on a phone that changed hands over the summer should not still vote in
 * the autumn. 120 days covers a whole off-season with margin.
 */
export const SESSION_IDLE_MAX_MS = 120 * 86_400_000;

/**
 * How often requireSession may write last_seen_at.
 *
 * It used to write on EVERY authenticated request - 75 phones polling /api/now
 * every 7.5s is ~72,000 row-writes a day, most of the free plan's 100,000 on
 * a column whose only reader is the 120-day idle rule above. An hour of lag is
 * invisible at that scale.
 */
export const TOUCH_INTERVAL_MS = 60 * 60_000;

/** Only rows last touched before this get written again. */
export function touchCutoff(now: number = Date.now()): string {
  return new Date(now - TOUCH_INTERVAL_MS).toISOString();
}

/**
 * The throttled touch. A statement whose WHERE matches nothing costs no
 * row-write, which is the entire saving.
 */
export const TOUCH_SESSION_SQL =
  `UPDATE device_tokens SET last_seen_at = ?1
    WHERE token_hash = ?2 AND (last_seen_at IS NULL OR last_seen_at < ?3)`;

/** Whether this token has sat unused for longer than SESSION_IDLE_MAX_MS. */
export function sessionIdleExpired(row: SessionRow, now: number = Date.now()): boolean {
  const seen = row.last_seen_at || row.created_at;
  if (!seen) return false;
  const t = Date.parse(seen);
  // An unparseable stamp is not evidence of idleness; refusing on it would
  // sign out a player for a data problem they cannot see.
  if (!Number.isFinite(t)) return false;
  return now - t > SESSION_IDLE_MAX_MS;
}

/**
 * The user this token may act as, or null.
 *
 * Membership is checked on EVERY request, not only at sign-in. Sign-in already
 * checked `active`; requireSession did not, so deactivating a player left every
 * session they already had fully authorized - they kept voting until they chose
 * to sign out. Deletion escaped this because it deletes device_tokens outright.
 *
 * Checking here rather than revoking tokens on deactivate means reactivating a
 * player restores them to the phone already in their pocket, and means a future
 * way of deactivating someone cannot forget to revoke.
 */
export function activeSessionUserId(
  row: SessionRow | null,
  now: number = Date.now(),
): string | null {
  if (!row) return null;
  if (!row.active) return null;
  if (sessionIdleExpired(row, now)) return null;
  return row.user_id;
}
