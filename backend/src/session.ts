/**
 * Session authorization, as a rule rather than as a shape of SQL.
 */

/** What the session lookup selects: the token's owner and their standing. */
export interface SessionRow {
  user_id: string;
  /** users.active for that owner. Null when the join found no user at all. */
  active: number | null;
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
export function activeSessionUserId(row: SessionRow | null): string | null {
  if (!row) return null;
  if (!row.active) return null;
  return row.user_id;
}
