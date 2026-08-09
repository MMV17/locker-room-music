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

  it("redirects a known code to that school's subdomain", async () => {
    const res = await go("CRUSADERS");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://hc.auxgoat.com/");
  });

  it("redirects regardless of casing or padding", async () => {
    for (const typed of ["crusaders", "  Crusaders  "]) {
      expect((await go(typed)).headers.get("location")).toBe("https://hc.auxgoat.com/");
    }
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
