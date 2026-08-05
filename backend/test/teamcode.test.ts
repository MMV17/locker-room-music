import { describe, it, expect } from "vitest";
import { normalizeTeamCode } from "../src/crypto";
import { safeEqual } from "../src/crypto";

/**
 * The team code is typed by a teenager on a phone, in a locker room, once.
 * It is a shared word everyone on the team already knows — not a password —
 * so the only thing case sensitivity buys is a player who cannot get in.
 *
 * These assert the shapes a real keyboard actually produces.
 */
const SECRET = "CRUSADERS";
const accepts = (typed: string) =>
  safeEqual(normalizeTeamCode(typed), normalizeTeamCode(SECRET));

describe("team code matching", () => {
  it("accepts the code exactly as configured", () => {
    expect(accepts("CRUSADERS")).toBe(true);
  });

  it("accepts any casing", () => {
    // autoCapitalize="characters" is an iOS keyboard hint. It does nothing on
    // desktop, nothing on paste, and nothing on many third-party keyboards.
    expect(accepts("crusaders")).toBe(true);
    expect(accepts("Crusaders")).toBe(true);
    expect(accepts("CrUsAdErS")).toBe(true);
  });

  it("accepts surrounding whitespace", () => {
    // iOS appends a space after autocomplete; copy/paste drags one along.
    expect(accepts("CRUSADERS ")).toBe(true);
    expect(accepts(" CRUSADERS")).toBe(true);
    expect(accepts("  crusaders  ")).toBe(true);
  });

  it("accepts a trailing newline", () => {
    // `wrangler secret put` via a piped echo is a classic way to store one.
    expect(accepts("CRUSADERS\n")).toBe(true);
  });

  it("still rejects a genuinely wrong code", () => {
    expect(accepts("CRUSADER")).toBe(false);
    expect(accepts("CRUSADERSS")).toBe(false);
    expect(accepts("KNIGHTS")).toBe(false);
    expect(accepts("")).toBe(false);
  });

  it("does not treat internal whitespace as equivalent", () => {
    // "CRUS ADERS" is a typo, not a formatting artifact. Keep it a failure so
    // the error message stays honest.
    expect(accepts("CRUS ADERS")).toBe(false);
  });
});
