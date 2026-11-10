/**
 * The three gates: the Pi's device key, a teammate's session, and the coach's
 * admin password.
 *
 * The const names are load-bearing beyond readability: Hono records a
 * handler's `name`, and test/routes.test.ts snapshots it to prove which gate
 * sits in front of which route.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types";
import { hashToken, safeEqual } from "./crypto";
import { activeSessionUserId, touchCutoff, TOUCH_SESSION_SQL } from "./session";
import type { SessionRow } from "./session";
import { clientAddress, throttleReserve, throttleClear, ADMIN_POLICY } from "./throttle";

/** The cookie POST /api/session sets and every session-gated route reads. */
export const SESSION_COOKIE = "lr_token";

/** The one shape of a throttled answer. Never cached; see throttle.ts. */
export function tooManyAttempts(c: Context, gate: { retryAfter: number }) {
  return c.json({ error: "Too many attempts" }, 429, {
    "Retry-After": String(gate.retryAfter),
  });
}

/** Pi -> server. Shared secret in X-Device-Key. */
export const requireDeviceKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("X-Device-Key") ?? "";
  if (!c.env.DEVICE_KEY || !(await safeEqual(key, c.env.DEVICE_KEY))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

/** Teammate session, established by POST /api/session. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "Not signed in" }, 401);

  const db: D1Database = c.env.DB;
  const tokenHash = await hashToken(token);
  // LEFT JOIN, not JOIN: a token pointing at a missing user must reach
  // activeSessionUserId as a null flag and be refused there, rather than
  // vanishing into an empty result that reads the same as a bad cookie.
  const row = await db
    .prepare(
      `SELECT t.user_id, u.active, t.last_seen_at, t.created_at
         FROM device_tokens t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<SessionRow>();
  const userId = activeSessionUserId(row);
  if (!userId) return c.json({ error: "Not signed in" }, 401);

  c.set("userId", userId);
  // At most once an hour, and never on the request's critical path: a failed
  // bookkeeping write must not turn a successful read into a 500.
  const now = Date.now();
  const touch = db
    .prepare(TOUCH_SESSION_SQL)
    .bind(new Date(now).toISOString(), tokenHash, touchCutoff(now))
    .run()
    .catch((e) => console.error(`session touch failed: ${String(e)}`));
  try {
    c.executionCtx.waitUntil(touch);
  } catch {
    // No execution context (a unit test calling app.request): the promise is
    // already running and carries its own catch.
  }
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db: D1Database = c.env.DB;
  const bucket = `admin:${clientAddress(c.req)}`;

  // Reserved BEFORE the comparison, atomically, so a blocked address never
  // learns whether its guess was right and parallel guesses cannot all slip
  // past a check. This Worker previously took unlimited guesses at the
  // password that gates roster deletion and the speaker; see src/throttle.ts.
  const gate = await throttleReserve(db, bucket, ADMIN_POLICY);
  if (gate.blocked) return tooManyAttempts(c, gate);

  const pw = c.req.header("X-Admin-Password") ?? "";
  if (!c.env.ADMIN_PASSWORD || !(await safeEqual(pw, c.env.ADMIN_PASSWORD))) {
    // The reservation stands: it is this failure, counted.
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Getting it right forgives the misses that came before it.
  await throttleClear(db, bucket);
  await next();
};
