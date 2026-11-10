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
import { getSetting, putSetting } from "./settings";

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
// "_v2" with the cursor: a run on the old code could have finished its pass
// and started an hour's rest just before the deploy, idling the fixed pass.
const REST_KEY = "artwork_heal_rest_until_v2";
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

/**
 * The cursor after `done` tracks of a batch, `found` of which healed (and so
 * left the set). The mid-batch counterpart of nextHealOffset.
 */
export function healCursorAfter(offset: number, done: number, found: number): number {
  return Math.max(0, offset + done - found);
}

/** Whether this run should rest: a full pass finished less than an hour ago. */
export function isResting(restUntil: string | null | undefined, now = Date.now()): boolean {
  const t = restUntil ? Date.parse(restUntil) : NaN;
  return Number.isFinite(t) && now < t;
}

export async function healArtwork(
  env: Env,
  now = Date.now(),
): Promise<{ tried: number; found: number; offset: number; next: number; resting?: boolean }> {
  if (isResting(await getSetting(env, REST_KEY), now)) {
    return { tried: 0, found: 0, offset: 0, next: 0, resting: true };
  }
  const offset = Math.max(0, Math.floor(Number(await getSetting(env, CURSOR_KEY)) || 0));

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.artist, t.album FROM tracks t
      WHERE t.artwork_state IN ('none', 'pending')
      ORDER BY (SELECT MAX(p.started_at) FROM plays p WHERE p.track_id = t.id) DESC, t.id
      LIMIT ? OFFSET ?`,
  )
    .bind(HEAL_BATCH, offset)
    .all<{ id: string; title: string; artist: string | null; album: string | null }>();

  // The cursor advances after EVERY track, not once at the end. It used to be
  // written only after all eight lookups; an invocation killed part-way (CPU
  // or wall-clock limit, a hung provider) never wrote it, so the next run
  // retried the same batch, died the same way, and the heal stalled forever.
  // Each provider fetch is also bounded at 5s now (artwork.ts).
  let found = 0;
  for (let i = 0; i < results.length; i++) {
    const t = results[i];
    try {
      const r = await lookupArtwork(env, t.id, t.title, t.artist ?? "", t.album);
      if (r.url) found++;
    } catch (e) {
      // One bad track must not stop the batch, or the cursor never moves.
      console.warn(`artwork heal: ${t.title} threw ${String(e)}`);
    }
    if (i < results.length - 1) {
      await putSetting(env, CURSOR_KEY, String(healCursorAfter(offset, i + 1, found)));
    }
  }

  const next = nextHealOffset(offset, results.length, found);
  await putSetting(env, CURSOR_KEY, String(next));
  // A short batch is the end of a pass. Rest before the next one.
  if (results.length < HEAL_BATCH) {
    await putSetting(env, REST_KEY, new Date(now + HEAL_REST_MS).toISOString());
  }

  return { tried: results.length, found, offset, next };
}
