/**
 * Joining, leaving, and editing your own profile.
 */
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env } from "./types";
import { hashToken, newToken, safeEqual, normalizeTeamCode } from "./crypto";
import {
  clientAddress,
  throttleReserve,
  REFUND_SQL,
  TEAM_CODE_POLICY,
  TEAM_CODE_GLOBAL_POLICY,
  TEAM_CODE_GLOBAL_BUCKET,
} from "./throttle";
import { identityKey as rosterIdentityKey, identityProblem, textField } from "./roster";
import { SESSION_COOKIE, tooManyAttempts } from "./middleware";
import { nowIso, uuid } from "./util";
import { readJson, badJson } from "./http";
import type { Context } from "hono";

/** check-code, signup and signout. Mounted before the player routes. */
export const sessionRoutes = new Hono<AppEnv>();

/**
 * GET/PATCH /api/me. A separate sub-app only because it is mounted later than
 * sessionRoutes: index.ts registers it after the `/api/me/*` prefix gate, and
 * route order is behaviour in Hono.
 */
export const meRoutes = new Hono<AppEnv>();

/** A year. The cookie and its server-side token are replaced on every sign-in. */
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365;

/**
 * The session cookie's attributes. Signout must send the SAME attributes with
 * maxAge 0, which is what makes the browser replace the cookie rather than
 * keep both - so there is exactly one place they are written down.
 */
function cookieOpts(maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/", maxAge };
}

/** Matched case-insensitively and whitespace-trimmed — see normalizeTeamCode. */
export async function teamCodeMatches(env: Env, code: unknown): Promise<boolean> {
  return safeEqual(
    normalizeTeamCode(typeof code === "string" ? code : ""),
    normalizeTeamCode(env.TEAM_CODE),
  );
}

/**
 * The team-code gate both routes share. Null means the code was right.
 *
 * Two buckets, both RESERVED before the code is compared (see throttle.ts):
 * this address, and every address together. A wrong code keeps both
 * reservations - they are the failure, counted. A right one clears this
 * address's failures and gives back its one global slot, so typing the code
 * correctly is never a step toward anyone's lockout.
 *
 * `code` matters as much as the status. Signup returns 403 for two completely
 * different reasons, and the client used to show "wrong team code" for both -
 * so a player an admin had removed was told, repeatedly, that a correct code
 * was wrong. Anything reading this must branch on `code`, never the status.
 */
async function teamCodeGate(c: Context<AppEnv>, code: unknown): Promise<Response | null> {
  const db: D1Database = c.env.DB;
  const bucket = `code:${clientAddress(c.req)}`;
  const mine = await throttleReserve(db, bucket, TEAM_CODE_POLICY);
  if (mine.blocked) return tooManyAttempts(c, mine);
  const all = await throttleReserve(db, TEAM_CODE_GLOBAL_BUCKET, TEAM_CODE_GLOBAL_POLICY);
  if (all.blocked) return tooManyAttempts(c, all);

  if (!(await teamCodeMatches(c.env, code))) {
    return c.json({ error: "Wrong team code", code: "wrong_team_code" }, 403);
  }
  // Only a WRONG code counts. Everything past this point - a missing name, a
  // deactivated player - is a legitimate visitor who got the code right.
  await db.batch([
    db.prepare("DELETE FROM auth_attempts WHERE bucket = ?").bind(bucket),
    db.prepare(REFUND_SQL).bind(TEAM_CODE_GLOBAL_BUCKET, all.windowStart),
  ]);
  return null;
}

/**
 * Check a team code without signing anyone up.
 *
 * The Join screen asks for the code first and the player's name second, but
 * the code used to be validated only when the whole thing submitted — so a
 * wrong code meant filling in three fields and *then* being sent back to the
 * start. Observed on a real walkthrough. This lets step one fail at step one.
 *
 * Deliberately creates nothing and returns nothing but a status, so it cannot
 * be used to enumerate players.
 */
sessionRoutes.post("/api/session/check-code", async (c) => {
  const body = (await readJson<{ team_code?: unknown }>(c)) ?? {};
  const refused = await teamCodeGate(c, body.team_code);
  if (refused) return refused;
  return c.body(null, 204);
});

/**
 * Sign up / sign in. Players enter their own name and number behind the team
 * code; there is no admin-curated roster.
 *
 * The trade this makes, stated plainly: the team code is the only gate, so
 * anyone holding it can register under any name, including a teammate's. The
 * admin screen can deactivate a bad row after the fact. That was accepted as
 * the price of not making someone maintain a hundred-player roster by hand.
 *
 * Idempotent on identity. Re-running this with the same name and number
 * returns the SAME user rather than making a new one — otherwise clearing
 * cookies or switching phones would split a player's history across two rows
 * and quietly halve their DJ score.
 */
sessionRoutes.post("/api/session", async (c) => {
  const body = await readJson<{
    team_code?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    jersey_number?: unknown;
  }>(c);
  if (!body) return badJson(c);

  const refused = await teamCodeGate(c, body.team_code);
  if (refused) return refused;

  const first = textField(body.first_name);
  const last = textField(body.last_name);
  const jersey = textField(body.jersey_number);
  // The same rule PATCH /api/me and the admin screen apply (roster.ts).
  const problem = identityProblem(first, last, jersey || null);
  if (problem) return c.json({ error: problem }, 400);

  // The shared helper in roster.ts, not a second copy: signup, the admin
  // rename and PATCH /api/me must build exactly the same key.
  const identityKey = rosterIdentityKey(first, last, jersey || null);

  await c.env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, jersey_number, identity_key, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(identity_key) DO NOTHING`,
  )
    .bind(uuid(), first, last, jersey || null, identityKey, nowIso())
    .run();

  const user = await c.env.DB.prepare(
    "SELECT id, first_name, last_name, active FROM users WHERE identity_key = ?",
  )
    .bind(identityKey)
    .first<{ id: string; first_name: string; last_name: string; active: number }>();
  if (!user) return c.json({ error: "Could not create player" }, 500);

  // Deactivated by an admin — reactivating on a fresh signup would make the
  // admin's only corrective tool useless.
  if (!user.active) {
    return c.json(
      { error: "This player has been removed by an admin", code: "player_removed" },
      403,
    );
  }

  const token = newToken();
  await c.env.DB.prepare(
    "INSERT INTO device_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)",
  )
    .bind(await hashToken(token), user.id, nowIso())
    .run();

  setCookie(c, SESSION_COOKIE, token, cookieOpts(SESSION_MAX_AGE_S));
  return c.json({
    ok: true,
    user: { id: user.id, name: `${user.first_name} ${user.last_name}`.trim() },
  });
});

/**
 * Hand the phone back.
 *
 * Settings has always offered "Not you? / Change", and until 2026-09-08 it
 * navigated to /join - a route the app only renders when signedIn is false, so
 * it fell straight through to Now Playing with the same account still loaded.
 * There was nothing to call: no endpoint had ever been written.
 *
 * The token is deleted SERVER-side rather than only cleared from this browser.
 * Clearing the cookie alone would leave a working session sitting in the
 * database, and these are shared locker-room phones.
 *
 * Deliberately NOT behind requireSession: signing out has to succeed when the
 * session is already gone, or a stale cookie strands somebody on an error they
 * have no way to clear.
 */
sessionRoutes.post("/api/session/signout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM device_tokens WHERE token_hash = ?")
      .bind(await hashToken(token))
      .run();
  }
  // Same attributes as the cookie that was set, which is what makes the
  // browser replace it rather than keep both.
  setCookie(c, SESSION_COOKIE, "", cookieOpts(0));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Your own profile
 *
 * A player edits their own name and number here. The admin can already do it
 * to anybody (PUT /api/admin/users/:id); this is the same operation aimed at
 * yourself, and it carries the same trap.
 * ------------------------------------------------------------------ */

// Gated by the `/api/me/*` prefix in index.ts, which also matches `/api/me`.
// A second requireSession here ran the session lookup twice per request.
meRoutes.get("/api/me", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, first_name, last_name, jersey_number FROM users WHERE id = ?",
  )
    .bind(c.get("userId"))
    .first<{ id: string; first_name: string; last_name: string; jersey_number: string | null }>();
  if (!row) return c.json({ error: "Unknown player" }, 404);
  return c.json(row);
});

/**
 * IDENTITY_KEY HAS TO BE RECOMPUTED, and that is the whole difficulty here.
 *
 * It is normalize(first)|normalize(last)|normalize(jersey) and it is UNIQUE,
 * and it is what makes a re-signup — cleared cookies, new phone, reinstalled
 * browser — find your existing row instead of creating a second one and
 * splitting your play history in half. Leave it stale after a rename and the
 * next sign-in matches nothing.
 *
 * The consequence is worth stating plainly, because it is not obvious and it
 * is not a bug: after you change your name or number, signing up again with
 * the OLD pair no longer finds you. The new pair does. That is the same
 * behaviour an admin rename has always had.
 *
 * A collision is a real outcome rather than a theoretical one — two players
 * called the same thing with the same number is exactly what the constraint
 * is for — so it is caught and explained. The admin endpoint lets that throw
 * and 500s; this one should not, since the person typing it can fix it.
 */
meRoutes.patch("/api/me", async (c) => {
  type Body = { first_name?: unknown; last_name?: unknown; jersey_number?: unknown };
  const b = await readJson<Body>(c);
  if (!b) return badJson(c);
  const id = c.get("userId");

  const current = await c.env.DB.prepare(
    "SELECT first_name, last_name, jersey_number FROM users WHERE id = ?",
  )
    .bind(id)
    .first<{ first_name: string; last_name: string; jersey_number: string | null }>();
  if (!current) return c.json({ error: "Unknown player" }, 404);

  const first = textField(b.first_name) || current.first_name;
  const last = textField(b.last_name) || current.last_name;
  const jersey =
    b.jersey_number === undefined ? current.jersey_number : textField(b.jersey_number) || null;

  // Bounded because these are rendered on every screen and on the boards.
  const problem = identityProblem(first, last, jersey);
  if (problem) return c.json({ error: problem }, 400);

  const key = rosterIdentityKey(first, last, jersey);

  // Checked before the write so the message can name the problem. The UNIQUE
  // constraint is still the thing that decides it - two people saving at once
  // is settled by the catch below, not by this read.
  const clash = await c.env.DB.prepare(
    "SELECT id FROM users WHERE identity_key = ? AND id != ?",
  )
    .bind(key, id)
    .first<{ id: string }>();
  if (clash) {
    return c.json(
      { error: "Somebody on the roster already has that name and number." },
      409,
    );
  }

  try {
    await c.env.DB.prepare(
      `UPDATE users SET first_name = ?, last_name = ?, jersey_number = ?, identity_key = ?
       WHERE id = ?`,
    )
      .bind(first, last, jersey, key, id)
      .run();
  } catch {
    // Lost the race with another save on the same name+number.
    return c.json(
      { error: "Somebody on the roster already has that name and number." },
      409,
    );
  }

  return c.json({ ok: true, first_name: first, last_name: last, jersey_number: jersey });
});
