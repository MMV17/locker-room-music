import { describe, it, expect } from "vitest";
import { resolveTeam } from "../src/teams";
import type { Env } from "../src/types";

/**
 * Someone typed "auxgoat.com" because that is the string they heard out loud,
 * and this decides which school they meant.
 *
 * These assertions deliberately mirror backend/test/teamcode.test.ts. The apex
 * must accept exactly what the school's own join gate accepts — a code that
 * works at hc.auxgoat.com and is refused here is worse than no front door,
 * because the player never reaches the site that would have let them in.
 * resolveTeam imports normalizeTeamCode from the backend rather than copying
 * it for that reason; these tests are the second line of defence.
 */
const env = {} as Env;

describe("resolveTeam", () => {
  it("resolves the configured code to its school", async () => {
    const team = await resolveTeam(env, "CRUSADERS");
    expect(team?.slug).toBe("hc");
    expect(team?.name).toBe("Holy Cross");
  });

  it("carries an explicit destination rather than deriving one from the slug", async () => {
    // The obvious `https://<slug>.auxgoat.com/` is wrong on the network that
    // matters. The whole auxgoat.com zone is SNI-filtered on campus, so a
    // derived URL would hand someone a blocked destination from a front door
    // that worked. Every team names where it actually lives.
    const team = await resolveTeam(env, "CRUSADERS");
    expect(team?.url).toBe("https://locker-room-music.mmvinton17.workers.dev/");
  });

  it("points every team at an absolute https URL", async () => {
    // A relative or scheme-less value would redirect within the apex and loop.
    const team = await resolveTeam(env, "CRUSADERS");
    expect(team?.url).toMatch(/^https:\/\//);
  });

  it("resolves regardless of casing", async () => {
    // autoCapitalize="characters" is an iOS keyboard hint only. It does
    // nothing on desktop, nothing on paste, and nothing on many third-party
    // keyboards — and the field is styled uppercase, so a lowercase entry
    // looks correct while being a different string.
    for (const typed of ["crusaders", "Crusaders", "CrUsAdErS"]) {
      expect(await resolveTeam(env, typed)).not.toBeNull();
    }
  });

  it("resolves despite surrounding whitespace", async () => {
    // iOS appends a space after autocomplete; copy/paste drags one along; and
    // `wrangler secret put` via a piped echo stores a trailing newline.
    for (const typed of ["CRUSADERS ", " CRUSADERS", "  crusaders  ", "CRUSADERS\n"]) {
      expect(await resolveTeam(env, typed)).not.toBeNull();
    }
  });

  it("returns null for a code no school uses", async () => {
    expect(await resolveTeam(env, "KNIGHTS")).toBeNull();
  });

  it("returns null for a near miss", async () => {
    expect(await resolveTeam(env, "CRUSADER")).toBeNull();
    expect(await resolveTeam(env, "CRUSADERSS")).toBeNull();
  });

  it("returns null for an empty code", async () => {
    expect(await resolveTeam(env, "")).toBeNull();
    expect(await resolveTeam(env, "   ")).toBeNull();
  });

  it("does not treat internal whitespace as equivalent", async () => {
    // "CRUS ADERS" is a typo, not a formatting artifact. Keeping it a failure
    // is what lets the error message stay honest.
    expect(await resolveTeam(env, "CRUS ADERS")).toBeNull();
  });

  it("does not resolve a code that only collides with Object.prototype", async () => {
    // A bare object literal as the lookup table answers "constructor" with an
    // inherited function, which is truthy, and would redirect someone to
    // `undefined.auxgoat.com`.
    for (const typed of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(await resolveTeam(env, typed)).toBeNull();
    }
  });
});
