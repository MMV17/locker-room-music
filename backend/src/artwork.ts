import type { Env } from "./types";
import { normalize } from "./trackKey";

/**
 * Artwork lookup (spec 6.4). Looked up once per track, cached on the track
 * row, never repeated.
 *
 * Two sources, in order:
 *
 *   1. Deezer  — free, no key. Supports *field-scoped* queries
 *                (artist:"X" track:"Y"), which is why it goes first: a
 *                free-text search for a song is full of karaoke records,
 *                lullaby-version covers, tribute albums, and unrelated
 *                songs that happen to share a title. Scoping the fields
 *                is what keeps "Decode" from resolving to "Lullaby
 *                Versions of Paramore".
 *   2. iTunes   — free, no key, free-text only. Kept as a fallback so a
 *                Deezer outage or an edge-IP rate limit degrades to a
 *                second source rather than straight to a colour block.
 *
 * Both are filtered by artist and, when the phone told us one, preferred by
 * album. AVRCP reports the album the DJ is actually playing from; using it
 * is what picks the right *release* out of the several a popular song has.
 */
export async function lookupArtwork(
  env: Env,
  trackId: string,
  title: string,
  artist: string,
  album?: string | null,
): Promise<void> {
  if (!normalize(title) && !normalize(artist)) {
    await setState(env, trackId, null, "none");
    return;
  }

  const url = (await fromDeezer(title, artist, album)) ?? (await fromItunes(title, artist, album));
  await setState(env, trackId, url, url ? "found" : "none");
}

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

/** Quotes delimit fields in Deezer's query language — a stray one widens the search. */
const field = (name: string, value: string) => `${name}:"${value.replace(/"/g, "")}"`;

async function deezerSearch(
  q: string,
  artist: string,
  album?: string | null,
): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.deezer.com/search?limit=10&q=" + encodeURIComponent(q),
      { cf: { cacheTtl: 86400, cacheEverything: true } },
    );
    if (!res.ok) return null;
    const data = await res.json<{
      data?: { artist?: { name?: string }; album?: { title?: string; cover_big?: string } }[];
    }>();
    return pick(
      (data.data ?? []).map((t) => ({
        artist: t.artist?.name ?? "",
        album: t.album?.title ?? "",
        art: t.album?.cover_big ?? null,
      })),
      artist,
      album,
    );
  } catch {
    return null;
  }
}

async function fromDeezer(
  title: string,
  artist: string,
  album?: string | null,
): Promise<string | null> {
  const artistQ = artist ? field("artist", artist) : "";
  const titleQ = title ? field("track", title) : "";
  const base = [artistQ, titleQ].filter(Boolean).join(" ");
  if (!base) return null;

  // Ask for the album the phone reported, FIRST and as part of the query.
  //
  // Filtering by album after the fact is not enough: a popular song's top
  // results are compilations and remix EPs, and the original release may not
  // be in them at all. "Imma Be" searched by artist+track returns four rows —
  // a best-of and three remixes — and none of them is THE E.N.D., so ranking
  // could only ever pick the least wrong one. Scoping the query by album
  // returns exactly the right release.
  //
  // AVRCP gives us the album the DJ is actually playing from, which is the
  // whole reason it is worth passing down here.
  if (album) {
    const scoped = await deezerSearch(`${base} ${field("album", album)}`, artist, album);
    if (scoped) return scoped;
  }

  // No album, or the catalogue spells it differently. Fall back to the wider
  // search rather than giving up — a compilation cover beats a colour block.
  return deezerSearch(base, artist, album);
}

async function fromItunes(
  title: string,
  artist: string,
  album?: string | null,
): Promise<string | null> {
  const term = [artist, title].filter(Boolean).join(" ").trim();
  if (!term) return null;

  try {
    const res = await fetch(
      "https://itunes.apple.com/search?entity=song&limit=10&term=" + encodeURIComponent(term),
      { cf: { cacheTtl: 86400, cacheEverything: true } },
    );
    if (!res.ok) return null;
    const data = await res.json<{
      results?: { artistName?: string; collectionName?: string; artworkUrl100?: string }[];
    }>();
    return pick(
      (data.results ?? []).map((t) => ({
        artist: t.artistName ?? "",
        album: t.collectionName ?? "",
        // Swap the dimensions in the URL for something usable on a phone.
        art: t.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null,
      })),
      artist,
      album,
    );
  } catch {
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
