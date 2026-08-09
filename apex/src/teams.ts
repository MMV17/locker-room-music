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
  /** Short label for the school. Identity only — the URL is not derived from it. */
  slug: string;
  /** Display name. */
  name: string;
  /**
   * Absolute destination. Deliberately NOT computed as
   * `https://${slug}.auxgoat.com/`.
   *
   * The obvious derived form is wrong on the only network that matters. The
   * whole auxgoat.com zone is SNI-filtered on the school's wired network —
   * measured 2026-08-08: to the same Cloudflare IP, SNI `hc.auxgoat.com` gets
   * "no peer certificate available" while `example.com` and
   * `lockerroom.finestkindfarms.com` are served normally. A derived URL would
   * hand someone a blocked destination from a front door that had just worked,
   * which is a worse failure than not having a front door.
   *
   * So every team names where it actually lives, and switching a school back
   * to its pretty hostname once a filter lapses is a one-line change here.
   */
  url: string;
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
const TEAMS = new Map<string, Team>([
  [
    "CRUSADERS",
    {
      slug: "hc",
      name: "Holy Cross",
      // NOT hc.auxgoat.com, which is filtered on the school's network. The
      // workers.dev hostname returned 200 from that same network at the exact
      // moment the whole auxgoat.com zone was refused, so it is the one that
      // reaches players where they actually are.
      //
      // lockerroom.finestkindfarms.com is the other proven-unfiltered option
      // and is what the Pi points at; prefer it if workers.dev is ever turned
      // off. Move this back to https://hc.auxgoat.com/ once the filter lapses
      // or IT recategorises the domain.
      url: "https://locker-room-music.mmvinton17.workers.dev/",
    },
  ],
]);

/**
 * Async and taking `env` though it currently needs neither. That is the point:
 * swapping this body for a D1 query then touches this function and nothing
 * else. A synchronous signature would make it a change at every call site,
 * which is the friction that keeps a placeholder in place for a year.
 */
export async function resolveTeam(_env: Env, code: string): Promise<Team | null> {
  return TEAMS.get(normalizeTeamCode(code)) ?? null;
}
