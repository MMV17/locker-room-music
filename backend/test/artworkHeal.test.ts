import { describe, it, expect } from "vitest";
import { HEAL_BATCH, nextHealOffset } from "../src/artworkHeal";

/**
 * The hourly cover retry walks the missing covers with a cursor. Get this
 * wrong and either a few songs with no cover block the rest forever, or
 * healed songs make the cursor skip ones that still need a look.
 */
describe("nextHealOffset", () => {
  it("moves past a batch where nothing was found", () => {
    expect(nextHealOffset(0, HEAL_BATCH, 0)).toBe(HEAL_BATCH);
  });

  it("does not skip rows when found tracks leave the set", () => {
    // 5 healed and dropped out of the WHERE, so only 7 stayed ahead.
    expect(nextHealOffset(24, HEAL_BATCH, 5)).toBe(24 + HEAL_BATCH - 5);
  });

  it("stays put when the whole batch healed", () => {
    expect(nextHealOffset(12, HEAL_BATCH, HEAL_BATCH)).toBe(12);
  });

  it("starts over after a short batch, which means the end", () => {
    expect(nextHealOffset(36, 4, 1)).toBe(0);
    expect(nextHealOffset(36, 0, 0)).toBe(0);
  });
});
