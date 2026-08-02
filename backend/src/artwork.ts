import type { Env } from "./types";

/**
 * iTunes Search API — free, no key, no auth (spec 6.4).
 * Looked up once per track, cached on the track row, never repeated.
 */
export async function lookupArtwork(
  env: Env,
  trackId: string,
  title: string,
  artist: string,
): Promise<void> {
  const term = [artist, title].filter(Boolean).join(" ").trim();
  if (!term) {
    await setState(env, trackId, null, "none");
    return;
  }

  try {
    const url =
      "https://itunes.apple.com/search?entity=song&limit=1&term=" +
      encodeURIComponent(term);
    const res = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!res.ok) {
      await setState(env, trackId, null, "none");
      return;
    }
    const data = await res.json<{ results?: { artworkUrl100?: string }[] }>();
    const art = data.results?.[0]?.artworkUrl100;
    if (!art) {
      await setState(env, trackId, null, "none");
      return;
    }
    // Swap the dimensions in the URL for something usable on a phone.
    await setState(env, trackId, art.replace("100x100bb", "600x600bb"), "found");
  } catch {
    // A failed lookup must never break play recording; the UI falls back to
    // a colour block derived from the track key.
    await setState(env, trackId, null, "none");
  }
}

async function setState(
  env: Env,
  trackId: string,
  url: string | null,
  state: "found" | "none",
): Promise<void> {
  await env.DB.prepare("UPDATE tracks SET artwork_url = ?, artwork_state = ? WHERE id = ?")
    .bind(url, state, trackId)
    .run();
}
