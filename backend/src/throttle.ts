/**
 * Attempt throttling for the endpoints that take a secret.
 *
 * WHY THIS IS NOT A CLOUDFLARE RATE-LIMIT BINDING: apex/wrangler.toml records
 * the measurement. `[[unsafe.bindings]]` deploys cleanly and never becomes a
 * binding on wrangler 3.x - 72 wrong codes from one IP produced zero 429s -
 * and `[[ratelimits]]`, the correct modern form, is silently ignored entirely
 * by wrangler 3.114 ("No bindings found"). It needs wrangler 4 and a
 * @cloudflare/workers-types bump. Until that happens a binding here would be
 * decoration, and this Worker holds the secrets that actually matter.
 *
 * So the counter lives in D1. That costs one indexed read on failed auth only -
 * a successful request never touches the table.
 *
 * ONLY FAILURES ARE COUNTED. That is the whole reason a limit this low is safe
 * behind one school NAT: typing the right code is never a step toward being
 * locked out, no matter how many teammates share the address.
 */

export interface Policy {
  /** Failures allowed inside one window before the address is refused. */
  limit: number;
  /** How long that window lasts. */
  windowMs: number;
}

export interface AttemptWindow {
  /** Epoch ms when this window opened. Does NOT slide as failures arrive. */
  window_start: number;
  count: number;
}

/**
 * The admin password gates roster deletion, history clearing and the speaker.
 *
 * A block has to be checked BEFORE the password is compared - otherwise every
 * guess still gets an answer and the counter protects nothing. That means a
 * lockout also shuts out the coach, so the WINDOW is the thing tuned for this
 * product rather than the limit: five minutes, not the quarter hour a bank
 * would use. Ten guesses per five minutes is 2,880 a day, down from unlimited,
 * which puts any real password out of reach - while a coach who fat-fingers it
 * during a game is back in before the next drill rather than after it.
 */
export const ADMIN_POLICY: Policy = { limit: 10, windowMs: 5 * 60_000 };

/**
 * The team code is typed by a whole squad on shared school wifi, so all of
 * them arrive from one address. Deliberately generous: this is here to stop a
 * wordlist, not to police thumbs. The real fix remains the QR path, which
 * removes the need to type a code at all.
 */
export const TEAM_CODE_POLICY: Policy = { limit: 30, windowMs: 10 * 60_000 };

function windowLive(w: AttemptWindow, policy: Policy, now: number): boolean {
  return now - w.window_start < policy.windowMs;
}

/** Whether this address must be refused before its attempt is even checked. */
export function isBlocked(
  w: AttemptWindow | null,
  policy: Policy,
  now: number = Date.now(),
): boolean {
  if (!w) return false;
  if (!windowLive(w, policy, now)) return false;
  return w.count >= policy.limit;
}

/**
 * The window after recording one failure.
 *
 * An elapsed window is replaced rather than extended, so a locked-out address
 * always recovers on its own. The start deliberately does not move while a
 * window is live: a slow drip of guesses would otherwise keep resetting the
 * clock and never trip the limit.
 */
export function recordFailure(
  w: AttemptWindow | null,
  policy: Policy,
  now: number = Date.now(),
): AttemptWindow {
  if (!w || !windowLive(w, policy, now)) return { window_start: now, count: 1 };
  return { window_start: w.window_start, count: w.count + 1 };
}

/** Seconds until this address may try again. Never zero - see the test. */
export function retryAfterSeconds(
  w: AttemptWindow,
  policy: Policy,
  now: number = Date.now(),
): number {
  const remaining = w.window_start + policy.windowMs - now;
  return Math.max(1, Math.ceil(remaining / 1000));
}

/* ------------------------------------------------------------------ *
 * D1 glue
 *
 * Deliberately thin: every decision above is a pure function, so the only
 * thing that needs a database is remembering a count between requests.
 * ------------------------------------------------------------------ */

/**
 * The address an attempt came from.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 * client - unlike X-Forwarded-For, which anybody may send. A request that
 * somehow arrives without it shares one bucket, which fails closed: the
 * throttle applies to all of them together rather than to none of them.
 */
export function clientAddress(req: { header(name: string): string | undefined }): string {
  return req.header("CF-Connecting-IP") ?? "unknown";
}

async function readWindow(db: D1Database, bucket: string): Promise<AttemptWindow | null> {
  const row = await db
    .prepare("SELECT window_start, count FROM auth_attempts WHERE bucket = ?")
    .bind(bucket)
    .first<{ window_start: number; count: number }>();
  return row ? { window_start: row.window_start, count: row.count } : null;
}

/**
 * Whether to refuse this attempt outright, and for how long.
 *
 * Called BEFORE the secret is compared, so a blocked address never gets to
 * find out whether its guess was right.
 */
export async function throttleCheck(
  db: D1Database,
  bucket: string,
  policy: Policy,
  now: number = Date.now(),
): Promise<{ blocked: boolean; retryAfter: number }> {
  const w = await readWindow(db, bucket);
  if (!w || !isBlocked(w, policy, now)) return { blocked: false, retryAfter: 0 };
  return { blocked: true, retryAfter: retryAfterSeconds(w, policy, now) };
}

/** Record one failed attempt. */
export async function throttleNoteFailure(
  db: D1Database,
  bucket: string,
  policy: Policy,
  now: number = Date.now(),
): Promise<void> {
  const next = recordFailure(await readWindow(db, bucket), policy, now);
  await db
    .prepare(
      `INSERT INTO auth_attempts (bucket, window_start, count)
       VALUES (?, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         window_start = excluded.window_start,
         count        = excluded.count`,
    )
    .bind(bucket, next.window_start, next.count)
    .run();
}

/**
 * Forget an address's failures after it authenticates successfully.
 *
 * Without this a coach who mistypes the password nine times and then gets it
 * right stays one slip away from a lockout for the rest of the window.
 */
export async function throttleClear(db: D1Database, bucket: string): Promise<void> {
  await db.prepare("DELETE FROM auth_attempts WHERE bucket = ?").bind(bucket).run();
}
