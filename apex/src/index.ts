/**
 * auxgoat.com — the front door.
 *
 *   /            the landing page
 *   /go?code=    resolve a team code -> that school's subdomain
 *   anything else back to /
 *
 * Static files under ./public (the font, and only the font) are served by
 * Cloudflare directly and never reach this handler.
 *
 * No Hono, no dependencies. This Worker has one job and the router is a dozen
 * lines; the team Worker's dependency list is not this one's problem.
 *
 * Every redirect is 302, never 301. A 301 is cached by browsers effectively
 * forever, so a rule shipped by mistake outlives any ability to fix it from
 * the server side — which matters most on the hostname people reach first.
 */

import type { Env } from "./types";
import { resolveTeam } from "./teams";
import { renderLanding } from "./page";

const APEX = "auxgoat.com";
const WWW = `www.${APEX}`;

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page is identical for everyone and changes only on deploy. A short
      // edge cache absorbs a burst without making a fix take an hour to show.
      "cache-control": "public, max-age=60",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // One canonical host. Path and query survive, so a bookmarked
    // www/go?code=... does not lose the code on the way through.
    if (url.hostname === WWW) {
      const to = new URL(url);
      to.hostname = APEX;
      return redirect(to.toString());
    }

    if (url.pathname === "/go") {
      const code = url.searchParams.get("code") ?? "";
      const team = await resolveTeam(env, code);
      if (team) return redirect(`https://${team.slug}.${APEX}/`);

      // Back to the form with what they typed, so it can be corrected rather
      // than retyped. encodeURIComponent is load-bearing, not tidiness: this
      // string is attacker-controlled and goes into a response header, where a
      // bare CRLF would split it.
      return redirect(`/?e=${encodeURIComponent(code)}`);
    }

    if (url.pathname === "/") {
      // `e` present at all — even empty — means /go just turned someone away.
      return html(renderLanding(url.searchParams.get("e")));
    }

    // There is no API here at all — this Worker has no database to expose.
    // Still answered explicitly rather than swept into the redirect below:
    // anything programmatic that lands on /api/* deserves a 404 it can read,
    // not a 302 into an HTML page.
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return redirect("/");
  },
};
