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
 * So the counter lives in D1, as ONE atomic statement per attempt (ATTEMPT_SQL
 * below). It used to be check, compare, then read-modify-write: twenty guesses
 * sent at once all passed the check before any of them recorded a failure, so
 * the limit bounded nothing for a parallel attacker. Now every attempt RESERVES
 * a slot before the secret is compared, and is refused once the count passes
 * the limit.
 *
 * ONLY FAILURES ARE COUNTED, as far as a legitimate user can observe: a success
 * gives its reservation back (per-address buckets are cleared outright, the
 * global bucket is refunded by one). That is the whole reason a limit this low
 * is safe behind one school NAT: typing the right code is never a step toward
 * being locked out, no matter how many teammates share the address.
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

/**
 * The team code across EVERY address, so rotating addresses (an IPv6 /64 holds
 * 2^64 of them; a botnet holds plenty of v4) cannot brute-force it.
 *
 * 300 wrong codes an hour is 7,200 a day: a short team word can still fall to a
 * determined wordlist in days, but not in minutes, and the per-address limit
 * stays the first line. THE TRADE-OFF, stated plainly: anyone can trip this on
 * purpose by sending 300 wrong codes, and then NOBODY can join for the rest of
 * that hour - players already signed in are unaffected (sessions do not touch
 * this), only new sign-ins wait. A whole squad mistyping on a normal day comes
 * nowhere near 300. If it is ever tripped deliberately, the answer is changing
 * TEAM_CODE (which also defeats whoever was guessing), not raising this.
 */
export const TEAM_CODE_GLOBAL_POLICY: Policy = { limit: 300, windowMs: 60 * 60_000 };
export const TEAM_CODE_GLOBAL_BUCKET = "code:*";

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
 * The address an attempt came from, as a throttle bucket.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 * client - unlike X-Forwarded-For, which anybody may send. A request that
 * somehow arrives without it shares one bucket, which fails closed: the
 * throttle applies to all of them together rather than to none of them.
 *
 * IPv6 is bucketed by /64. One subscriber is routinely handed a whole /64, so
 * per-address buckets let a single phone rotate through billions of "new"
 * addresses; the /64 is the unit that actually identifies a client.
 */
export function clientAddress(req: { header(name: string): string | undefined }): string {
  return addressBucket(req.header("CF-Connecting-IP") ?? "unknown");
}

/** IPv4 unchanged; IPv6 folded to its /64 prefix ("2001:db8:0:1::/64"). */
export function addressBucket(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  // IPv4-mapped (::ffff:1.2.3.4) is an IPv4 client.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  const [head, tail] = raw.split("::");
  if (raw.split("::").length > 2) return raw;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, missing)).fill("0"), ...t];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Reserve one attempt, atomically. ?1 bucket, ?2 now (epoch ms), ?3 window.
 *
 * SQLite evaluates every SET expression against the row as it was, so both
 * CASEs see the old window_start. An elapsed window restarts at 1; a live one
 * counts up without moving its start - a slow drip of guesses must not keep
 * resetting the clock. Exactly recordFailure(), as one statement.
 */
export const ATTEMPT_SQL = `INSERT INTO auth_attempts (bucket, window_start, count) VALUES (?1, ?2, 1)
  ON CONFLICT(bucket) DO UPDATE SET
    count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
  RETURNING window_start, count`;

/** Give one reservation back, if it is still in the window it was taken from. */
export const REFUND_SQL = `UPDATE auth_attempts SET count = count - 1
  WHERE bucket = ?1 AND window_start = ?2 AND count > 0`;

export interface Reservation {
  blocked: boolean;
  retryAfter: number;
  /** The window this attempt was counted in, for a refund. */
  windowStart: number;
}

/**
 * The verdict on a reserved attempt: refused once it is past the limit. With
 * `limit` failures already recorded, the next attempt reserves `limit + 1` and
 * is refused - the same line isBlocked() draws.
 */
export function reservationVerdict(w: AttemptWindow, policy: Policy, now: number): Reservation {
  const blocked = w.count > policy.limit;
  return {
    blocked,
    retryAfter: blocked ? retryAfterSeconds(w, policy, now) : 0,
    windowStart: w.window_start,
  };
}

/**
 * Reserve an attempt BEFORE the secret is compared, so a blocked address never
 * gets to find out whether its guess was right. A wrong guess keeps the
 * reservation (that is the failure being counted); a right one calls
 * throttleClear, or REFUND_SQL for a bucket that must not be cleared.
 */
export async function throttleReserve(
  db: D1Database,
  bucket: string,
  policy: Policy,
  now: number = Date.now(),
): Promise<Reservation> {
  const row = await db
    .prepare(ATTEMPT_SQL)
    .bind(bucket, now, policy.windowMs)
    .first<{ window_start: number; count: number }>();
  if (!row) return { blocked: false, retryAfter: 0, windowStart: now };
  return reservationVerdict({ window_start: row.window_start, count: row.count }, policy, now);
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
