/**
 * Album covers, served from our own origin.
 *
 * Covers used to load straight from cdn-images.dzcdn.net and
 * *.mzstatic.com, on the player's phone. On 2026-09-27 every song showed its
 * colour block, with title, artist and album all arriving fine, and the
 * leading suspect was the campus filter: it already blocks the whole
 * auxgoat.com zone, and a filter that blocks music CDNs gives exactly "every
 * song, with no code change". The covers that were verified on 2026-08-05
 * were checked from a laptop off campus.
 *
 * Fetching through the Worker means the phone only ever talks to the hostname
 * it is already using for the app - the one hostname we know gets through.
 * It also stops every phone in the room contacting Deezer and Apple directly.
 *
 * THIS IS NOT AN OPEN PROXY. It fetches only https URLs on the two image hosts
 * the artwork lookup stores (see artwork.ts), on the default port, with no
 * credentials in the URL. Anything else is a 400 without a fetch.
 */
import type { Context } from "hono";

/** Hosts artwork.ts stores covers from. Suffix match, on a dot boundary. */
// coverartarchive.org answers with a redirect to an archive.org mirror, which
// fetch follows; the URL we validate and store is always coverartarchive.org.
const ALLOWED_HOST_SUFFIXES = ["dzcdn.net", "mzstatic.com", "coverartarchive.org"];

const ONE_WEEK_S = 7 * 24 * 60 * 60;
/** A cover is ~50-150 KB. Anything far bigger is not a cover. */
const MAX_BYTES = 2 * 1024 * 1024;

export function isAllowedArtUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

/** The same-origin address the web app should load a stored cover from. */
export function proxiedArtPath(raw: string): string {
  return "/api/art?u=" + encodeURIComponent(raw);
}

// Typed loosely: it reads only the request and the execution context, and is
// mounted on an app whose Variables differ from file to file.
export async function serveArt(c: Context<any>): Promise<Response> {
  const target = c.req.query("u");
  if (!isAllowedArtUrl(target)) return c.text("not an album cover", 400);

  // Cached at this edge for a week, keyed by our own URL. Only a successful
  // image is ever stored: a refusal cached for a day per query is how the
  // artwork lookup used to replay one bad answer (see artwork.ts).
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(c.req.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  let upstream: Response;
  try {
    upstream = await fetch(target!, { headers: { accept: "image/*" } });
  } catch {
    return c.text("cover host unreachable", 502);
  }
  const type = upstream.headers.get("content-type") ?? "";
  const length = Number(upstream.headers.get("content-length") ?? "0");
  if (!upstream.ok || !type.startsWith("image/") || length > MAX_BYTES) {
    // The <img> falls back to the colour block on any non-image answer.
    return c.text(`cover host answered ${upstream.status}`, 502);
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return c.text("cover too large", 502);

  const res = new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": `public, max-age=${ONE_WEEK_S}, immutable`,
      "x-content-type-options": "nosniff",
    },
  });
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}
