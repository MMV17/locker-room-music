import { describe, it, expect } from "vitest";
import { tallyVisible } from "../src/voteWindow";
import type { PlayRow } from "../src/types";

/**
 * When a play's vote tally may be exposed in a public aggregate.
 *
 * The bug this exists for, found 2026-09-08: /api/plays/:id/results correctly
 * 403s while voting is open, and /api/history correctly hides open plays, but
 * the TRACK and DJ leaderboards did neither. They filtered on
 * `counted = 1 AND voided = 0` only — and `counted` DEFAULTS to 1 at INSERT,
 * so a play that was still on the speaker already qualified.
 *
 * That is a full leak, not a hint. The board returns `voters` (= up + down)
 * and `score` = (up - down) / (up + down + TRACK_K), so
 *
 *     up - down = score * (voters + TRACK_K)
 *
 * and with up + down known, up and down both fall straight out. On a track
 * played for the first time the board row IS that one open play, so the live
 * tally is readable outright.
 *
 * Spec 6.3 — no tallies while the window is open — is the single most
 * important rule in the project, so the rule now lives in ONE function that
 * every public aggregate calls, rather than being re-derived per endpoint.
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

describe("tallyVisible", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");

  it("hides the tally while a live song is still being stamped", () => {
    // The leak case: song on the speaker, votes arriving, board would have
    // published them.
    const play = { ...base, started_at: at(now - MIN), keepalive_at: at(now - 5_000) };
    expect(tallyVisible(play, now)).toBe(false);
  });

  it("hides the tally during the 30s grace after a song ends", () => {
    const play = { ...base, started_at: at(now - 3 * MIN), ended_at: at(now - 5_000) };
    expect(tallyVisible(play, now)).toBe(false);
  });

  it("hides the tally for a PAUSED song, which is still votable", () => {
    // The Pi keeps stamping keepalive_at through a pause precisely so voting
    // stays open. The tally must stay shut for exactly as long.
    const play = {
      ...base,
      started_at: at(now - 30 * MIN),
      play_status: "paused",
      keepalive_at: at(now - 10_000),
    };
    expect(tallyVisible(play, now)).toBe(false);
  });

  it("shows the tally once the grace has passed", () => {
    const play = { ...base, started_at: at(now - 4 * MIN), ended_at: at(now - 45_000) };
    expect(tallyVisible(play, now)).toBe(true);
  });

  it("shows the tally for a play the Pi opened and abandoned", () => {
    // ended_at is NULL forever on these. The wall-clock fallback is what stops
    // their votes being withheld from the boards until the end of time.
    const play = { ...base, started_at: at(now - 3 * 24 * 60 * MIN), keepalive_at: null };
    expect(tallyVisible(play, now)).toBe(true);
  });

  it("never shows the tally for a voided play, however old", () => {
    // This is the case that makes tallyVisible its own function rather than
    // !isVoteWindowOpen: that returns false for a voided play (its window is
    // not open), which negates to "publish it". Voided plays are the phantom
    // duplicates from the 2026-08-05 race and must never reach an aggregate.
    const play = { ...base, started_at: at(now - 4 * MIN), ended_at: at(now - 45_000), voided: 1 };
    expect(tallyVisible(play, now)).toBe(false);
  });
});
