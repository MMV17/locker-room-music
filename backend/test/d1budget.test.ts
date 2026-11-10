import { describe, it, expect } from "vitest";
import { schemaDb, sqliteAvailable } from "./helpers/sqlite";
import {
  activeSessionUserId,
  sessionIdleExpired,
  touchCutoff,
  TOUCH_SESSION_SQL,
  SESSION_IDLE_MAX_MS,
} from "../src/session";
import {
  HEARTBEAT_UPSERT_SQL,
  HEARTBEAT_TOUCH_SQL,
  KEEPALIVE_SQL,
  heartbeatParams,
  heartbeatTouchParams,
  keepaliveParams,
} from "../src/beacon";
import type { HeartbeatWrite } from "../src/beacon";
import { ADMIN_USERS_SQL } from "../src/admin";
import { UNCLAIMED_DEVICES_SQL } from "../src/devices";
import { HISTORY_SQL, boardCacheKey, boardWindow } from "../src/leaderboards";
import { PLAY_PATCH_SQL } from "../src/piRoutes";
import {
  nowCandidate,
  liveOpenPlay,
  lastPossibleClose,
  isVoteWindowOpen,
  KEEPALIVE_STALE_MS,
  VOTE_GRACE_MS,
} from "../src/voteWindow";
import {
  orphanClose,
  isHourlyTick,
  pruneCutoffs,
  ORPHAN_CLOSE_SQL,
  PRUNE_AUTH_SQL,
  PRUNE_TOKENS_SQL,
  ORPHAN_AFTER_MS,
} from "../src/maintenance";
import { healCursorAfter, nextHealOffset, HEAL_BATCH } from "../src/artworkHeal";

/**
 * The D1 free-plan budget fixes. Each statement here was measured exceeding
 * the plan mid-practice; the tests pin the property that fixed it - mostly
 * "an unchanged request writes zero rows" - against real SQLite.
 */

const T0 = Date.parse("2026-11-10T16:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("session touch (1a)", () => {
  it("refuses a session idle past 120 days, falling back to created_at", () => {
    const now = T0;
    const old = iso(now - SESSION_IDLE_MAX_MS - 1000);
    const recent = iso(now - 86_400_000);
    expect(activeSessionUserId({ user_id: "u", active: 1, last_seen_at: old }, now)).toBeNull();
    expect(activeSessionUserId({ user_id: "u", active: 1, last_seen_at: null, created_at: old }, now)).toBeNull();
    expect(activeSessionUserId({ user_id: "u", active: 1, last_seen_at: recent, created_at: old }, now)).toBe("u");
    // Unknown stamps are not evidence of idleness.
    expect(sessionIdleExpired({ user_id: "u", active: 1 }, now)).toBe(false);
    expect(sessionIdleExpired({ user_id: "u", active: 1, last_seen_at: "junk" }, now)).toBe(false);
  });

  it.skipIf(!sqliteAvailable)("writes last_seen_at at most once an hour", () => {
    const db = schemaDb();
    db.run("INSERT INTO users (id, first_name, last_name, identity_key, created_at) VALUES ('u','a','b','k','x')");
    db.run("INSERT INTO device_tokens (token_hash, user_id, created_at) VALUES ('t','u',?)", iso(T0));
    const touch = (now: number) => db.run(TOUCH_SESSION_SQL, iso(now), "t", touchCutoff(now));
    expect(touch(T0)).toBe(1); // never touched
    expect(touch(T0 + 7_500)).toBe(0); // the next poll: no write
    expect(touch(T0 + 59 * 60_000)).toBe(0);
    expect(touch(T0 + 61 * 60_000)).toBe(1);
  });
});

describe.skipIf(!sqliteAvailable)("beacon heartbeat upsert (1b)", () => {
  const aux = { holderHash: "h1", holderAlias: "Phone", waitingJson: "[]", freeInMs: null };
  const output = { kind: "usb", card: "1", relayConnected: null, relayError: null };
  const beacon = (db: ReturnType<typeof schemaDb>, w: Partial<HeartbeatWrite> & { now: string }) =>
    db.run(HEARTBEAT_UPSERT_SQL, ...heartbeatParams({ speakerName: "AuxGoat", ...w }));

  it("writes the first beacon, then nothing for an unchanged one", () => {
    const db = schemaDb();
    expect(beacon(db, { now: iso(T0), aux, output })).toBe(1);
    expect(beacon(db, { now: iso(T0 + 10_000), aux, output })).toBe(0);
    expect(beacon(db, { now: iso(T0 + 50_000), aux, output })).toBe(0);
    // Stored stamp still the first one.
    expect(db.get("SELECT last_seen_at FROM heartbeats").last_seen_at).toBe(iso(T0));
  });

  it("refreshes last_seen_at once it is older than 60s", () => {
    const db = schemaDb();
    beacon(db, { now: iso(T0), aux, output });
    expect(beacon(db, { now: iso(T0 + 61_000), aux, output })).toBe(1);
    expect(db.get("SELECT last_seen_at FROM heartbeats").last_seen_at).toBe(iso(T0 + 61_000));
  });

  it("writes when any rendered value changes, with a fresh stamp", () => {
    const db = schemaDb();
    beacon(db, { now: iso(T0), aux, output });
    expect(beacon(db, { now: iso(T0 + 5_000), aux: { ...aux, holderHash: null }, output })).toBe(1);
    expect(db.get("SELECT last_seen_at, aux_holder_hash FROM heartbeats")).toEqual({
      last_seen_at: iso(T0 + 5_000),
      aux_holder_hash: null,
    });
    expect(beacon(db, { now: iso(T0 + 6_000), aux: { ...aux, holderHash: null }, output: { ...output, kind: "relay" } })).toBe(1);
    expect(beacon(db, { now: iso(T0 + 7_000), aux: { ...aux, holderHash: null, waitingJson: '[{"hash":"x"}]' }, output: { ...output, kind: "relay" } })).toBe(1);
  });

  it("always writes while the aux countdown runs, so freshCountdown ages it from the right stamp", () => {
    const db = schemaDb();
    beacon(db, { now: iso(T0), aux: { ...aux, freeInMs: 20_000 } });
    // Even a repeated positive reading moves the stamp with it.
    expect(beacon(db, { now: iso(T0 + 1_000), aux: { ...aux, freeInMs: 20_000 } })).toBe(1);
    // 0 (free) and null (song open) do not age, so they do not force writes.
    beacon(db, { now: iso(T0 + 2_000), aux: { ...aux, freeInMs: 0 } });
    expect(beacon(db, { now: iso(T0 + 3_000), aux: { ...aux, freeInMs: 0 } })).toBe(0);
  });

  it("keeps the stored aux and output when an older Pi omits them", () => {
    const db = schemaDb();
    beacon(db, { now: iso(T0), aux, output });
    expect(beacon(db, { now: iso(T0 + 61_000) })).toBe(1); // refresh only
    expect(db.get("SELECT aux_holder_hash, output_kind FROM heartbeats")).toEqual({
      aux_holder_hash: "h1",
      output_kind: "usb",
    });
    expect(beacon(db, { now: iso(T0 + 62_000) })).toBe(0);
  });

  it("throttles the legacy /api/heartbeat the same way", () => {
    const db = schemaDb();
    expect(db.run(HEARTBEAT_TOUCH_SQL, ...heartbeatTouchParams("AuxGoat", iso(T0)))).toBe(1);
    expect(db.run(HEARTBEAT_TOUCH_SQL, ...heartbeatTouchParams("AuxGoat", iso(T0 + 30_000)))).toBe(0);
    expect(db.run(HEARTBEAT_TOUCH_SQL, ...heartbeatTouchParams("AuxGoat", iso(T0 + 61_000)))).toBe(1);
  });
});

describe.skipIf(!sqliteAvailable)("beacon keepalive (1b)", () => {
  const setup = () => {
    const db = schemaDb();
    db.run("INSERT INTO tracks (id, track_key, title) VALUES ('t','k','T')");
    db.run("INSERT INTO plays (id, track_id, started_at, duration_ms) VALUES ('p','t',?,180000)", iso(T0));
    const ka = (now: number, status: string, played: number | null) =>
      db.run(KEEPALIVE_SQL, ...keepaliveParams("p", status, played, iso(now)));
    return { db, ka };
  };

  it("writes the first keepalive, then skips steady playback", () => {
    const { ka } = setup();
    expect(ka(T0 + 10_000, "playing", 10_000)).toBe(1);
    expect(ka(T0 + 20_000, "playing", 20_000)).toBe(0);
    expect(ka(T0 + 30_000, "playing", 30_500)).toBe(0); // jitter under 3s
  });

  it("writes on a status flip, a seek, or a 30s-old keepalive", () => {
    const { db, ka } = setup();
    ka(T0 + 10_000, "playing", 10_000);
    expect(ka(T0 + 15_000, "paused", 15_000)).toBe(1); // flip
    expect(ka(T0 + 25_000, "paused", 15_000)).toBe(0); // paused, not moving
    expect(ka(T0 + 30_000, "paused", 60_000)).toBe(1); // seek while paused
    expect(ka(T0 + 35_000, "playing", 60_000)).toBe(1); // flip back
    expect(ka(T0 + 40_000, "playing", 90_000)).toBe(1); // seek forward 25s
    expect(ka(T0 + 71_000, "playing", 121_000)).toBe(1); // keepalive > 30s old
    expect(db.get("SELECT keepalive_at, played_ms FROM plays").played_ms).toBe(121_000);
  });

  it("never touches a closed play", () => {
    const { db, ka } = setup();
    db.run("UPDATE plays SET ended_at = ?", iso(T0 + 1000));
    expect(ka(T0 + 10_000, "playing", 10_000)).toBe(0);
  });
});

describe.skipIf(!sqliteAvailable)("rewritten read queries return what the old ones did (1c-1d)", () => {
  const seed = () => {
    const db = schemaDb();
    for (let u = 0; u < 6; u++) {
      db.run("INSERT INTO users (id, first_name, last_name, identity_key, created_at) VALUES (?,?,?,?, 'x')", `u${u}`, `F${u}`, `L${u}`, `k${u}`);
    }
    for (let d = 0; d < 5; d++) {
      db.run("INSERT INTO devices (mac_hash, mac_hint, first_seen, user_id) VALUES (?, 'aa:bb', 'x', ?)", `d${d}`, d < 2 ? `u${d}` : null);
    }
    db.run("INSERT INTO tracks (id, track_key, title) VALUES ('t','k','T')");
    for (let p = 0; p < 80; p++) {
      db.run(
        "INSERT INTO plays (id, track_id, device_hash, user_id, started_at, ended_at, duration_ms, voided) VALUES (?, 't', ?, ?, ?, ?, 1000, ?)",
        `p${p}`, p % 7 === 0 ? null : `d${p % 5}`, p % 5 < 2 ? `u${p % 5}` : null,
        iso(T0 - (100 - p) * 60_000), iso(T0 - (100 - p) * 60_000 + 1000), p % 9 === 0 ? 1 : 0,
      );
      for (let v = 2; v < 6; v++) {
        if ((p + v) % 3) db.run("INSERT INTO votes (id, play_id, user_id, value, created_at, updated_at) VALUES (?,?,?,?, 'x','x')", `v${p}-${v}`, `p${p}`, `u${v}`, (p + v) % 2 ? 1 : -1);
      }
    }
    return db;
  };

  it("admin users", () => {
    const db = seed();
    const old = db.all(`SELECT u.*, TRIM(u.first_name || ' ' || u.last_name) AS name,
            (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id) AS plays,
            (SELECT COUNT(*) FROM votes v WHERE v.user_id = u.id) AS votes
       FROM users u ORDER BY u.last_name, u.first_name`);
    expect(db.all(ADMIN_USERS_SQL)).toEqual(old);
  });

  it("unclaimed devices", () => {
    const db = seed();
    const old = db.all(`SELECT d.mac_hash, d.mac_hint, d.alias, d.first_seen, COUNT(p.id) AS plays
     FROM devices d LEFT JOIN plays p ON p.device_hash = d.mac_hash
     WHERE d.user_id IS NULL GROUP BY d.mac_hash ORDER BY plays DESC`);
    const sort = (r: any[]) => [...r].sort((a, b) => a.mac_hash.localeCompare(b.mac_hash));
    expect(sort(db.all(UNCLAIMED_DEVICES_SQL))).toEqual(sort(old));
  });

  it("history: the 50 newest non-voided plays with their tallies", () => {
    const db = seed();
    const old = db.all(`SELECT
       p.id, p.started_at, p.ended_at, p.counted, p.duration_ms, p.keepalive_at, p.voided,
       t.title, t.artist, t.artwork_url, t.track_key,
       TRIM(u.first_name || ' ' || u.last_name) AS dj_name, u.jersey_number,
       SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END)  AS up,
       SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS down
     FROM plays p JOIN tracks t ON t.id = p.track_id
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN votes v ON v.play_id = p.id AND v.voided = 0
     WHERE p.voided = 0 GROUP BY p.id ORDER BY p.started_at DESC LIMIT 50`);
    const now = db.all(HISTORY_SQL);
    expect(now).toHaveLength(50);
    expect(now).toEqual(old);
  });
});

describe("leaderboard cache key (1d)", () => {
  it("is path + normalised window and nothing else", () => {
    expect(boardCacheKey("https://hc.example/api/leaderboard/tracks?window=week&x=1", "week")).toBe(
      "https://hc.example/api/leaderboard/tracks?window=week",
    );
    expect(boardCacheKey("https://hc.example/api/leaderboard/djs", undefined)).toBe(
      "https://hc.example/api/leaderboard/djs?window=season",
    );
    expect(boardWindow("junk")).toBe("season");
    expect(boardWindow("month")).toBe("month");
  });
});

describe("/api/now candidate (1e)", () => {
  const play = (id: string, startedOffset: number, voided = 0) => ({ id, started_at: iso(T0 + startedOffset), voided });

  it("skips voided rows among the newest", () => {
    expect(nowCandidate([play("a", 0, 1), play("b", -1000)], T0)?.id).toBe("b");
    expect(nowCandidate([play("a", 0, 1), play("b", -1000, 1)], T0)).toBeNull();
  });

  it("ignores a play stamped more than 60s in the future", () => {
    expect(nowCandidate([play("future", 61_000), play("real", -5_000)], T0)?.id).toBe("real");
    // Inside the tolerance is just clock jitter, and still wins.
    expect(nowCandidate([play("soon", 30_000), play("real", -5_000)], T0)?.id).toBe("soon");
  });
});

describe("orphaned plays (1f)", () => {
  const base = {
    id: "p",
    started_at: iso(T0 - 2 * 3600_000),
    ended_at: null,
    duration_ms: 180_000,
    played_ms: 60_000,
    keepalive_at: null as string | null,
    voided: 0,
  };

  it("closes a play whose window shut 15+ minutes ago, at start + played", () => {
    expect(orphanClose(base, T0)).toEqual({
      ended_at: iso(Date.parse(base.started_at) + 60_000),
      counted: 1,
    });
    expect(isVoteWindowOpen(base, T0)).toBe(false);
  });

  it("closes at keepalive_at when the Pi vouched for it, and counts only 30s+", () => {
    const ka = iso(T0 - 30 * 60_000);
    expect(orphanClose({ ...base, keepalive_at: ka, played_ms: 29_000 }, T0)).toEqual({ ended_at: ka, counted: 0 });
    expect(orphanClose({ ...base, played_ms: null, duration_ms: null }, T0)?.counted).toBe(0);
  });

  it("leaves a play alone until its window has been shut for 15 minutes", () => {
    // Paused for two hours, Pi died 5 minutes ago: voteWindowClosesAt(now) would
    // call this long closed; lastPossibleClose does not.
    const ka = iso(T0 - 5 * 60_000);
    const p = { ...base, keepalive_at: ka };
    expect(lastPossibleClose(p)).toBe(Date.parse(ka) + KEEPALIVE_STALE_MS + VOTE_GRACE_MS);
    expect(orphanClose(p, T0)).toBeNull();
    expect(orphanClose(p, Date.parse(ka) + KEEPALIVE_STALE_MS + VOTE_GRACE_MS + ORPHAN_AFTER_MS)).not.toBeNull();
    expect(orphanClose({ ...base, ended_at: iso(T0 - 3600_000) }, T0)).toBeNull();
    expect(orphanClose({ ...base, voided: 1 }, T0)).toBeNull();
  });

  it.skipIf(!sqliteAvailable)("never overwrites a real close, and a late PATCH overwrites the sweep", () => {
    const db = schemaDb();
    db.run("INSERT INTO tracks (id, track_key, title) VALUES ('t','k','T')");
    db.run("INSERT INTO plays (id, track_id, started_at) VALUES ('p','t',?)", base.started_at);
    expect(db.run(ORPHAN_CLOSE_SQL, iso(T0 - 1000), 0, "p")).toBe(1);
    expect(db.run(ORPHAN_CLOSE_SQL, iso(T0), 1, "p")).toBe(0); // already closed
    db.run(PLAY_PATCH_SQL, iso(T0 - 500), 200_000, 1, "p");
    expect(db.get("SELECT ended_at, played_ms, counted FROM plays")).toEqual({
      ended_at: iso(T0 - 500),
      played_ms: 200_000,
      counted: 1,
    });
  });

  it("the 'song playing' check ignores an orphan and finds the live play", () => {
    const orphan = { ...base, device_hash: "x" };
    const live = { ...base, id: "live", started_at: iso(T0 - 60_000), keepalive_at: iso(T0 - 10_000), device_hash: "y" };
    expect(liveOpenPlay([orphan], T0)).toBeNull();
    expect(liveOpenPlay([live, orphan], T0)?.id).toBe("live");
    expect(liveOpenPlay([{ ...live, ended_at: iso(T0 - 5_000) }, orphan], T0)).toBeNull();
  });

  it("the sweep runs on the :00 tick of the 5-minute cron only", () => {
    expect(isHourlyTick(Date.parse("2026-11-10T16:00:00Z"))).toBe(true);
    expect(isHourlyTick(Date.parse("2026-11-10T16:05:00Z"))).toBe(false);
    expect(isHourlyTick(Date.parse("2026-11-10T16:55:00Z"))).toBe(false);
  });
});

describe("artwork heal cursor (1g)", () => {
  it("advances per track, matching the end-of-batch offset", () => {
    expect(healCursorAfter(10, 1, 0)).toBe(11);
    expect(healCursorAfter(10, 3, 1)).toBe(12);
    expect(healCursorAfter(10, HEAL_BATCH, 2)).toBe(nextHealOffset(10, HEAL_BATCH, 2));
  });
});

describe.skipIf(!sqliteAvailable)("daily pruning (1h)", () => {
  it("drops expired throttle windows and sessions unseen for 180 days", () => {
    const db = schemaDb();
    const c = pruneCutoffs(T0);
    db.run("INSERT INTO auth_attempts VALUES ('old', ?, 3)", T0 - 2 * 3600_000);
    db.run("INSERT INTO auth_attempts VALUES ('live', ?, 3)", T0 - 60_000);
    db.run("INSERT INTO users (id, first_name, last_name, identity_key, created_at) VALUES ('u','a','b','k','x')");
    db.run("INSERT INTO device_tokens VALUES ('stale','u',?,?)", iso(T0 - 400 * 86_400_000), iso(T0 - 181 * 86_400_000));
    db.run("INSERT INTO device_tokens VALUES ('never','u',?,NULL)", iso(T0 - 181 * 86_400_000));
    db.run("INSERT INTO device_tokens VALUES ('fresh','u',?,?)", iso(T0 - 400 * 86_400_000), iso(T0 - 86_400_000));
    expect(db.run(PRUNE_AUTH_SQL, c.authWindowStart)).toBe(1);
    expect(db.run(PRUNE_TOKENS_SQL, c.tokenSeenBefore)).toBe(2);
    expect(db.all("SELECT token_hash FROM device_tokens")).toEqual([{ token_hash: "fresh" }]);
  });
});
