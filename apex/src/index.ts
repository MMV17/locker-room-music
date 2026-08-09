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
import { normalizeTeamCode } from "../../backend/src/crypto";

const APEX = "auxgoat.com";
const WWW = `www.${APEX}`;

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page is identical for everyone and changes only on deploy. A short
      // edge cache absorbs a burst without making a fix take an hour to show.
      //
      // A throttle response must never be cached: a cached 429 would keep
      // locking someone out long after the window passed.
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
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
      if (team) {
        // team.url, not a URL built from the slug — see the comment on
        // Team.url. The school's pretty hostname is filtered on its own campus.
        //
        // The code rides along in a FRAGMENT so the player types it once. A
        // fragment is never sent to the server and never appears in a Referer
        // header; the team app loads artwork via <img> from Deezer and iTunes,
        // so a ?code= would hand the team code to Apple and Deezer with every
        // cover it fetches.
        //
        // The destination still verifies it. This map and the school's
        // TEAM_CODE secret are independent sources, so a rotated code would
        // otherwise be waved through here and fail at the final submit —
        // reviving the "sent back three fields later" bug that cost a real
        // debugging session.
        return redirect(`${team.url}#code=${encodeURIComponent(normalizeTeamCode(code))}`);
      }

      // Past this point the code was WRONG, and only wrong codes are counted.
      //
      // The apex answers "is this a valid team code?" to anyone who asks, and
      // that code is currently the only gate on a school's data. Cloudflare's
      // WAF rate limiting is a paid add-on on this plan, so the throttle lives
      // here instead, on the Workers rate-limit binding.
      //
      // Counting only failures is what makes a low limit safe. A whole school
      // shares one public IP on campus wifi, so throttling every /go would let
      // 75 players arriving at the start of practice lock each other out.
      // Legitimate players type a code that works; a brute-forcer is, by
      // definition, generating misses.
      if (env.RATE_LIMITER) {
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return html(renderLanding(code, "Too many tries. Wait a minute and try again."), 429);
        }
      } else {
        // Loud on purpose. The binding is optional so a local `wrangler dev`,
        // or a rollback, degrades to no throttling rather than a 500 on every
        // miss — but "degrades silently" was the wrong call for a security
        // control and it cost real time: the throttle was deployed, did
        // nothing, and there was no way to tell a missing binding from a
        // working one. An absent limiter means this door is answering
        // unlimited guesses at the only gate a school's data has.
        //
        // Visible with: cd apex && npx wrangler tail
        console.error(
          "RATE_LIMITER binding is MISSING — /go is answering unlimited guesses. " +
            "Check [[unsafe.bindings]] in apex/wrangler.toml reached the deploy.",
        );
      }

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
