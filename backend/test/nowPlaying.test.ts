import { describe, it, expect } from "vitest";
import { presentablePlay } from "../src/voteWindow";
import type { PlayRow } from "../src/types";

/**
 * What the now-playing screen is allowed to call "now".
 *
 * The bug this exists for, seen in production 2026-08-09: the site said
 * "Now on aux: Mack Vinton" while nobody was connected to the speaker. The
 * play it was showing had STARTED and ENDED on 2026-08-05 — four days earlier
 * — and had been closed correctly by the Pi. `/api/now` simply took
 * `ORDER BY started_at DESC LIMIT 1` with no liveness condition, so the last
 * song ever played stayed "now playing" forever.
 *
 * The rule is the vote window. This screen exists so someone can rate what is
 * on the speaker; once voting has closed there is nothing to do here and
 * nothing honest to say, so the screen goes to its "nothing playing" state.
 */
const MIN = 60_000;
const base: PlayRow = {
  id: "p1",
  track_id: "t1",
  device_hash: "d1",
  user_id: "u1",
  started_at: "",
  ended_at: null,
  duration_ms: 3 * MIN,
  played_ms: null,
  counted: 1,
  voided: 0,
  keepalive_at: null,
  play_status: "playing",
};
const at = (ms: number) => new Date(ms).toISOString();

describe("presentablePlay", () => {
  const now = Date.parse("2026-08-09T12:00:00Z");

  it("shows a live song the Pi is still stamping", async () => {
    const play = {
      ...base,
      started_at: at(now - MIN),
      keepalive_at: at(now - 5_000),
    };
    expect(presentablePlay(play, now)).not.toBeNull();
  });

  it("keeps showing a song that just ended, so the grace is votable", async () => {
    // Spec 6.3: 30s after a song ends, for sync lag and slow thumbs.
    const play = { ...base, started_at: at(now - 3 * MIN), ended_at: at(now - 5_000) };
    expect(presentablePlay(play, now)).not.toBeNull();
  });

  it("stops showing a song once the grace has passed", async () => {
    const play = { ...base, started_at: at(now - 4 * MIN), ended_at: at(now - 45_000) };
    expect(presentablePlay(play, now)).toBeNull();
  });

  it("does not call a song from four days ago 'now'", async () => {
    // The exact production row: started 2026-08-05T20:17:11, ended 20:19:03,
    // still being shown as "Now on aux" on 2026-08-09.
    const play = {
      ...base,
      started_at: "2026-08-05T20:17:11.000Z",
      ended_at: "2026-08-05T20:19:03.000Z",
    };
    expect(presentablePlay(play, now)).toBeNull();
  });

  it("stops showing a play the Pi opened and never closed", async () => {
    // Two of these exist in production — the Pi lost the network or a
    // watchdog close never reached D1. ended_at is NULL forever, so a rule
    // based only on ended_at would show them until the end of time.
    const play = { ...base, started_at: at(now - 3 * 24 * 60 * MIN), keepalive_at: null };
    expect(presentablePlay(play, now)).toBeNull();
  });

  it("keeps showing a PAUSED song, which is still on the speaker", async () => {
    // The window rolls forward with each beacon precisely so a pause does not
    // expire voting. Wall-clock alone would have closed this one.
    const play = {
      ...base,
      started_at: at(now - 30 * MIN),
      play_status: "paused",
      keepalive_at: at(now - 10_000),
    };
    expect(presentablePlay(play, now)).not.toBeNull();
  });

  it("shows nothing when there is no play at all", async () => {
    expect(presentablePlay(null, now)).toBeNull();
  });

  it("never shows a voided play", async () => {
    // Voided rows are the phantom duplicates from the 2026-08-05 race. They
    // are kept for inspection and must never reach a screen.
    const play = { ...base, started_at: at(now - MIN), keepalive_at: at(now), voided: 1 };
    expect(presentablePlay(play, now)).toBeNull();
  });
});
