#!/usr/bin/env node
/**
 * AuxGoat smoke + load check against a DEPLOYED team site. Node 18+, no deps.
 *
 *   node tools/loadtest.mjs --url https://hc.auxgoat.com --code TEAMCODE \
 *        [--players 20] [--minutes 3] [--interval 7.5] [--burst] [--yes]
 *
 * What it does
 *   0. Smoke (one client): shell page, /api/theme, 401 shape, JSON 404s for
 *      unknown GET and POST /api paths, check-code right/wrong.
 *   1. Signs in ONCE as "Loadtest Bot #999" and shares that cookie across all
 *      virtual players (keeps the roster clean: delete that one player in Admin
 *      afterwards). Session lookups cost the same for one token or many.
 *   2. Poll phase: N virtual players poll /api/now exactly like the app
 *      (chained, not stacked; 8 s client timeout; +/-10% jitter).
 *   3. Optional --burst: every player opens Songs, DJs and History at once,
 *      the "song just ended, everyone checks the board" moment.
 *   Never votes, claims or changes anything else.
 *
 * Cost (the free plan allows 100k Worker requests a day, shared with the real
 * team):
 *   requests ~= players * minutes * 60 / interval  (+ 3 * players with --burst)
 * The script prints this and refuses to start without --yes. Run it outside
 * practice hours. See docs/LAUNCH.md for how to read the result.
 *
 * Pass thresholds (exit 0 only if all hold)
 *   - every smoke check passes
 *   - /api/now: p95 <= 800 ms, p99 <= 2000 ms, no response slower than 8 s
 *   - error rate (5xx, 429, timeouts, network errors, bad JSON) <= 0.5 %
 *   - zero 5xx and zero 429
 *   - /api/now never exposes a tally while vote_window_open is true
 *   - burst: each board/history endpoint p95 <= 1500 ms
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const BASE = String(args.url ?? "").replace(/\/$/, "");
const CODE = args.code;
const PLAYERS = Number(args.players ?? 20);
const MINUTES = Number(args.minutes ?? 3);
const INTERVAL_S = Number(args.interval ?? 7.5);
const TIMEOUT_MS = 8000;
if (!BASE || !CODE) {
  console.error("usage: --url https://<team>.auxgoat.com --code <TEAM_CODE> [--players N] [--minutes M] [--interval S] [--burst] [--yes]");
  process.exit(2);
}
if ((PLAYERS > 75 || MINUTES > 10) && !args["i-know"]) {
  console.error("Refusing: more than 75 players or 10 minutes spends a large slice of the daily free tier. Add --i-know to override.");
  process.exit(2);
}
const estRequests = Math.round((PLAYERS * MINUTES * 60) / INTERVAL_S) + (args.burst ? 3 * PLAYERS : 0) + 10;
console.log(`Plan: ${PLAYERS} players x ${MINUTES} min @ ${INTERVAL_S}s -> ~${estRequests} Worker requests (the free plan allows 100,000 a day).`);
if (!args.yes) {
  console.log("Re-run with --yes to start. Run it OUTSIDE practice hours.");
  process.exit(0);
}

const samples = new Map(); // endpoint -> [{ms, status, ok, kind}]
const note = (ep, s) => (samples.get(ep) ?? samples.set(ep, []).get(ep)).push(s);
let cookie = "";
let tallyLeaks = 0;

async function call(ep, path, init = {}, expect = (r) => r.ok) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      ...init,
      redirect: "manual",
      signal: ctl.signal,
      headers: { ...(cookie ? { cookie } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let json = null;
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    if (isJson) {
      try { json = JSON.parse(text); } catch { note(ep, { ms, status: res.status, ok: false, kind: "badjson" }); return { res, json, text }; }
    }
    note(ep, { ms, status: res.status, ok: expect(res, json), kind: res.status >= 500 ? "5xx" : res.status === 429 ? "429" : "http" });
    return { res, json, text };
  } catch (e) {
    note(ep, { ms: performance.now() - t0, status: 0, ok: false, kind: e.name === "AbortError" ? "timeout" : "network" });
    return { res: null, json: null, text: "" };
  } finally {
    clearTimeout(t);
  }
}

const smoke = [];
const check = (name, cond, detail = "") => { smoke.push({ name, pass: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`); };

async function runSmoke() {
  const shell = await call("GET /", "/");
  check("shell page 200 with an entry bundle", shell.res?.status === 200 && /\/assets\/index-[\w-]+\.js/.test(shell.text));
  const theme = await call("GET /api/theme", "/api/theme");
  check("/api/theme 200 JSON", theme.res?.status === 200 && theme.json);
  const anon = await call("GET /api/now (anon)", "/api/now", {}, (r) => r.status === 401);
  check("/api/now without a session is 401 JSON", anon.res?.status === 401 && anon.json?.error);
  const g404 = await call("GET unknown", "/api/__loadtest_missing", {}, (r) => r.status === 404);
  check("unknown GET /api path is 404 JSON", g404.res?.status === 404 && g404.json);
  const p404 = await call("POST unknown", "/api/__loadtest_missing", { method: "POST", body: "{}" }, (r) => r.status === 404);
  check("unknown POST /api path is 404 JSON", p404.res?.status === 404 && p404.json, `got ${p404.res?.status} ${p404.res?.headers.get("content-type")}`);
  const ok = await call("POST check-code", "/api/session/check-code", { method: "POST", body: JSON.stringify({ team_code: CODE }) }, (r) => r.status === 204);
  check("check-code accepts the real code", ok.res?.status === 204);
  const session = await call("POST /api/session", "/api/session", {
    method: "POST",
    body: JSON.stringify({ team_code: CODE, first_name: "Loadtest", last_name: "Bot", jersey_number: "999" }),
  });
  cookie = (session.res?.headers.get("set-cookie") ?? "").split(";")[0];
  check("sign-in sets a session cookie", session.res?.status === 200 && cookie.startsWith("lr_token="));
  const now = await call("GET /api/now", "/api/now");
  check("/api/now with session is 200 JSON", now.res?.status === 200 && typeof now.json?.speaker_online === "boolean");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAK_KEYS = ["upvotes", "downvotes", "up", "down", "voters", "score", "tally"];

async function player(until) {
  await sleep(Math.random() * INTERVAL_S * 1000); // spread the herd
  while (Date.now() < until) {
    const { json } = await call("GET /api/now", "/api/now");
    if (json?.play?.vote_window_open && LEAK_KEYS.some((k) => k in json.play)) tallyLeaks++;
    await sleep(INTERVAL_S * 1000 * (0.9 + Math.random() * 0.2)); // chained: next poll only after this one settled
  }
}

async function burst() {
  await Promise.all(
    Array.from({ length: PLAYERS }, async () => {
      await sleep(Math.random() * 2000);
      await Promise.all([
        call("GET leaderboard/tracks", "/api/leaderboard/tracks?window=season"),
        call("GET leaderboard/djs", "/api/leaderboard/djs?window=season"),
        call("GET history", "/api/history"),
      ]);
    }),
  );
}

const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

function report() {
  let total = 0, bad = 0, fivexx = 0, throttled = 0;
  console.log("\nendpoint                      n     p50    p95    p99    max   err  kinds");
  for (const [ep, xs] of samples) {
    const ms = xs.map((s) => s.ms).sort((a, b) => a - b);
    const errs = xs.filter((s) => !s.ok);
    total += xs.length; bad += errs.length;
    fivexx += xs.filter((s) => s.kind === "5xx").length;
    throttled += xs.filter((s) => s.kind === "429").length;
    const kinds = [...new Set(errs.map((s) => `${s.kind}:${s.status}`))].join(",");
    console.log(`${ep.padEnd(26)} ${String(xs.length).padStart(5)} ${[50, 95, 99].map((p) => pct(ms, p).toFixed(0).padStart(6)).join(" ")} ${ms.at(-1)?.toFixed(0).padStart(6)} ${String(errs.length).padStart(5)}  ${kinds}`);
  }
  const now = (samples.get("GET /api/now") ?? []).map((s) => s.ms).sort((a, b) => a - b);
  const gates = [
    ["smoke checks", smoke.every((s) => s.pass)],
    ["/api/now p95 <= 800ms", pct(now, 95) <= 800],
    ["/api/now p99 <= 2000ms", pct(now, 99) <= 2000],
    ["/api/now max < 8000ms", (now.at(-1) ?? 0) < TIMEOUT_MS],
    ["error rate <= 0.5%", total ? bad / total <= 0.005 : false],
    ["zero 5xx", fivexx === 0],
    ["zero 429", throttled === 0],
    ["no tally while voting open", tallyLeaks === 0],
  ];
  if (args.burst) {
    for (const ep of ["GET leaderboard/tracks", "GET leaderboard/djs", "GET history"]) {
      const xs = (samples.get(ep) ?? []).map((s) => s.ms).sort((a, b) => a - b);
      gates.push([`${ep} p95 <= 1500ms`, pct(xs, 95) <= 1500]);
    }
  }
  console.log("");
  for (const [name, pass] of gates) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  const perSession = Math.round((75 * 2 * 3600) / INTERVAL_S);
  console.log(`\nThis run used ~${total} requests. A 75-player x 2h session at ${INTERVAL_S}s polls is ~${perSession} requests (the free plan allows 100,000 a day; the app itself polls every 7.5s, slower when nothing is playing).`);
  console.log('Remember to delete the "Loadtest Bot" player in Admin.');
  process.exit(gates.every(([, p]) => p) ? 0 : 1);
}

await runSmoke();
if (!cookie) { console.error("No session; aborting before load."); report(); }
const until = Date.now() + MINUTES * 60_000;
await Promise.all(Array.from({ length: PLAYERS }, () => player(until)));
if (args.burst) await burst();
report();
