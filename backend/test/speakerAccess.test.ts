import { describe, it, expect } from "vitest";
import { connectedHashes, isScanFresh, SCAN_VISIBLE_MS } from "../src/speakerAccess";

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
