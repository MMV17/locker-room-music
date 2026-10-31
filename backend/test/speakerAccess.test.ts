import { describe, it, expect } from "vitest";
import {
  connectedHashes,
  isAudiblyPlaying,
  isScanFresh,
  scanProblem,
  SCAN_VISIBLE_MS,
} from "../src/speakerAccess";

/**
 * Who may point the box at a different speaker.
 *
 * The rule: a phone connected to the AuxGoat over Bluetooth is within about ten
 * metres of it, which is a proof of presence nobody can fake from home and
 * needs no new code handed out.
 */
describe("connectedHashes", () => {
  it("includes the holder and everyone waiting", () => {
    expect(
      connectedHashes({
        last_seen_at: "",
        aux_holder_hash: "aaa",
        aux_waiting: JSON.stringify([{ hash: "bbb" }, { hash: "ccc" }]),
      }),
    ).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("is empty when nobody is connected, which grants nobody anything", () => {
    expect(
      connectedHashes({ last_seen_at: "", aux_holder_hash: null, aux_waiting: null }),
    ).toEqual([]);
  });

  it("degrades to the holder when the waiting list is malformed", () => {
    // Being wrongly told to connect your phone is small and self-correcting.
    // A 500 on the speaker screen is not.
    expect(
      connectedHashes({
        last_seen_at: "",
        aux_holder_hash: "aaa",
        aux_waiting: "{not json",
      }),
    ).toEqual(["aaa"]);
  });

  it("ignores waiting entries with no hash", () => {
    expect(
      connectedHashes({
        last_seen_at: "",
        aux_holder_hash: null,
        aux_waiting: JSON.stringify([{ alias: "someone" }, { hash: "bbb" }]),
      }),
    ).toEqual(["bbb"]);
  });
});

describe("isScanFresh", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");

  it("shows a scan from a moment ago", () => {
    expect(isScanFresh("2026-09-01T11:59:00.000Z", now)).toBe(true);
  });

  it("hides one from an hour ago", () => {
    // Left standing, the device list becomes a record of who was in the room,
    // readable by every player. It is a picker, not a log.
    expect(isScanFresh("2026-09-01T11:00:00.000Z", now)).toBe(false);
  });

  it("hides a scan exactly at the boundary", () => {
    expect(isScanFresh(new Date(now - SCAN_VISIBLE_MS).toISOString(), now)).toBe(false);
  });

  it("treats a missing or unparseable timestamp as stale", () => {
    expect(isScanFresh(null, now)).toBe(false);
    expect(isScanFresh("whenever", now)).toBe(false);
  });
});


/**
 * "Find speakers did not work": the Pi refused the scan because a song was
 * open, and the team screen only read the device list, so the refusal looked
 * like a dead button. scanProblem is what puts the reason on screen.
 */
describe("scanProblem", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const recent = "2026-10-31T11:59:30.000Z";

  it("is silent for a scan that worked", () => {
    expect(scanProblem({ ok: 1, result: "found 3 devices", completed_at: recent }, now)).toBeNull();
  });

  it("is silent when there has been no scan", () => {
    expect(scanProblem(null, now)).toBeNull();
  });

  it("tells the player to pause when a current Pi refused mid-song", () => {
    const msg = scanProblem(
      { ok: 0, result: "refused: a song is playing — pause it, then scan again", completed_at: recent },
      now,
    );
    expect(msg).toMatch(/pause the music/i);
  });

  it("does not say pause to a Pi that refuses paused songs too", () => {
    // The listener half of the fix ships over a cable, so the Worker can be
    // ahead of the box. Its refusal must not send the player round in a loop.
    const msg = scanProblem(
      { ok: 0, result: "refused: a song is playing — scanning would stutter it", completed_at: recent },
      now,
    );
    // A paused play closes itself after 60s on that Pi, so "wait a minute"
    // is what makes the second tap work.
    expect(msg).toMatch(/wait a minute/i);
  });

  it("explains a timeout", () => {
    expect(
      scanProblem({ ok: 0, result: "timed out after 45s", completed_at: recent }, now),
    ).toMatch(/timed out/i);
  });

  it("forgets a failure that is too old to be about this visit", () => {
    expect(
      scanProblem({ ok: 0, result: "refused: a song is playing", completed_at: "2026-10-31T10:00:00.000Z" }, now),
    ).toBeNull();
  });
});

describe("isAudiblyPlaying", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");

  it("is true for a playing song the Pi reported just now", () => {
    expect(isAudiblyPlaying({ play_status: "playing", keepalive_at: "2026-10-31T11:59:55.000Z" }, now)).toBe(true);
  });

  it("is false for a paused song: nothing to stutter", () => {
    expect(isAudiblyPlaying({ play_status: "paused", keepalive_at: "2026-10-31T11:59:55.000Z" }, now)).toBe(false);
  });

  it("is false for a leftover open play the Pi stopped reporting", () => {
    expect(isAudiblyPlaying({ play_status: "playing", keepalive_at: "2026-10-31T11:00:00.000Z" }, now)).toBe(false);
  });

  it("is false with no open play", () => {
    expect(isAudiblyPlaying(null, now)).toBe(false);
  });
});
