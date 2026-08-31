import { describe, it, expect } from "vitest";
import { freshCountdown } from "../src/auxCountdown";

/**
 * How long the waiting DJ is told they have left.
 *
 * The Pi measures this at its beacon and the site reads it some seconds later,
 * so the raw number is always stale on arrival. Serving it uncorrected would
 * park the banner on a value that never moves for a whole poll cycle — and on
 * an idle box the beacon interval is 60s, which is three times the grace it is
 * counting down.
 */
describe("freshCountdown", () => {
  const seen = "2026-08-23T19:00:00.000Z";
  const at = Date.parse(seen);

  it("leaves null alone, because an open song has no deadline to age", () => {
    // NULL means a song is playing. There is nothing counting down, so there
    // is nothing to correct — and turning it into a number here would put a
    // countdown on screen that rewinds the moment the holder skips a track.
    expect(freshCountdown(null, seen, at + 5_000)).toBeNull();
  });

  it("subtracts however long the beacon has been sitting there", () => {
    expect(freshCountdown(20_000, seen, at + 5_000)).toBe(15_000);
  });

  it("floors at zero rather than going negative", () => {
    // A beacon this old is one from before the grace ran out, and free is
    // exactly what the aux became. Negative milliseconds would render as
    // "yours in -40s".
    expect(freshCountdown(20_000, seen, at + 60_000)).toBe(0);
  });

  it("keeps a zero as zero", () => {
    // 0 is a real state and a load-bearing one: the aux is free, press play.
    // It must not be confused with null, which means the opposite.
    expect(freshCountdown(0, seen, at + 5_000)).toBe(0);
  });

  it("does not go up when the clocks disagree", () => {
    // The Pi's clock and the Worker's are not the same clock. A beacon
    // timestamped slightly in the future must not inflate the countdown past
    // what the Pi actually reported.
    expect(freshCountdown(20_000, seen, at - 5_000)).toBe(20_000);
  });
});
