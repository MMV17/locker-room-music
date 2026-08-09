import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

/**
 * The Worker is driven directly with absolute URLs.
 *
 * Host-based behaviour cannot be tested through `wrangler dev`: it
 * reconstructs every request URL against its own bind address, so the Worker
 * always sees localhost. Measured 2026-08-08 — the long-standing
 * auxgoat.com -> hc.auxgoat.com redirect, which demonstrably worked in
 * production, could not be made to fire against the dev server even with
 * `curl --resolve`. Calling fetch() is both the only way to cover this without
 * a deploy and considerably faster than one.
 */
const env = {} as Env;
const get = (url: string) => worker.fetch(new Request(url), env);

describe("landing page", () => {
  it("renders at the apex root", async () => {
    const res = await get("https://auxgoat.com/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("AuxGoat");
  });

  it("carries no JavaScript", async () => {
    // The whole design rests on this. If a script tag ever appears here, the
    // no-JS guarantee has quietly been given up.
    const html = await (await get("https://auxgoat.com/")).text();
    expect(html).not.toContain("<script");
  });

  it("inlines its CSS rather than linking a stylesheet", async () => {
    // One round trip instead of two, which is the point on bad wifi.
    const html = await (await get("https://auxgoat.com/")).text();
    expect(html).toContain("<style>");
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("asks for the font it actually ships", async () => {
    const html = await (await get("https://auxgoat.com/")).text();
    expect(html).toContain("/fonts/outfit-latin.woff2");
    // Text must paint immediately in a fallback rather than hang on 32 kB.
    expect(html).toContain("font-display: swap");
  });

  it("shows no error and an empty field on a clean load", async () => {
    const html = await (await get("https://auxgoat.com/")).text();
    expect(html).not.toMatch(/recognise/i);
    expect(html).toContain('value=""');
  });

  it("posts the form to /go as a plain GET", async () => {
    const html = await (await get("https://auxgoat.com/")).text();
    expect(html).toContain('action="/go"');
    expect(html).toContain('method="get"');
  });
});

describe("landing page — a rejected code comes back", () => {
  it("refills the field with what was typed", async () => {
    const html = await (await get("https://auxgoat.com/?e=KNIGHTS")).text();
    expect(html).toContain('value="KNIGHTS"');
  });

  it("shows the error message", async () => {
    const html = await (await get("https://auxgoat.com/?e=KNIGHTS")).text();
    expect(html).toMatch(/recognise/i);
  });

  it("shows the error even when the rejected code was empty", async () => {
    // ?e= with nothing after it still means "you just got turned away".
    const html = await (await get("https://auxgoat.com/?e=")).text();
    expect(html).toMatch(/recognise/i);
  });

  it("escapes the reflected code so it cannot break out of the attribute", async () => {
    const html = await (
      await get("https://auxgoat.com/?e=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E")
    ).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;");
  });

  it("escapes ampersands so a reflected code cannot smuggle an entity", async () => {
    const html = await (await get("https://auxgoat.com/?e=%26quot%3B")).text();
    expect(html).toContain("&amp;quot;");
  });
});

describe("/go resolves a team code", () => {
  const go = (code: string) =>
    get(`https://auxgoat.com/go?code=${encodeURIComponent(code)}`);

  const DEST = "https://locker-room-music.mmvinton17.workers.dev/";

  it("redirects a known code to that school's site", async () => {
    const res = await go("CRUSADERS");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${DEST}#code=CRUSADERS`);
  });

  it("redirects regardless of casing or padding", async () => {
    for (const typed of ["crusaders", "  Crusaders  "]) {
      expect((await go(typed)).headers.get("location")).toBe(`${DEST}#code=CRUSADERS`);
    }
  });

  it("hands the code on in a fragment, never a query string", async () => {
    // A fragment is not sent to the server and never appears in a Referer
    // header. The team app loads artwork via <img> from Deezer and iTunes, so
    // a ?code= would leak the team code to Apple and Deezer on every cover.
    const loc = (await go("CRUSADERS")).headers.get("location")!;
    expect(loc).toContain("#code=");
    expect(loc).not.toContain("?code=");
  });

  it("normalises the code it passes on", async () => {
    // So the field the player lands on shows what they were told to type,
    // not "  crusaders  ".
    const loc = (await go("  crusaders  ")).headers.get("location")!;
    expect(loc.endsWith("#code=CRUSADERS")).toBe(true);
  });

  it("bounces an unknown code back to the form, keeping what was typed", async () => {
    const res = await go("KNIGHTS");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?e=KNIGHTS");
  });

  it("bounces an empty code back without throwing", async () => {
    expect((await go("")).headers.get("location")).toBe("/?e=");
  });

  it("never lets a crafted code split the response header", async () => {
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

  it("round-trips a rejected code back into the refilled field", async () => {
    // The two halves are written in different places — encodeURIComponent on
    // the way out, escapeAttr on the way back — so this asserts they agree.
    const loc = (await go("O'BRIEN & SONS")).headers.get("location")!;
    const html = await (await get(`https://auxgoat.com${loc}`)).text();
    expect(html).toContain("O&#39;BRIEN &amp; SONS");
  });
});

describe("brute-force throttling", () => {
  /**
   * The apex answers "is this a valid team code?" to anyone who asks, and that
   * code is currently the only gate on a school's data. Cloudflare's WAF rate
   * limiting is a paid add-on on this plan, so the throttle lives in the
   * Worker via the rate-limit binding instead.
   */
  function limiterEnv(success: boolean) {
    const keys: string[] = [];
    const env = {
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success };
        },
      },
    } as unknown as Env;
    return { env, keys };
  }

  const go = (code: string, e: Env, ip = "203.0.113.9") =>
    worker.fetch(
      new Request(`https://auxgoat.com/go?code=${encodeURIComponent(code)}`, {
        headers: { "cf-connecting-ip": ip },
      }),
      e,
    );

  it("throttles a wrong code once the limit is hit", async () => {
    const { env } = limiterEnv(false);
    const res = await go("KNIGHTS", env);
    expect(res.status).toBe(429);
  });

  it("never consults the limiter for a correct code", async () => {
    // A whole school shares one public IP on campus wifi. Legitimate players
    // produce successes and must never be throttled by each other — only
    // guesses count, which is what makes this safe to run at a low limit.
    const { env, keys } = limiterEnv(false);
    const res = await go("CRUSADERS", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("locker-room-music");
    expect(keys).toEqual([]);
  });

  it("keys the limit on the client IP", async () => {
    const { env, keys } = limiterEnv(true);
    await go("KNIGHTS", env, "198.51.100.4");
    expect(keys).toEqual(["198.51.100.4"]);
  });

  it("lets a wrong code through normally while under the limit", async () => {
    const { env } = limiterEnv(true);
    const res = await go("KNIGHTS", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?e=KNIGHTS");
  });

  it("still works with no limiter bound at all", async () => {
    // The binding is optional so a local `wrangler dev` without it, or a
    // rollback, degrades to no throttling rather than a 500 on every miss.
    const res = await go("KNIGHTS", {} as Env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?e=KNIGHTS");
  });

  it("explains the throttle instead of showing a bare error code", async () => {
    const { env } = limiterEnv(false);
    const html = await (await go("KNIGHTS", env)).text();
    expect(html).toMatch(/too many/i);
  });

  it("does not let a throttled response be cached", async () => {
    // A cached 429 would keep locking someone out after the window passed.
    const { env } = limiterEnv(false);
    const res = await go("KNIGHTS", env);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
});

describe("www is not canonical", () => {
  it("redirects www to the bare apex", async () => {
    const res = await get("https://www.auxgoat.com/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://auxgoat.com/");
  });

  it("preserves the path and query", async () => {
    // Someone who bookmarked www/go?code=... must not lose their code.
    const res = await get("https://www.auxgoat.com/go?code=CRUSADERS");
    expect(res.headers.get("location")).toBe("https://auxgoat.com/go?code=CRUSADERS");
  });
});

describe("everything else", () => {
  it("sends stray paths back to the landing page", async () => {
    const res = await get("https://auxgoat.com/songs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("404s /api/* with JSON rather than redirecting into HTML", async () => {
    const res = await get("https://auxgoat.com/api/now");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("has no route that could reach a school's data", async () => {
    // This Worker has no bindings at all. If one of these ever stops
    // redirecting, something with a database attached has been added.
    for (const path of ["/api/session", "/admin", "/api/admin/backups"]) {
      const res = await get(`https://auxgoat.com${path}`);
      expect([302, 404]).toContain(res.status);
    }
  });
});
