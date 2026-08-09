/**
 * auxgoat.com — the front door.
 *
 * Replaces the bare-domain 302 that sent every apex visitor to Holy Cross.
 * That was honest scaffolding while one school existed and becomes wrong the
 * moment a second one does, which is what wrangler.toml's comment on the apex
 * routes has been saying since it was written.
 *
 * The apex is not a team, and this middleware is what makes that true:
 *
 *   /             the landing page
 *   /go?code=     resolve a team code -> that school's subdomain
 *   /api/*        404, NOT the school's API
 *   anything else back to /
 *
 * Registered before every other route, so nothing below it can be reached on
 * the wrong hostname. Any host that is not the apex or www falls straight
 * through untouched — including lockerroom.finestkindfarms.com, which the Pi
 * points at and which cannot be repointed remotely.
 *
 * Every redirect here is 302, never 301, for the reason the middleware it
 * replaces gave: a 301 is cached by browsers effectively forever, so a rule
 * shipped by mistake outlives any ability to fix it from the server side.
 */

import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";
import { resolveTeam } from "./teams";

const APEX = "auxgoat.com";
const WWW = `www.${APEX}`;

export function apexRouter(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const url = new URL(c.req.url);

    // One canonical host. Path and query survive, so a bookmarked
    // www/go?code=... does not lose the code on the way through.
    if (url.hostname === WWW) {
      const to = new URL(url);
      to.hostname = APEX;
      return c.redirect(to.toString(), 302);
    }

    if (url.hostname !== APEX) return next();

    if (url.pathname === "/go") {
      const code = url.searchParams.get("code") ?? "";
      const team = await resolveTeam(c.env, code);
      if (team) return c.redirect(`https://${team.slug}.${APEX}/`, 302);

      // Bounce back to the form with what they typed, so it can be corrected
      // rather than retyped. encodeURIComponent is load-bearing, not tidiness:
      // this string is attacker-controlled and goes into a response header,
      // where a bare CRLF would split it.
      return c.redirect(`/?e=${encodeURIComponent(code)}`, 302);
    }

    // The apex must not answer for the school's API. 404 and not 401: a 401
    // says "mounted, but you are not signed in", which invites a session on a
    // second hostname that nobody else on the team is using.
    if (url.pathname.startsWith("/api/")) {
      return c.json({ error: "Not found" }, 404);
    }

    if (url.pathname === "/") {
      const asset = new URL(url);
      asset.pathname = "/landing.html";
      const res = await c.env.ASSETS.fetch(new Request(asset, { headers: c.req.raw.headers }));

      // `e` present at all — even empty — means /go just turned someone away.
      const rejected = url.searchParams.get("e");
      const html = (await res.text())
        .replace(CODE_TOKEN, () => (rejected === null ? "" : escapeAttr(rejected)))
        .replace(ERROR_TOKEN, () => (rejected === null ? "" : ERROR_HTML));

      return c.html(html);
    }

    return c.redirect("/", 302);
  };
}

/**
 * The page carries no JavaScript, so a rejected code is reflected into the
 * HTML here rather than read from the query string by the browser.
 *
 * HTMLRewriter would be the native tool for this and is deliberately not used:
 * the backend test suite runs in plain node rather than workerd, so anything
 * built on it would be unverifiable without restructuring the whole suite.
 * Two substitution tokens keep the behaviour under test, which matters more
 * for the one string on this page an attacker controls.
 */
/**
 * Global, and replaced with a *function* rather than a string. Both matter.
 *
 * Global because landing.html documents its own tokens in a comment, so the
 * first occurrence of each is prose, not markup — a first-match replace
 * substitutes the comment and serves the live tokens raw on the page. That
 * shipped past 24 passing tests and was caught by looking at it.
 *
 * A function replacer because `$&`, `$'` and friends are special inside a
 * replacement *string*, and the value being substituted is whatever an
 * attacker put in the query string. escapeAttr neutralises HTML, not `$`.
 */
const CODE_TOKEN = /__CODE__/g;
const ERROR_TOKEN = /__ERROR__/g;

const ERROR_HTML = `<p class="error" role="alert">We don't recognise that code.</p>`;

/**
 * Escape for an HTML attribute value. `&` goes first — reordering it would
 * double-escape the entities introduced by the replacements after it.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
