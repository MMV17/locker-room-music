import { describe, it, expect } from "vitest";
import { trackScore, djScore, qualifiesForLeaderboard, playsUntilQualified } from "../src/scoring";
import { trackKey, normalize } from "../src/trackKey";
import { voteWindowClosesAt, isVoteWindowOpen } from "../src/voteWindow";
import type { PlayRow } from "../src/types";

describe("trackScore", () => {
  it("matches the worked examples in the spec", () => {
    // "A song with 2 up and 0 down scores 0.29; a song with 30 up and 2 down
    // scores 0.76. That is the correct ordering."
    expect(trackScore(2, 0)).toBeCloseTo(0.29, 2);
    expect(trackScore(30, 2)).toBeCloseTo(0.76, 2);
    expect(trackScore(30, 2)).toBeGreaterThan(trackScore(2, 0));
  });

  it("damps small samples toward zero", () => {
    // A single upvote must not beat a broadly liked song.
    expect(trackScore(1, 0)).toBeLessThan(trackScore(20, 1));
  });

  it("is zero with no votes, and never divides by zero", () => {
    expect(trackScore(0, 0)).toBe(0);
  });

  it("stays within roughly -1..+1", () => {
    expect(trackScore(1000, 0)).toBeLessThan(1);
    expect(trackScore(0, 1000)).toBeGreaterThan(-1);
  });
});

describe("djScore", () => {
  it("shrinks a short track record toward the team mean", () => {
    const mean = 0.2;
    const oneGreatSong = djScore([0.9], mean);
    const longRecord = djScore(Array(40).fill(0.6), mean);
    // "Someone who played one universally loved song does not outrank
    // someone with a 40-song track record."
    expect(longRecord).toBeGreaterThan(oneGreatSong);
  });

  it("converges on the raw average as plays accumulate", () => {
    const many = djScore(Array(200).fill(0.5), 0);
    expect(many).toBeCloseTo(0.5, 1);
  });
});

describe("leaderboard qualification", () => {
  it("hides a DJ with four plays and shows them at five", () => {
    expect(qualifiesForLeaderboard(4)).toBe(false);
    expect(qualifiesForLeaderboard(5)).toBe(true);
  });

  it("reports how many more songs are needed", () => {
    expect(playsUntilQualified(2)).toBe(3);
    expect(playsUntilQualified(9)).toBe(0);
  });
});

describe("track keys", () => {
  it("collapses case and punctuation so repeat plays aggregate", () => {
    expect(trackKey("HUMBLE.", "Kendrick Lamar")).toBe(trackKey("humble", "kendrick lamar"));
    expect(normalize("Don't Stop Believin'")).toBe("dont stop believin");
  });

  it("handles missing fields without throwing", () => {
    expect(trackKey(null, null)).toBe("|");
    expect(trackKey("Bootleg", null)).toBe("|bootleg");
  });
});

function play(over: Partial<PlayRow> = {}): PlayRow {
  return {
    id: "p1",
    track_id: "t1",
    device_hash: null,
    user_id: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_ms: null,
    played_ms: null,
    counted: 1,
    voided: 0,
    ...over,
  };
}

describe("vote window", () => {
  it("stays open while the song is playing", () => {
    expect(isVoteWindowOpen(play({ duration_ms: 200_000 }))).toBe(true);
  });

  it("closes 30s after the song ends", () => {
    const ended = new Date(Date.now() - 31_000).toISOString();
    expect(isVoteWindowOpen(play({ ended_at: ended }))).toBe(false);
  });

  it("still allows votes inside the 30s grace", () => {
    const ended = new Date(Date.now() - 5_000).toISOString();
    expect(isVoteWindowOpen(play({ ended_at: ended }))).toBe(true);
  });

  it("falls back to duration when the Pi never reported an end", () => {
    // Connectivity died mid-song: the window must still close on its own
    // rather than staying open forever.
    const started = new Date(Date.now() - 500_000).toISOString();
    const p = play({ started_at: started, duration_ms: 200_000, ended_at: null });
    expect(isVoteWindowOpen(p)).toBe(false);
    expect(voteWindowClosesAt(p)).toBe(Date.parse(started) + 200_000 + 30_000);
  });

  it("is closed for a voided play", () => {
    expect(isVoteWindowOpen(play({ voided: 1, duration_ms: 200_000 }))).toBe(false);
  });
});

/* The pause bug, from a real observation: "POWER" by Kanye West started at
   22:04:28 with duration_ms=292093, so the wall-clock window closed at
   22:09:50 while the track sat paused mid-song and still on the speaker. */
describe("vote window survives a pause", () => {
  const base = {
    id: "p1",
    track_id: "t1",
    device_hash: null,
    user_id: null,
    started_at: "2026-08-04T22:04:28.000Z",
    ended_at: null,
    duration_ms: 292093,
    played_ms: null,
    counted: 1,
    voided: 0,
  } as any;

  const START = Date.parse("2026-08-04T22:04:28.000Z");
  const WALL_CLOCK_CLOSE = START + 292093 + 30_000;

  it("closes on wall clock when the Pi is silent (spec 6.3 fallback)", () => {
    const at = WALL_CLOCK_CLOSE + 1000;
    expect(isVoteWindowOpen({ ...base }, at)).toBe(false);
  });

  it("stays open while the Pi keeps saying the song is on the speaker", () => {
    const at = WALL_CLOCK_CLOSE + 60_000;
    const play = { ...base, keepalive_at: new Date(at - 20_000).toISOString(), play_status: "paused" };
    expect(isVoteWindowOpen(play, at)).toBe(true);
  });

  it("closes once the Pi stops reporting it", () => {
    const at = WALL_CLOCK_CLOSE + 600_000;
    const play = { ...base, keepalive_at: new Date(at - 400_000).toISOString(), play_status: "paused" };
    expect(isVoteWindowOpen(play, at)).toBe(false);
  });

  it("a real end still closes the window on ended_at, keepalive or not", () => {
    const ended = "2026-08-04T22:06:00.000Z";
    const play = { ...base, ended_at: ended, keepalive_at: new Date(Date.parse(ended) + 5_000).toISOString() };
    expect(isVoteWindowOpen(play, Date.parse(ended) + 31_000)).toBe(false);
  });
});
