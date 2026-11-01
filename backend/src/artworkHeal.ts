/**
 * Retry missing album covers on a schedule, so nobody has to press a button.
 *
 * Covers are looked up once, when a song is first played (spec 6.4). A lookup
 * that failed - Deezer or iTunes refusing, a matcher miss, a Worker that died
 * mid-lookup - left that track a colour block forever, in History and on the
 * boards, until a coach pressed Admin -> Album covers -> Find missing covers.
 * Covers were broken for over a month from 2026-09-27, so a lot of History
 * needed healing, and the only person around had no laptop.
 *
 * Runs hourly from the cron trigger, one batch per run. Most recently played
 * first, so what people are looking at heals first. A cursor in `settings`
 * moves past songs that still have no cover, so a handful of songs that
 * genuinely have none cannot sit at the front of every batch forever.
 */
import { lookupArtwork } from "./artwork";
import type { Env } from "./types";

/**
 * Same as the Admin retry. A lookup is ~3 fetches, and the free plan allows 50
 * per invocation: past that every fetch throws and looks like an outage.
 */
export const HEAL_BATCH = 12;
const CURSOR_KEY = "artwork_heal_offset";

/**
 * Where the next run starts. A healed track leaves the set and everything
 * after it moves up one, so the cursor only advances past the ones that
 * stayed. A short batch means the end was reached: start over next time.
 */
export function nextHealOffset(offset: number, batchLen: number, found: number): number {
  if (batchLen < HEAL_BATCH) return 0;
  return Math.max(0, offset + batchLen - found);
}

export async function healArtwork(
  env: Env,
): Promise<{ tried: number; found: number; offset: number; next: number }> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(CURSOR_KEY)
    .first<{ value: string }>();
  const offset = Math.max(0, Math.floor(Number(row?.value) || 0));

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.artist, t.album FROM tracks t
      WHERE t.artwork_state IN ('none', 'pending')
      ORDER BY (SELECT MAX(p.started_at) FROM plays p WHERE p.track_id = t.id) DESC, t.id
      LIMIT ? OFFSET ?`,
  )
    .bind(HEAL_BATCH, offset)
    .all<{ id: string; title: string; artist: string | null; album: string | null }>();

  let found = 0;
  for (const t of results) {
    try {
      const r = await lookupArtwork(env, t.id, t.title, t.artist ?? "", t.album);
      if (r.url) found++;
    } catch (e) {
      // One bad track must not stop the batch, or the cursor never moves.
      console.warn(`artwork heal: ${t.title} threw ${String(e)}`);
    }
  }

  const next = nextHealOffset(offset, results.length, found);
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(CURSOR_KEY, String(next), new Date().toISOString())
    .run();

  return { tried: results.length, found, offset, next };
}
