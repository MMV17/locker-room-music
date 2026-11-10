import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { requireSession, requireAdmin } from "./middleware";
import { boards } from "./leaderboards";
import { devices } from "./devices";
import { admin } from "./admin";
import { theme } from "./theme";
import { runBackup } from "./backup";
import { speakerRoutes } from "./speakerRoutes";
import { healArtwork } from "./artworkHeal";
import { piRoutes } from "./piRoutes";
import { sessionRoutes, meRoutes } from "./sessionRoutes";
import { playRoutes } from "./playRoutes";
import { isHourlyTick, prune, sweepOrphanPlays } from "./maintenance";
import { originAllowed, withSecurityHeaders, SECURITY_HEADERS, HEADER_CSP } from "./security";

export const app = new Hono<AppEnv>();

/**
 * There is deliberately no bare-domain handling here any more.
 *
 * auxgoat.com and www now belong to a separate Worker (see apex/), so this one
 * never receives them. The redirect that used to live here could not have
 * become a landing page in any case: Cloudflare serves any file matching the
 * request path without invoking the Worker, so `/` was always answered with
 * the [assets] index.html below and this middleware never ran for it.
 *
 * If a bare-domain rule ever seems necessary here again, that is a sign the
 * apex routes have drifted back onto this Worker. Fix the routes, not this.
 */

/* ------------------------------------------------------------------ *
 * Routes, IN REGISTRATION ORDER. Order is behaviour in Hono: a prefix gate
 * (`app.use`) only runs for routes registered after it. test/routes.test.ts
 * snapshots the resulting table.
 * ------------------------------------------------------------------ */

/**
 * First in line, so it wraps every response - handlers, onError and notFound
 * alike: refuse cross-origin writes, then stamp the security headers
 * (security.ts).
 */
app.use("*", async function securityHeaders(c, next) {
  if (!originAllowed(c.req.method, c.req.header("Origin"), c.req.url)) {
    return c.json({ error: "Cross-origin request refused" }, 403, {
      ...SECURITY_HEADERS,
      "Content-Security-Policy": HEADER_CSP,
      "Cache-Control": "private, no-store",
    });
  }
  await next();
  const res = withSecurityHeaders(c.res, c.req.path);
  // Cleared first: Hono's setter otherwise merges the old response's headers
  // into the new one, which is harmless here but not what this means.
  c.res = undefined as unknown as Response;
  c.res = res;
});

// Pi -> server. Each route carries requireDeviceKey itself.
app.route("/", piRoutes);
// Joining and leaving. Open by design: these are how a session starts.
app.route("/", sessionRoutes);
// Now playing, covers, votes, results. Gated route by route.
app.route("/", playRoutes);

/* ------------------------------------------------------------------ *
 * Prefix gates, and the sub-apps they cover
 * ------------------------------------------------------------------ */

app.use("/api/leaderboard/*", requireSession);
app.use("/api/history", requireSession);
app.use("/api/me/*", requireSession);

app.route("/", meRoutes);
app.route("/", boards);

app.use("/api/devices/*", requireSession);
// Speaker selection for the team. Gated by presence rather than by the admin
// password: choosing the output speaker is a DJ's job, and handing every DJ the
// coach's password to do it is not a plan. See speakerAccess.ts.
// "/api/speakers/*" also matches "/api/speakers" itself; a second gate on the
// bare path ran the session lookup twice per request.
app.use("/api/speakers/*", requireSession);
app.route("/", speakerRoutes);
app.route("/", devices);

app.use("/api/admin/*", requireAdmin);
app.route("/", admin);

// GET /api/theme is public (the join screen is branded before anyone signs
// in); PUT /api/admin/theme is covered by the requireAdmin middleware above,
// which is why this is mounted after it.
app.route("/", theme);

app.onError((err, c) => {
  // Enough to find the request in the Cloudflare dashboard: method, path, the
  // cf-ray id the client also saw, and the stack rather than a bare message.
  const ray = c.req.header("cf-ray") ?? "-";
  console.error(
    `unhandled ${c.req.method} ${c.req.path} cf-ray=${ray}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  return c.json({ error: "Something went wrong" }, 500);
});

/**
 * No route matched. A non-GET to an unknown path never reaches the app-shell
 * fallback below (that is GET-only), and Hono's default answer is a text/plain
 * "404 Not Found" - so a mistyped POST from the Pi read as an HTML-ish page.
 */
app.notFound((c) => c.json({ error: "Not found" }, 404));

/* ------------------------------------------------------------------ *
 * Static site
 * ------------------------------------------------------------------ */

/**
 * Client-side routes (/songs, /djs, /admin, ...) have no matching file, so
 * they fall through to here and get the app shell.
 *
 * This must stay at the very bottom: it matches everything, and anything
 * registered after it would be unreachable. An unknown /api path is answered
 * as JSON instead - handing a caller of a mistyped endpoint a page of HTML
 * with a 200 on it is worse than useless when debugging the Pi.
 *
 * Real asset requests never reach this handler at all. wrangler.toml sets
 * not_found_handling = "none", so the assets runtime serves matching files
 * itself and only forwards misses.
 */
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
});

/** Must match the daily entry in wrangler.toml's [triggers] crons. */
const BACKUP_CRON = "0 8 * * *";

/**
 * Hono handles fetch; the cron trigger needs its own entry point, so the
 * default export becomes an object rather than the app itself.
 */
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Two crons (wrangler.toml). The hourly one heals missing album covers;
    // the daily one is the backup, and only the backup.
    if (event.cron !== BACKUP_CRON) {
      ctx.waitUntil(
        healArtwork(env).then(
          (r) => console.log(`artwork heal: tried=${r.tried} found=${r.found} offset=${r.offset} next=${r.next}`),
          (e) => console.error(`artwork heal FAILED: ${String(e)}`),
        ),
      );
      // Once an hour, on the :00 tick: close plays the Pi opened and never
      // closed. See maintenance.ts.
      if (isHourlyTick(event.scheduledTime)) {
        ctx.waitUntil(
          sweepOrphanPlays(env).then(
            (n) => console.log(`orphan sweep: closed=${n}`),
            (e) => console.error(`orphan sweep FAILED: ${String(e)}`),
          ),
        );
      }
      return;
    }
    ctx.waitUntil(
      prune(env).then(
        (r) => console.log(`prune: auth_attempts=${r.attempts} device_tokens=${r.tokens}`),
        (e) => console.error(`prune FAILED: ${String(e)}`),
      ),
    );
    ctx.waitUntil(
      runBackup(env, new Date()).then((r) => {
        // Logged either way: a backup that quietly stopped running is worse
        // than one that never existed, because it looks like insurance.
        if (r.ok) console.log(`backup ok key=${r.key} bytes=${r.bytes} rows=${r.rows} pruned=${r.pruned}`);
        else console.error(`backup FAILED: ${r.error}`);
      }),
    );
  },
};
