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
 * Runs every 5 minutes from the cron trigger, one batch per run, until a pass
 * over every missing cover is complete - then RESTS for an hour. So a backlog
 * clears in minutes (asked for 2026-11-01: "run the history now", with no
 * laptop and no way to press the Admin button), while songs that genuinely
 * have no cover are retried hourly, not every 5 minutes against Deezer and
 * Apple - a stream of retries is how you get rate-limited, which is the
 * other suspected cause of the missing covers.
 *
 * Most recently played first, so what people are looking at heals first. A
 * cursor in `settings` moves past songs that still have no cover, so a
 * handful with none cannot sit at the front of every batch forever.
 */
import { lookupArtwork } from "./artwork";
import type { Env } from "./types";

/**
 * Same as the Admin retry. A lookup is up to 5 fetches (2 Deezer, iTunes,
 * MusicBrainz, a cover check) and the free plan allows 50 per invocation:
 * past that every fetch throws and looks like an outage. 8 x 5 = 40.
 */
export const HEAL_BATCH = 8;
// "_v2": the runs before the Deezer fix found nothing and walked the old
// cursor to 24, so the first fixed pass started past the 24 most recently
// played songs - the top of History. A new key starts the pass at 0. The old
// row is left behind, unused.
const CURSOR_KEY = "artwork_heal_offset_v2";
const REST_KEY = "artwork_heal_rest_until";
/** After a full pass, how long before the next one starts. */
export const HEAL_REST_MS = 60 * 60_000;

/**
 * Where the next run starts. A healed track leaves the set and everything
 * after it moves up one, so the cursor only advances past the ones that
 * stayed. A short batch means the end was reached: start over next time.
 */
export function nextHealOffset(offset: number, batchLen: number, found: number): number {
  if (batchLen < HEAL_BATCH) return 0;
  return Math.max(0, offset + batchLen - found);
}

/** Whether this run should rest: a full pass finished less than an hour ago. */
export function isResting(restUntil: string | null | undefined, now = Date.now()): boolean {
  const t = restUntil ? Date.parse(restUntil) : NaN;
  return Number.isFinite(t) && now < t;
}

async function readSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, new Date().toISOString())
    .run();
}

export async function healArtwork(
  env: Env,
  now = Date.now(),
): Promise<{ tried: number; found: number; offset: number; next: number; resting?: boolean }> {
  if (isResting(await readSetting(env, REST_KEY), now)) {
    return { tried: 0, found: 0, offset: 0, next: 0, resting: true };
  }
  const offset = Math.max(0, Math.floor(Number(await readSetting(env, CURSOR_KEY)) || 0));

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
  await writeSetting(env, CURSOR_KEY, String(next));
  // A short batch is the end of a pass. Rest before the next one.
  if (results.length < HEAL_BATCH) {
    await writeSetting(env, REST_KEY, new Date(now + HEAL_REST_MS).toISOString());
  }

  return { tried: results.length, found, offset, next };
}
