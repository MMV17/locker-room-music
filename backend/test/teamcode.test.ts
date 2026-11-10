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
  it("accepts the code exactly as configured", async () => {
    expect(await accepts("CRUSADERS")).toBe(true);
  });

  it("accepts any casing", async () => {
    // autoCapitalize="characters" is an iOS keyboard hint. It does nothing on
    // desktop, nothing on paste, and nothing on many third-party keyboards.
    expect(await accepts("crusaders")).toBe(true);
    expect(await accepts("Crusaders")).toBe(true);
    expect(await accepts("CrUsAdErS")).toBe(true);
  });

  it("accepts surrounding whitespace", async () => {
    // iOS appends a space after autocomplete; copy/paste drags one along.
    expect(await accepts("CRUSADERS ")).toBe(true);
    expect(await accepts(" CRUSADERS")).toBe(true);
    expect(await accepts("  crusaders  ")).toBe(true);
  });

  it("accepts a trailing newline", async () => {
    // `wrangler secret put` via a piped echo is a classic way to store one.
    expect(await accepts("CRUSADERS\n")).toBe(true);
  });

  it("still rejects a genuinely wrong code", async () => {
    expect(await accepts("CRUSADER")).toBe(false);
    expect(await accepts("CRUSADERSS")).toBe(false);
    expect(await accepts("KNIGHTS")).toBe(false);
    expect(await accepts("")).toBe(false);
  });

  it("does not treat internal whitespace as equivalent", async () => {
    // "CRUS ADERS" is a typo, not a formatting artifact. Keep it a failure so
    // the error message stays honest.
    expect(await accepts("CRUS ADERS")).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares digests, so a length mismatch is just a mismatch", async () => {
    // The old version returned early on length, leaking the secret's length.
    expect(await safeEqual("a", "a")).toBe(true);
    expect(await safeEqual("a", "ab")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
    expect(await safeEqual("x".repeat(5000), "x".repeat(5000))).toBe(true);
  });
});
