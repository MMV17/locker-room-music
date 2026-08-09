/**
 * The apex router: a team code typed at auxgoat.com -> the school it belongs to.
 *
 * ---------------------------------------------------------------------------
 * This map is deliberately temporary. See docs/superpowers/specs/
 * 2026-08-07-auxgoat-landing-page-design.md.
 *
 * The intended end state is a QR code on each speaker encoding a *device
 * serial*, resolved server-side to whichever team that box is bound to. That
 * retires this lookup entirely, because the team code then gets checked by the
 * school's own Worker — where it has always been checked, and where a wrong
 * answer leaks nothing about any other school.
 *
 * Until then, be clear about what this costs: the apex answers "is this a
 * valid team code?" to anyone who asks, at whatever rate they ask, and the
 * team code is currently the *only* gate on a school's data — signup is
 * self-service, so anyone holding a valid code can register under any name.
 * "CRUSADERS" is a guessable locker-room word. A Cloudflare rate-limiting rule
 * on /go is the stopgap; the QR path is the fix.
 * ---------------------------------------------------------------------------
 */

import type { Env } from "./types";

// Imported across the package boundary ON PURPOSE, rather than copied.
//
// The apex must accept exactly what the school's own join gate accepts. A code
// that works at hc.auxgoat.com and is refused at the front door is worse than
// having no front door at all — the player never reaches the site that would
// have let them in. STATE.md records CRUSADERS being rejected in production
// because two comparison paths disagreed about case, and a second copy of this
// function is that bug waiting to happen again.
//
// Duplication would fail silently. This import fails at build time if the file
// moves, which is the trade being made. crypto.ts has no imports of its own,
// so nothing else is dragged along.
import { normalizeTeamCode } from "../../backend/src/crypto";

export interface Team {
  /** The subdomain label. `hc` means hc.auxgoat.com. */
  slug: string;
  /** Display name. */
  name: string;
}

/**
 * A Map, not an object literal, so a lookup can only return something that was
 * put here. `TEAMS["constructor"]` on a bare object returns an inherited
 * function, which is truthy — and a truthy non-Team would pass the null check
 * at the call site and redirect someone to `undefined.auxgoat.com`.
 *
 * Keys are the output of normalizeTeamCode(): trimmed and upper case. Adding a
 * school is one line here plus a route on that school's own Worker.
 */
const TEAMS = new Map<string, Team>([["CRUSADERS", { slug: "hc", name: "Holy Cross" }]]);

/**
 * Async and taking `env` though it currently needs neither. That is the point:
 * swapping this body for a D1 query then touches this function and nothing
 * else. A synchronous signature would make it a change at every call site,
 * which is the friction that keeps a placeholder in place for a year.
 */
export async function resolveTeam(_env: Env, code: string): Promise<Team | null> {
  return TEAMS.get(normalizeTeamCode(code)) ?? null;
}
