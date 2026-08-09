/**
 * The apex router: a team code typed at auxgoat.com -> the school it belongs to.
 *
 * Someone reaches auxgoat.com because that is the string they heard said out
 * loud, without the school in front of it. This is what decides where they
 * actually meant to go.
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
 * Until then, be clear about what this costs: the apex will answer "is this a
 * valid team code?" to anyone who asks, at whatever rate they ask, and the
 * team code is currently the *only* gate on a school's data — signup is
 * self-service, so anyone holding a valid code can register under any name.
 * "CRUSADERS" is a guessable locker-room word. Rate limiting at the edge is
 * the stopgap; the QR path is the fix.
 * ---------------------------------------------------------------------------
 */

import type { Env } from "./types";
import { normalizeTeamCode } from "./crypto";

export interface Team {
  /** The subdomain label. `hc` means hc.auxgoat.com. */
  slug: string;
  /** Display name, for copy on the landing page. */
  name: string;
}

/**
 * A Map, not an object literal, so a lookup can only ever return something
 * that was put here. `TEAMS["constructor"]` on a bare object returns an
 * inherited function, which is truthy — and a truthy non-Team would sail
 * through the null check at the call site and 302 someone to `undefined
 * .auxgoat.com`. Object.create(null) would also work; a Map says the intent
 * out loud.
 *
 * Keys are the output of normalizeTeamCode(), so they are trimmed and upper
 * case. Adding a school is one line here plus a `routes` entry in
 * wrangler.toml.
 */
const TEAMS = new Map<string, Team>([["CRUSADERS", { slug: "hc", name: "Holy Cross" }]]);

/**
 * Async and taking `env` though it currently needs neither. That is the whole
 * point: swapping this body for a D1 query against a `teams` table then
 * touches this function and nothing else. A synchronous signature would make
 * that a change at every call site, which is the friction that keeps a
 * placeholder in place for a year.
 *
 * Normalisation comes from crypto.ts rather than being reimplemented here.
 * STATE.md records CRUSADERS being rejected in production because two
 * comparison paths disagreed about case; a second normalizer would bring that
 * back one layer earlier and worse, turning away a player at the front door
 * with a code the school would have accepted.
 */
export async function resolveTeam(_env: Env, code: string): Promise<Team | null> {
  return TEAMS.get(normalizeTeamCode(code)) ?? null;
}
