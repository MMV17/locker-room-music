import { describe, it, expect } from "vitest";
import {
  isBlocked,
  recordFailure,
  retryAfterSeconds,
  ADMIN_POLICY,
  TEAM_CODE_POLICY,
} from "../src/throttle";

/**
 * Throttling for the endpoints that take a secret.
 *
 * Found 2026-09-08: this Worker had NO rate limiting of any kind. The apex
 * Worker's limiter is documented at length in apex/wrangler.toml, including
 * the measurement that proved it never actually bound - but the apex only
 * guards /go. The endpoints that take the real secrets live HERE, and nothing
 * counted attempts against them at all:
 *
 *   POST /api/session/check-code   team code
 *   POST /api/session              team code
 *   /api/admin/*                   ADMIN_PASSWORD, which gates roster deletion,
 *                                  history clearing and device control
 *
 * The admin password was the serious one: unlimited guesses, no lockout, no
 * record that anybody had tried.
 *
 * Cloudflare's rate-limit binding is not an option here - see apex/wrangler.toml
 * for the measurement showing [[unsafe.bindings]] never becomes a binding on
 * wrangler 3.x and [[ratelimits]] is silently ignored. So the counter lives in
 * D1, and the decision lives in this module where it can be tested.
 *
 * ONLY FAILURES ARE COUNTED, which is what makes a limit this low safe with a
 * whole team behind one school NAT: a player typing the right code is never a
 * step closer to being locked out, however many teammates share their IP.
 */
const MIN = 60_000;

describe("isBlocked", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");

  it("lets through an address that has never failed", () => {
    expect(isBlocked(null, ADMIN_POLICY, now)).toBe(false);
  });

  it("lets through an address still under the limit", () => {
    const w = { window_start: now - MIN, count: ADMIN_POLICY.limit - 1 };
    expect(isBlocked(w, ADMIN_POLICY, now)).toBe(false);
  });

  it("blocks once the limit is reached inside the window", () => {
    const w = { window_start: now - MIN, count: ADMIN_POLICY.limit };
    expect(isBlocked(w, ADMIN_POLICY, now)).toBe(true);
  });

  it("forgives an address once its window has elapsed", () => {
    // Otherwise one bad afternoon locks a coach out permanently.
    const w = { window_start: now - ADMIN_POLICY.windowMs - 1, count: 999 };
    expect(isBlocked(w, ADMIN_POLICY, now)).toBe(false);
  });

  it("is far more generous about team codes than the admin password", () => {
    // A whole squad shares one NAT on school wifi and will fat-finger the code.
    // One coach types the admin password, and only from a device they own.
    expect(TEAM_CODE_POLICY.limit).toBeGreaterThan(ADMIN_POLICY.limit);
  });
});

describe("recordFailure", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");

  it("opens a window on the first failure", () => {
    expect(recordFailure(null, ADMIN_POLICY, now)).toEqual({ window_start: now, count: 1 });
  });

  it("counts up inside an open window without moving its start", () => {
    // The start must not slide, or a steady drip of guesses would keep the
    // window forever young and never trip the limit.
    const w = { window_start: now - MIN, count: 3 };
    expect(recordFailure(w, ADMIN_POLICY, now)).toEqual({ window_start: now - MIN, count: 4 });
  });

  it("starts a fresh window once the old one has elapsed", () => {
    const w = { window_start: now - ADMIN_POLICY.windowMs - 1, count: 99 };
    expect(recordFailure(w, ADMIN_POLICY, now)).toEqual({ window_start: now, count: 1 });
  });
});

describe("retryAfterSeconds", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");

  it("reports the time left in the window, rounded up", () => {
    const w = { window_start: now - (ADMIN_POLICY.windowMs - 30_500), count: ADMIN_POLICY.limit };
    expect(retryAfterSeconds(w, ADMIN_POLICY, now)).toBe(31);
  });

  it("never reports zero or a negative wait", () => {
    // A Retry-After of 0 invites an immediate retry, which is the one thing
    // the header exists to prevent.
    const w = { window_start: now - ADMIN_POLICY.windowMs, count: ADMIN_POLICY.limit };
    expect(retryAfterSeconds(w, ADMIN_POLICY, now)).toBeGreaterThan(0);
  });
});
