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
 * THIS IS NOT AN OPEN PROXY. It fetches only https URLs on the image hosts the
 * artwork lookup stores (see artwork.ts), on the default port, with no
 * credentials in the URL, follows redirects only onto an allowlist, and serves
 * only raster image types. Anything else is a 400 or 502 without a body.
 */
import type { Context } from "hono";

/** Hosts artwork.ts stores covers from. Suffix match, on a dot boundary. */
const STORED_HOST_SUFFIXES = ["dzcdn.net", "mzstatic.com", "coverartarchive.org"];

/**
 * Hosts a REDIRECT may lead to. Deezer and Apple answer directly; Cover Art
 * Archive answers coverartarchive.org/release-group/<id>/front-500 with a
 * redirect to coverartarchive.org/release/<id>/..., then to
 * archive.org/download/..., then to an ia*.us.archive.org mirror - three hops
 * on the hosts below. Each hop is re-checked here; fetch is never allowed to
 * follow one on its own, which used to let a redirect lead anywhere.
 */
const REDIRECT_HOST_SUFFIXES = [...STORED_HOST_SUFFIXES, "archive.org"];
export const MAX_REDIRECTS = 3;

/** The only types served. SVG is deliberately absent: it is a document, with scripts. */
export const ART_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Even a cover served same-origin can never run anything or be framed into a page. */
export const ART_CSP = "default-src 'none'; sandbox";

const ONE_WEEK_S = 7 * 24 * 60 * 60;
/** A cover is ~50-150 KB. Anything far bigger is not a cover. */
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

function hostAllowed(raw: string | null | undefined, suffixes: string[]): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return suffixes.some((s) => host === s || host.endsWith("." + s));
}

/** Whether `u` may be proxied at all: a cover URL artwork.ts could have stored. */
export function isAllowedArtUrl(raw: string | null | undefined): boolean {
  return hostAllowed(raw, STORED_HOST_SUFFIXES);
}

/** Whether a redirect hop may be followed. */
export function isAllowedArtRedirect(raw: string | null | undefined): boolean {
  return hostAllowed(raw, REDIRECT_HOST_SUFFIXES);
}

/** The served content type, or null when the upstream type is not one we serve. */
export function artContentType(header: string | null): string | null {
  const base = (header ?? "").split(";")[0].trim().toLowerCase();
  return ART_TYPES.includes(base) ? base : null;
}

/**
 * The Cache API key: our origin, /api/art, and the `u` parameter ALONE. Keyed
 * on the whole request URL it was, so `&x=1`, `&x=2`... each made (and
 * fetched) a fresh entry for the same cover.
 */
export function artCacheKey(requestUrl: string, target: string): string {
  return `${new URL(requestUrl).origin}/api/art?u=${encodeURIComponent(target)}`;
}

// Typed loosely: it reads only the request and the execution context, and is
// mounted on an app whose Variables differ from file to file.
export async function serveArt(c: Context<any>): Promise<Response> {
  const target = c.req.query("u");
  if (!target || !isAllowedArtUrl(target)) return c.text("not an album cover", 400);

  // Cached at this edge for a week. Only a successful image is ever stored: a
  // refusal cached for a day per query is how the artwork lookup used to
  // replay one bad answer (see artwork.ts).
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(artCacheKey(c.req.url, target), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  let url = target;
  let upstream: Response;
  try {
    for (let hop = 0; ; hop++) {
      upstream = await fetch(url, {
        headers: { accept: ART_TYPES.join(", ") },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const location = upstream.headers.get("location");
      if (upstream.status < 300 || upstream.status >= 400 || !location) break;
      if (hop >= MAX_REDIRECTS) return c.text("cover host redirected too many times", 502);
      const next = new URL(location, url).toString();
      if (!isAllowedArtRedirect(next)) return c.text("cover host redirected off the allowlist", 502);
      url = next;
    }
  } catch {
    return c.text("cover host unreachable", 502);
  }
  const type = artContentType(upstream.headers.get("content-type"));
  const length = Number(upstream.headers.get("content-length") ?? "0");
  if (!upstream.ok || !type || length > MAX_BYTES) {
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
      "content-security-policy": ART_CSP,
    },
  });
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}
