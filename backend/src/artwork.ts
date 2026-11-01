import type { Env } from "./types";
import { normalize } from "./trackKey";

/**
 * Artwork lookup (spec 6.4). Looked up once per track, cached on the track
 * row, never repeated (the hourly heal in artworkHeal.ts retries misses).
 *
 * Three sources, in order:
 *
 *   1. Deezer      — free, no key, plain free-text search.
 *   2. iTunes      — free, no key, free-text. Answers Cloudflare's shared
 *                    egress with HTTP 429 more often than not (measured
 *                    2026-11-01), so it is a fallback, not a plan.
 *   3. MusicBrainz — free, no key, with covers from the Cover Art Archive.
 *                    Added 2026-11-01 so a Deezer miss plus an iTunes 429 is
 *                    not automatically a colour block.
 *
 * DEEZER'S FIELD SYNTAX IS DEAD. This used to send artist:"X" track:"Y",
 * which kept karaoke and lullaby records out of the results. Some time around
 * September 2026 Deezer started answering every field-scoped query with
 * {"data":[],"total":0} - HTTP 200, no error, from any network - while the
 * same words as plain text return the song. That, not the campus filter, is
 * why every cover in the app went blank with no code change. pick() still
 * filters candidates by artist, which is what keeps "Lullaby Versions of
 * Paramore" out; the query only has to get the right song into the results.
 *
 * All sources are filtered by artist and, when the phone told us one,
 * preferred by album. AVRCP reports the album the DJ is actually playing
 * from; using it is what picks the right *release* out of the several a
 * popular song has.
 */
export async function lookupArtwork(
  env: Env,
  trackId: string,
  title: string,
  artist: string,
  album?: string | null,
): Promise<LookupResult> {
  if (!normalize(title) && !normalize(artist)) {
    await setState(env, trackId, null, "none");
    return { url: null, why: ["no title or artist to search with"] };
  }

  // Every step that comes back empty says WHY. On 2026-09-27 every song was a
  // colour block while the title and artist displayed fine, and nothing
  // anywhere could say whether Deezer refused, iTunes refused, or both
  // answered and the matcher rejected them — the lookup swallowed all three
  // into the same null.
  const why: string[] = [];
  const url =
    (await fromDeezer(title, artist, album, why)) ??
    (await fromItunes(title, artist, album, why)) ??
    (await fromMusicBrainz(title, artist, album, why));
  if (!url) console.warn(`artwork: none for "${artist} - ${title}": ${why.join("; ")}`);
  await setState(env, trackId, url, url ? "found" : "none");
  return { url, why };
}

export type LookupResult = { url: string | null; why: string[] };

/** A candidate release from either provider, flattened to what we compare on. */
type Candidate = { artist: string; album: string; art: string | null };

/**
 * Artist name reduced to what two catalogues can be expected to agree on.
 *
 * A leading article is the one difference that is never meaningful and is
 * routinely disagreed about: AVRCP reported "Black Eyed Peas" while Deezer
 * lists "The Black Eyed Peas", so an exact match dropped all four correct
 * results and the song showed a colour block for the rest of the season.
 * Same trap for The Weeknd, The Killers, The Strokes.
 *
 * Deliberately the ONLY loosening. Matching on "contains" or on a prefix
 * would let *Lullaby Versions of Paramore* and *Karaoke Night* back in, which
 * is the exact failure the artist filter was added to prevent.
 */
function artistKey(value: string | null | undefined): string {
  return normalize(value).replace(/^the\s+/, "");
}

/**
 * Just the lead artist, for when a credit lists collaborators.
 *
 * AVRCP reports every credited artist comma-joined — "Travis Scott, Kacy
 * Hill", "Kanye West, Chris Martin" — while catalogues file the track under
 * the lead alone and put the guest in the title. Both of those showed a colour
 * block while single-artist tracks on the same album resolved fine.
 *
 * Applied to BOTH sides, which is what makes it safe for names that genuinely
 * contain a separator: "Simon & Garfunkel" reduces to "simon" on the phone and
 * on Deezer alike, so it still matches itself.
 */
function primaryArtist(value: string | null | undefined): string {
  const first = String(value ?? "").split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b/i)[0];
  return artistKey(first);
}

/**
 * Pick the best candidate: the artist must match, and among those an album
 * matching what the phone reported wins. Falls back to the provider's own
 * ranking, which is a reasonable "most popular release" proxy.
 *
 * Returning null rather than a weak match is deliberate — the colour block
 * is a better outcome than confidently showing the wrong cover.
 */
export function pick(
  candidates: Candidate[],
  artist: string,
  album?: string | null,
): string | null {
  const wantArtist = artistKey(artist);
  const wantAlbum = normalize(album);

  // Exact first, so precision is never traded away when it was available.
  // Only when nothing matches do we fall back to the lead artist — that keeps
  // "Lullaby Versions of Paramore" out, since its lead reduces to itself and
  // still will not equal "paramore".
  let byArtist = candidates;
  if (wantArtist) {
    const exactArtist = candidates.filter((c) => artistKey(c.artist) === wantArtist);
    const leadArtist = candidates.filter(
      (c) => primaryArtist(c.artist) === primaryArtist(artist),
    );
    byArtist = exactArtist.length ? exactArtist : leadArtist;
  }
  if (!byArtist.length) return null;

  if (wantAlbum) {
    const exact = byArtist.find((c) => normalize(c.album) === wantAlbum);
    if (exact?.art) return exact.art;
  }
  return byArtist.find((c) => c.art)?.art ?? null;
}

/**
 * A free-text query from the words we have. Quotes and colons are dropped:
 * Deezer still parses them as its (now broken) field syntax, and one stray
 * `artist:` in a title would turn a working query back into zero results.
 */
export const plainQuery = (...parts: (string | null | undefined)[]) =>
  parts
    .map((p) => String(p ?? "").replace(/["':]/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Why a provider's answer produced no cover, or null if it produced one.
 * Names what was rejected, so a matcher problem reads differently from an outage.
 */
function explainMiss(
  source: string,
  candidates: Candidate[],
  artist: string,
): string {
  if (!candidates.length) return `${source}: 0 results`;
  const seen = [...new Set(candidates.map((c) => c.artist))].slice(0, 3).join(", ");
  return `${source}: ${candidates.length} results, none matched artist "${artist}" (got ${seen})`;
}

async function deezerSearch(
  q: string,
  artist: string,
  album: string | null | undefined,
  why: string[],
): Promise<string | null> {
  try {
    // No `cf` cache options. Deezer's refusals arrive as HTTP 200 (see below),
    // so cacheEverything + a day's cacheTtl stored a refusal as if it were an
    // answer and replayed it to every retry of that exact query for 24 hours.
    // Each track is looked up once anyway, so the cache was saving nothing.
    const res = await fetch("https://api.deezer.com/search?limit=25&q=" + encodeURIComponent(q));
    if (!res.ok) {
      why.push(`deezer: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json<{
      data?: { artist?: { name?: string }; album?: { title?: string; cover_big?: string } }[];
      error?: { type?: string; message?: string; code?: number };
    }>();
    // Deezer reports quota and other refusals as HTTP 200 with an `error`
    // object, so `res.ok` alone reads a refusal as "no results".
    if (data.error) {
      why.push(`deezer: ${data.error.message ?? data.error.type ?? "error"} (code ${data.error.code ?? "?"})`);
      return null;
    }
    const candidates = (data.data ?? []).map((t) => ({
      artist: t.artist?.name ?? "",
      album: t.album?.title ?? "",
      art: t.album?.cover_big ?? null,
    }));
    const art = pick(candidates, artist, album);
    if (!art) why.push(explainMiss("deezer", candidates, artist));
    return art;
  } catch (e) {
    why.push(`deezer: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function fromDeezer(
  title: string,
  artist: string,
  album: string | null | undefined,
  why: string[],
): Promise<string | null> {
  const base = plainQuery(artist, title);
  if (!base) return null;

  // With the album in the words first, when the phone told us one. A popular
  // song's top results are compilations and remix EPs, and the original
  // release may not be among them at all - "Imma Be" by artist+track returned
  // a best-of and three remixes and no THE E.N.D. Adding the album's words is
  // the free-text version of the scoping the field syntax used to do.
  if (album) {
    const scoped = await deezerSearch(plainQuery(artist, title, album), artist, album, why);
    if (scoped) return scoped;
  }

  // No album, or the album's words matched nothing. The wider search, rather
  // than giving up - a compilation cover beats a colour block.
  return deezerSearch(base, artist, album, why);
}

async function fromItunes(
  title: string,
  artist: string,
  album: string | null | undefined,
  why: string[],
): Promise<string | null> {
  const term = [artist, title].filter(Boolean).join(" ").trim();
  if (!term) return null;

  try {
    // No `cf` cache options, for the same reason as deezerSearch.
    const res = await fetch(
      "https://itunes.apple.com/search?entity=song&limit=10&term=" + encodeURIComponent(term),
    );
    if (!res.ok) {
      why.push(`itunes: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json<{
      results?: { artistName?: string; collectionName?: string; artworkUrl100?: string }[];
    }>();
    const candidates = (data.results ?? []).map((t) => ({
      artist: t.artistName ?? "",
      album: t.collectionName ?? "",
      // Swap the dimensions in the URL for something usable on a phone.
      art: t.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null,
    }));
    const art = pick(candidates, artist, album);
    if (!art) why.push(explainMiss("itunes", candidates, artist));
    return art;
  } catch (e) {
    why.push(`itunes: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function setState(
  env: Env,
  trackId: string,
  url: string | null,
  state: "found" | "none",
): Promise<void> {
  // A failed lookup must never break play recording; the UI falls back to a
  // colour block derived from the track key.
  await env.DB.prepare("UPDATE tracks SET artwork_url = ?, artwork_state = ? WHERE id = ?")
    .bind(url, state, trackId)
    .run();
}

/**
 * MusicBrainz identifies the release; the Cover Art Archive holds its cover.
 *
 * MusicBrainz asks every client to identify itself, and rate-limits clients
 * that do not. One search plus one existence check per track.
 */
const MB_HEADERS = {
  "user-agent": "AuxGoat/1.0 ( https://hc.auxgoat.com )",
  accept: "application/json",
};

type MbRelease = {
  title?: string;
  status?: string;
  "release-group"?: { id?: string; "primary-type"?: string; "secondary-types"?: string[] };
};
type MbRecording = {
  score?: number;
  "artist-credit"?: { name?: string; joinphrase?: string }[];
  releases?: MbRelease[];
};

/**
 * The release groups worth trying, best first: official studio albums, then
 * singles and EPs, then anything else. A recording search for a hit returns
 * live albums and compilations alongside the record, and their covers are the
 * wrong picture of the right song.
 */
export function mbCandidates(recordings: MbRecording[]): Candidate[] {
  const rank = (r: MbRelease) => {
    const g = r["release-group"] ?? {};
    const secondary = g["secondary-types"] ?? [];
    let n = secondary.length ? 2 : g["primary-type"] === "Album" ? 0 : 1;
    if (r.status && r.status !== "Official") n += 3;
    return n;
  };
  const rows: { c: Candidate; rank: number; order: number }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const rec of recordings) {
    if ((rec.score ?? 0) < 80) continue;
    const artist = (rec["artist-credit"] ?? [])
      .map((a) => `${a.name ?? ""}${a.joinphrase ?? ""}`)
      .join("")
      .trim();
    for (const rel of rec.releases ?? []) {
      const id = rel["release-group"]?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        c: { artist, album: rel.title ?? "", art: id },
        rank: rank(rel),
        order: order++,
      });
    }
  }
  return rows.sort((a, b) => a.rank - b.rank || a.order - b.order).map((r) => r.c);
}

async function fromMusicBrainz(
  title: string,
  artist: string,
  album: string | null | undefined,
  why: string[],
): Promise<string | null> {
  const t = plainQuery(title);
  const a = plainQuery(artist);
  if (!t || !a) return null;
  try {
    const q = `recording:"${t}" AND artist:"${a}"`;
    const res = await fetch(
      "https://musicbrainz.org/ws/2/recording?fmt=json&limit=10&query=" + encodeURIComponent(q),
      { headers: MB_HEADERS },
    );
    if (!res.ok) {
      why.push(`musicbrainz: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json<{ recordings?: MbRecording[] }>();
    const candidates = mbCandidates(data.recordings ?? []);
    const groupId = pick(candidates, artist, album);
    if (!groupId) {
      why.push(explainMiss("musicbrainz", candidates, artist));
      return null;
    }
    // Not every release group has a cover. Check before storing, without
    // following the redirect: a 307 to archive.org means it exists, and a
    // stored URL that 404s would be a colour block the heal never retries.
    const cover = `https://coverartarchive.org/release-group/${groupId}/front-500`;
    const head = await fetch(cover, { method: "HEAD", redirect: "manual", headers: MB_HEADERS });
    if (head.status >= 400) {
      why.push(`coverartarchive: HTTP ${head.status}`);
      return null;
    }
    return cover;
  } catch (e) {
    why.push(`musicbrainz: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
