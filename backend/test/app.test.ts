import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { originAllowed, withSecurityHeaders, PAGE_CSP, HEADER_CSP } from "../src/security";

/**
 * The app as a whole, over app.request() with a stub database: gates, headers,
 * the not-found answer and the origin rule. No D1 needed - the stub records
 * which statements ran, which is how "the session lookup runs once" is proven.
 */

function stubEnv(opts: { session?: boolean } = {}) {
  const sql: string[] = [];
  const stmt = (q: string) => {
    const s = {
      bind: () => s,
      first: async () => {
        if (q.includes("FROM device_tokens t")) {
          return opts.session ? { user_id: "u1", active: 1, last_seen_at: new Date().toISOString() } : null;
        }
        if (q.includes("FROM users WHERE id")) {
          return { id: "u1", first_name: "A", last_name: "B", jersey_number: null };
        }
        return null;
      },
      run: async () => ({ meta: { changes: 0 } }),
      all: async () => ({ results: [] }),
    };
    return s;
  };
  const DB = {
    prepare: (q: string) => {
      sql.push(q);
      return stmt(q);
    },
    batch: async () => [],
  };
  const env = {
    DB,
    DEVICE_KEY: "k",
    MAC_SALT: "s",
    TEAM_CODE: "CODE",
    ADMIN_PASSWORD: "pw",
    ASSETS: { fetch: async () => new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html" } }) },
  };
  return { env, sql };
}

const sessionLookups = (sql: string[]) => sql.filter((q) => q.includes("FROM device_tokens t")).length;

describe("session gates (2j)", () => {
  it("still refuses /api/me, /api/speakers and /api/me/dj without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["PATCH", "/api/me"],
      ["GET", "/api/me/dj"],
      ["GET", "/api/speakers"],
      ["PUT", "/api/speakers"],
      ["POST", "/api/speakers/scan"],
    ]) {
      const { env } = stubEnv();
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }, env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("runs the session lookup exactly once for /api/me and /api/speakers", async () => {
    for (const path of ["/api/me", "/api/speakers"]) {
      const { env, sql } = stubEnv({ session: true });
      await app.request(path, { headers: { cookie: "lr_token=t" } }, env);
      expect(sessionLookups(sql), path).toBe(1);
    }
  });

  it("no longer serves GET /api/roster (2c)", async () => {
    const { env } = stubEnv({ session: true });
    const res = await app.request("/api/roster", { headers: { cookie: "lr_token=t" } }, env);
    expect(res.status).toBe(404);
  });
});

describe("not found (2i)", () => {
  it("answers an unknown /api path as JSON for any method", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      const { env } = stubEnv();
      const res = await app.request("/api/definitely-not-here", { method }, env);
      expect(res.status, method).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  it("still serves the app shell for a client-side route", async () => {
    const { env } = stubEnv();
    const res = await app.request("/songs", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
    expect(res.headers.get("Content-Security-Policy")).toBe(HEADER_CSP);
  });

  it("answers malformed JSON with 400, not 500", async () => {
    const { env } = stubEnv();
    for (const body of ["{not json", "[1,2]", "null", '"str"']) {
      const res = await app.request("/api/plays", { method: "POST", headers: { "X-Device-Key": "k", "content-type": "application/json" }, body }, env);
      expect(res.status, body).toBe(400);
    }
  });
});

describe("security headers (2d)", () => {
  it("are on every Worker response, with no-store on JSON", async () => {
    const { env } = stubEnv();
    const res = await app.request("/api/now", {}, env); // 401
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(), payment=()");
    expect(res.headers.get("Content-Security-Policy")).toBe(HEADER_CSP);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("leave a route's own Cache-Control and CSP alone", () => {
    const own = new Response("{}", {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60", "content-security-policy": "default-src 'none'; sandbox" },
    });
    const out = withSecurityHeaders(own, "/api/theme");
    expect(out.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(out.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  it("match the <meta> CSP in web/index.html, plus frame-ancestors", () => {
    const fs = (globalThis as any).process.getBuiltinModule("node:fs");
    const html: string = fs.readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    expect(html).toContain(`content="${PAGE_CSP}"`);
    expect(HEADER_CSP).toBe(`${PAGE_CSP}; frame-ancestors 'none'`);
  });
});

describe("origin check (2f)", () => {
  it("refuses a cross-origin write and allows same-origin or no Origin", () => {
    expect(originAllowed("POST", "https://evil.example", "https://hc.auxgoat.com/api/votes")).toBe(false);
    expect(originAllowed("POST", "null", "https://hc.auxgoat.com/api/votes")).toBe(false);
    expect(originAllowed("POST", "https://hc.auxgoat.com", "https://hc.auxgoat.com/api/votes")).toBe(true);
    expect(originAllowed("POST", undefined, "https://hc.auxgoat.com/api/plays")).toBe(true);
    expect(originAllowed("GET", "https://evil.example", "https://hc.auxgoat.com/api/now")).toBe(true);
    expect(originAllowed("DELETE", "http://hc.auxgoat.com", "https://hc.auxgoat.com/api/admin/users/x")).toBe(false);
  });

  it("is enforced before any route runs", async () => {
    const { env, sql } = stubEnv();
    const res = await app.request("http://hc.test/api/session", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" }, env);
    expect(res.status).toBe(403);
    expect(sql).toHaveLength(0);
    const ok = await app.request("http://hc.test/api/now", { method: "GET", headers: { Origin: "https://evil.example" } }, env);
    expect(ok.status).toBe(401);
  });
});
