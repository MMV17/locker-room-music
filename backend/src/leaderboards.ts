import { Hono } from "hono";
import type { Env } from "./types";
import { trackScore, djScore, DJ_MIN_PLAYS, playsUntilQualified } from "./scoring";
import { fallbackColor } from "./crypto";

export const boards = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** Leaderboards are cached at the edge; they are never polled (spec 8). */
const CACHE_60S = { "Cache-Control": "public, max-age=60" };

function windowStart(window: string | undefined): string {
  const now = Date.now();
  const day = 86_400_000;
  if (window === "week") return new Date(now - 7 * day).toISOString();
  if (window === "month") return new Date(now - 30 * day).toISOString();
  return "0000-01-01T00:00:00Z"; // season
}

/**
 * Track leaderboard. Votes aggregate across every counted play of a track,
 * so a song played five times accumulates all five plays' votes, and the
 * score is damped so small samples cannot top the board.
 */
boards.get("/api/leaderboard/tracks", async (c) => {
  const since = windowStart(c.req.query("window"));

  const { results } = await c.env.DB.prepare(
    `SELECT
       t.id, t.title, t.artist, t.artwork_url, t.track_key,
       COUNT(DISTINCT p.id) AS plays,
       SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END)  AS up,
       SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS down
     FROM tracks t
     JOIN plays p ON p.track_id = t.id AND p.counted = 1 AND p.voided = 0
     LEFT JOIN votes v ON v.play_id = p.id AND v.voided = 0
     WHERE p.started_at >= ?
     GROUP BY t.id
     HAVING up + down > 0`,
  )
    .bind(since)
    .all<any>();

  const scored = results
    .map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      artwork_url: r.artwork_url,
      artwork_fallback: fallbackColor(r.track_key ?? ""),
      plays: r.plays,
      voters: (r.up ?? 0) + (r.down ?? 0),
      score: trackScore(r.up ?? 0, r.down ?? 0),
    }))
    .sort((a, b) => b.score - a.score);

  return c.json(
    { top: scored.slice(0, 20), bottom: scored.slice(-20).reverse() },
    200,
    CACHE_60S,
  );
});

/**
 * DJ leaderboard. Bayesian shrinkage toward the team mean, and anyone under
 * DJ_MIN_PLAYS counted plays is omitted entirely rather than shown with a
 * provisional score.
 */
boards.get("/api/leaderboard/djs", async (c) => {
  const since = windowStart(c.req.query("window"));

  const { results } = await c.env.DB.prepare(
    `SELECT
       p.id AS play_id, p.user_id,
       TRIM(u.first_name || ' ' || u.last_name) AS name, u.jersey_number,
       SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END)  AS up,
       SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS down
     FROM plays p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN votes v ON v.play_id = p.id AND v.voided = 0
     WHERE p.counted = 1 AND p.voided = 0 AND p.user_id IS NOT NULL
       AND p.started_at >= ?
     GROUP BY p.id`,
  )
    .bind(since)
    .all<any>();

  type DjEntry = { name: string; jersey: string | null; scores: number[] };
  const byUser = new Map<string, DjEntry>();
  for (const r of results) {
    const entry: DjEntry = byUser.get(r.user_id) ?? {
      name: r.name,
      jersey: r.jersey_number,
      scores: [],
    };
    entry.scores.push(trackScore(r.up ?? 0, r.down ?? 0));
    byUser.set(r.user_id, entry);
  }

  const allScores = [...byUser.values()].flatMap((e) => e.scores);
  const globalMean =
    allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

  const djs = [...byUser.entries()]
    .filter(([, e]) => e.scores.length >= DJ_MIN_PLAYS)
    .map(([id, e]) => ({
      id,
      name: e.name,
      jersey_number: e.jersey,
      plays: e.scores.length,
      score: djScore(e.scores, globalMean),
    }))
    .sort((a, b) => b.score - a.score);

  return c.json({ djs, global_mean: globalMean }, 200, CACHE_60S);
});

/** A DJ's own standing, including the private "not yet qualified" case. */
boards.get("/api/me/dj", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM plays WHERE user_id = ? AND counted = 1 AND voided = 0",
  )
    .bind(userId)
    .first<{ n: number }>();
  const n = row?.n ?? 0;
  return c.json({
    counted_plays: n,
    qualified: n >= DJ_MIN_PLAYS,
    plays_until_qualified: playsUntilQualified(n),
  });
});

boards.get("/api/history", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT
       p.id, p.started_at, p.ended_at, p.counted,
       t.title, t.artist, t.artwork_url, t.track_key,
       TRIM(u.first_name || ' ' || u.last_name) AS dj_name, u.jersey_number,
       SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END)  AS up,
       SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS down
     FROM plays p
     JOIN tracks t ON t.id = p.track_id
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN votes v ON v.play_id = p.id AND v.voided = 0
     WHERE p.voided = 0
     GROUP BY p.id
     ORDER BY p.started_at DESC
     LIMIT 50`,
  ).all<any>();

  const now = Date.now();
  const plays = results
    // Never leak a tally for a song whose window is still open.
    .filter((r) => {
      const end = r.ended_at ? Date.parse(r.ended_at) : null;
      return end !== null && now >= end + 30_000;
    })
    .map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      artwork_url: r.artwork_url,
      artwork_fallback: fallbackColor(r.track_key ?? ""),
      dj_name: r.dj_name,
      jersey_number: r.jersey_number,
      started_at: r.started_at,
      counted: !!r.counted,
      score: trackScore(r.up ?? 0, r.down ?? 0),
      voters: (r.up ?? 0) + (r.down ?? 0),
    }));

  return c.json({ plays });
});
