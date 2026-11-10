/**
 * Response headers and request-origin rules applied to every Worker response.
 *
 * Only responses the WORKER produces pass through here. Static files that
 * match a path (including `/` -> index.html) are served by the assets runtime
 * without invoking the Worker, which is why web/index.html carries the same
 * CSP as a <meta> tag. Keep the two in step.
 */

/**
 * The page's Content-Security-Policy, as web/index.html declares it.
 *
 * 'unsafe-inline' for styles only: React's `style={{...}}` props render as
 * inline style attributes, which style-src governs. Scripts stay 'self' only.
 * img-src allows data:/blob: for generated images; covers come through our own
 * /api/art, so no third-party image host is needed.
 */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; " +
  "base-uri 'none'; form-action 'self'; object-src 'none'";

/** frame-ancestors only works as a header (browsers ignore it in <meta>). */
export const HEADER_CSP = `${PAGE_CSP}; frame-ancestors 'none'`;

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/**
 * The response with the security headers applied.
 *
 * - Every response: SECURITY_HEADERS, and the CSP unless the handler set its
 *   own (the cover proxy sets a stricter sandboxing one).
 * - JSON under /api/ that set no Cache-Control of its own gets
 *   `private, no-store`: these answers are about the signed-in player, and no
 *   browser or proxy cache should keep them. Routes that are deliberately
 *   cacheable say so themselves (/api/theme, the boards, /api/art).
 *
 * Always returns a NEW Response: one fetched from ASSETS has immutable headers.
 */
export function withSecurityHeaders(res: Response, path: string): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (!out.headers.has("Content-Security-Policy")) out.headers.set("Content-Security-Policy", HEADER_CSP);
  const type = out.headers.get("content-type") ?? "";
  if (path.startsWith("/api/") && type.includes("application/json") && !out.headers.has("Cache-Control")) {
    out.headers.set("Cache-Control", "private, no-store");
  }
  return out;
}

/**
 * Whether a request may proceed, judged by its Origin header.
 *
 * A state-changing request (anything but GET/HEAD) that carries an Origin must
 * come from this site's own origin. SameSite=Lax already keeps the session
 * cookie off cross-site POSTs, but the admin password is a header a page could
 * be tricked into replaying, and Lax does not cover every top-level case. A
 * request with NO Origin - the Pi, curl, the deploy scripts - is not a browser
 * acting for somebody, and passes.
 */
export function originAllowed(method: string, origin: string | undefined, requestUrl: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (origin === undefined) return true;
  try {
    return origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}
