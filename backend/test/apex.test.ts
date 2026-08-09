import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { apexRouter } from "../src/apex";
import type { Env } from "../src/types";

/**
 * The apex router, tested through Hono's request() with real absolute URLs.
 *
 * This is deliberately NOT an e2e test. `wrangler dev` reconstructs every
 * request URL against its own bind address, so the Worker always sees
 * `localhost:8787` no matter what Host header — or even `curl --resolve`
 * hostname — is presented. Measured 2026-08-07: the long-standing
 * auxgoat.com -> hc.auxgoat.com redirect, which demonstrably works in
 * production, cannot be made to fire against the dev server at all.
 *
 * So host-based behaviour is unreachable from test/e2e.sh. Driving the router
 * directly with a full URL is the only way to cover it without a deploy, and
 * it is faster and more precise besides.
 */

/** Records what the assets binding was asked for, so we can assert on it. */
function testEnv() {
  const asked: string[] = [];
  const env = {
    ASSETS: {
      fetch: async (req: Request) => {
        asked.push(new URL(req.url).pathname);
        // Shaped like the real landing.html, INCLUDING a comment that names
        // the tokens before the markup uses them. That is not padding: the
        // real file documents its own tokens, and a first-occurrence-only
        // replace substitutes the comment and ships the live ones raw. A
        // fixture too clean to contain the hazard cannot catch it.
        return new Response(
          `<!doctype html><title>AuxGoat</title>` +
            `<!-- __ERROR__ and __CODE__ are filled in by the Worker. -->` +
            `__ERROR__<input name="code" value="__CODE__">`,
          { headers: { "content-type": "text/html" } },
        );
      },
    },
  } as unknown as Env;
  return { env, asked };
}

/** The app under test: the router, then a sentinel standing in for the team app. */
function appWith(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", apexRouter());
  app.all("*", (c) => c.text("TEAM_APP", 200));
  return (url: string) => app.request(url, {}, env);
}

describe("apex router — the school's own hostname is untouched", () => {
  it("passes hc.auxgoat.com straight through to the team app", async () => {
    const { env } = testEnv();
    const res = await appWith(env)("https://hc.auxgoat.com/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("TEAM_APP");
  });

  it("passes the school's API through untouched", async () => {
    const { env } = testEnv();
    const res = await appWith(env)("https://hc.auxgoat.com/api/now");
    expect(await res.text()).toBe("TEAM_APP");
  });

  it("passes the always-worked fallback hostname through", async () => {
    // The Pi points at lockerroom.finestkindfarms.com and cannot be reached
    // over SSH to be repointed. Breaking it here would take the speaker dark.
    const { env } = testEnv();
    const res = await appWith(env)("https://lockerroom.finestkindfarms.com/api/now");
    expect(await res.text()).toBe("TEAM_APP");
  });
});

describe("apex router — the landing page", () => {
  it("serves the landing page at the apex root", async () => {
    const { env, asked } = testEnv();
    const res = await appWith(env)("https://auxgoat.com/");
    expect(res.status).toBe(200);
    expect(asked).toEqual(["/landing.html"]);
  });

  it("does not serve the team app shell at the apex", async () => {
    const { env } = testEnv();
    const res = await appWith(env)("https://auxgoat.com/");
    expect(await res.text()).not.toBe("TEAM_APP");
  });
});

describe("apex router — the error is rendered server-side", () => {
  /**
   * The page carries no JavaScript, so a rejected code has to be reflected
   * into the HTML before it leaves the Worker. HTMLRewriter would be the
   * native tool and is unavailable here — these tests run in plain node, not
   * workerd — so the page ships two substitution tokens instead. That choice
   * is what keeps this behaviour testable at all.
   */
  const get = async (path: string) => {
    const { env } = testEnv();
    return appWith(env)(`https://auxgoat.com${path}`);
  };

  it("leaves no unsubstituted tokens on a clean load", async () => {
    const html = await (await get("/")).text();
    expect(html).not.toContain("__CODE__");
    expect(html).not.toContain("__ERROR__");
  });

  it("shows no error on a clean load", async () => {
    const html = await (await get("/")).text();
    expect(html).not.toMatch(/recognise/i);
    expect(html).toContain('value=""');
  });

  it("refills the field with what was typed", async () => {
    const html = await (await get("/?e=KNIGHTS")).text();
    expect(html).toContain('value="KNIGHTS"');
  });

  it("shows an error message when a code was rejected", async () => {
    const html = await (await get("/?e=KNIGHTS")).text();
    expect(html).toMatch(/recognise/i);
  });

  it("shows the error even when the rejected code was empty", async () => {
    // ?e= with nothing after it still means "you just got turned away".
    const html = await (await get("/?e=")).text();
    expect(html).toMatch(/recognise/i);
  });

  it("escapes the reflected code so it cannot break out of the attribute", async () => {
    // The only user-controlled string on the page, and the only injection
    // surface it has.
    const html = await (await get('/?e=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E')).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;");
  });

  it("escapes ampersands so a reflected code cannot smuggle an entity", async () => {
    const html = await (await get("/?e=%26quot%3B")).text();
    expect(html).toContain("&amp;quot;");
  });

  it("serves the page as HTML", async () => {
    const res = await get("/?e=KNIGHTS");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});

describe("apex router — /go resolves a team code", () => {
  const go = async (code: string) => {
    const { env } = testEnv();
    return appWith(env)(`https://auxgoat.com/go?code=${encodeURIComponent(code)}`);
  };

  it("redirects a known code to that school's subdomain", async () => {
    const res = await go("CRUSADERS");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://hc.auxgoat.com/");
  });

  it("redirects regardless of casing or padding", async () => {
    for (const typed of ["crusaders", "  Crusaders  "]) {
      const res = await go(typed);
      expect(res.headers.get("location")).toBe("https://hc.auxgoat.com/");
    }
  });

  it("bounces an unknown code back to the form, keeping what was typed", async () => {
    const res = await go("KNIGHTS");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?e=KNIGHTS");
  });

  it("bounces an empty code back without throwing", async () => {
    const res = await go("");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?e=");
  });

  it("never reflects a raw code into the Location header unencoded", async () => {
    // ?e= is echoed into the page. A newline here would let a crafted code
    // split the response header.
    const res = await go("A\r\nX-Injected: 1");
    const loc = res.headers.get("location") ?? "";
    expect(loc).not.toContain("\n");
    expect(loc).not.toContain("\r");
    expect(res.headers.get("x-injected")).toBeNull();
  });

  it("redirects with 302, never 301", async () => {
    // A 301 is cached by browsers effectively forever, so a rule shipped by
    // mistake outlives any ability to fix it from the server.
    expect((await go("CRUSADERS")).status).toBe(302);
    expect((await go("KNIGHTS")).status).toBe(302);
  });
});

describe("apex router — the apex is not a team", () => {
  it("404s the API at the apex instead of serving the school's", async () => {
    // Not 401. A 401 would mean the API is still mounted and merely
    // unauthenticated, which is how a player ends up with a session on the
    // one hostname nobody else is using.
    const { env } = testEnv();
    const res = await appWith(env)("https://auxgoat.com/api/now");
    expect(res.status).toBe(404);
  });

  it("404s every API path at the apex", async () => {
    const { env } = testEnv();
    for (const path of ["/api/session", "/api/plays", "/api/admin/backups"]) {
      const res = await appWith(env)(`https://auxgoat.com${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("sends any other apex path back to the landing page", async () => {
    const { env } = testEnv();
    const res = await appWith(env)("https://auxgoat.com/songs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("apex router — www is not canonical", () => {
  it("redirects www to the bare apex", async () => {
    const { env } = testEnv();
    const res = await appWith(env)("https://www.auxgoat.com/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://auxgoat.com/");
  });

  it("preserves the path and query when redirecting www", async () => {
    // Someone who bookmarked www/go?code=... must not lose their code.
    const { env } = testEnv();
    const res = await appWith(env)("https://www.auxgoat.com/go?code=CRUSADERS");
    expect(res.headers.get("location")).toBe("https://auxgoat.com/go?code=CRUSADERS");
  });
});
