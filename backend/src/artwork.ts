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
 * Pick the best candidate: the artist must match, and among those an album
 * matching what the phone reported wins. Falls back to the provider's own
 * ranking, which is a reasonable "most popular release" proxy.
 *
 * Returning null rather than a weak match is deliberate — the colour block
 * is a better outcome than confidently showing the wrong cover.
 */
function pick(candidates: Candidate[], artist: string, album?: string | null): string | null {
  const wantArtist = normalize(artist);
  const wantAlbum = normalize(album);

  const byArtist = wantArtist
    ? candidates.filter((c) => normalize(c.artist) === wantArtist)
    : candidates;
  if (!byArtist.length) return null;

  if (wantAlbum) {
    const exact = byArtist.find((c) => normalize(c.album) === wantAlbum);
    if (exact?.art) return exact.art;
  }
  return byArtist.find((c) => c.art)?.art ?? null;
}

async function fromDeezer(
  title: string,
  artist: string,
  album?: string | null,
): Promise<string | null> {
  // Quotes are the field delimiter in Deezer's query language, so a title
  // containing one would break out of the scope and silently widen the search.
  const q = [
    artist ? `artist:"${artist.replace(/"/g, "")}"` : "",
    title ? `track:"${title.replace(/"/g, "")}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (!q) return null;

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
