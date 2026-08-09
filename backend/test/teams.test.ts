import { describe, it, expect } from "vitest";
import { resolveTeam } from "../src/teams";
import type { Env } from "../src/types";

/**
 * The apex router. Someone typed "auxgoat.com" because that is the string they
 * heard out loud, and this is what decides which school they meant.
 *
 * The important property is that these accept exactly what the school's own
 * join gate accepts. A code that works at hc.auxgoat.com and is turned away at
 * the front door is worse than no front door — the player never reaches the
 * site that would have let them in. That is why resolveTeam reuses
 * normalizeTeamCode() rather than doing its own case handling, and why these
 * assertions deliberately mirror teamcode.test.ts.
 */
const env = {} as Env;

describe("resolveTeam", () => {
  it("resolves the configured code to its school", async () => {
    expect(await resolveTeam(env, "CRUSADERS")).toEqual({
      slug: "hc",
      name: "Holy Cross",
    });
  });

  it("resolves regardless of casing", async () => {
    // autoCapitalize="characters" is an iOS keyboard hint only. It does
    // nothing on desktop, nothing on paste, and nothing on many third-party
    // keyboards — and the field is styled uppercase, so a lowercase entry
    // *looks* correct while being a different string.
    for (const typed of ["crusaders", "Crusaders", "CrUsAdErS"]) {
      expect(await resolveTeam(env, typed)).not.toBeNull();
    }
  });

  it("resolves despite surrounding whitespace", async () => {
    // iOS appends a space after autocomplete; copy/paste drags one along.
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
    // The submit button is disabled on an empty field, so this is reachable
    // only by hitting /go directly. It must not throw.
    expect(await resolveTeam(env, "")).toBeNull();
    expect(await resolveTeam(env, "   ")).toBeNull();
  });

  it("does not treat internal whitespace as equivalent", async () => {
    // "CRUS ADERS" is a typo, not a formatting artifact. Keeping it a failure
    // is what lets the error message stay honest.
    expect(await resolveTeam(env, "CRUS ADERS")).toBeNull();
  });

  it("does not resolve a code that only collides with Object.prototype", async () => {
    // A bare object literal as the lookup table answers "constructor" and
    // "toString" with inherited functions, which are truthy. Reaching
    // hc.auxgoat.com by typing "constructor" would be absurd but real.
    for (const typed of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(await resolveTeam(env, typed)).toBeNull();
    }
  });
});
