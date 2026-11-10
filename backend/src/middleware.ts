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
import { activeSessionUserId } from "./session";
import type { SessionRow } from "./session";
import {
  clientAddress,
  throttleCheck,
  throttleNoteFailure,
  throttleClear,
  ADMIN_POLICY,
} from "./throttle";
import { nowIso } from "./util";

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
  if (!c.env.DEVICE_KEY || !safeEqual(key, c.env.DEVICE_KEY)) {
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
      `SELECT t.user_id, u.active
         FROM device_tokens t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<SessionRow>();
  const userId = activeSessionUserId(row);
  if (!userId) return c.json({ error: "Not signed in" }, 401);

  c.set("userId", userId);
  await db
    .prepare("UPDATE device_tokens SET last_seen_at = ? WHERE token_hash = ?")
    .bind(nowIso(), tokenHash)
    .run();
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db: D1Database = c.env.DB;
  const bucket = `admin:${clientAddress(c.req)}`;

  // Checked BEFORE the comparison, so a blocked address never learns whether
  // its guess was right. This Worker previously took unlimited guesses at the
  // password that gates roster deletion and the speaker; see src/throttle.ts.
  const gate = await throttleCheck(db, bucket, ADMIN_POLICY);
  if (gate.blocked) return tooManyAttempts(c, gate);

  const pw = c.req.header("X-Admin-Password") ?? "";
  if (!c.env.ADMIN_PASSWORD || !safeEqual(pw, c.env.ADMIN_PASSWORD)) {
    await throttleNoteFailure(db, bucket, ADMIN_POLICY);
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Getting it right forgives the misses that came before it.
  await throttleClear(db, bucket);
  await next();
};
