import { describe, it, expect } from "vitest";
import { schemaDb, sqliteAvailable } from "./helpers/sqlite";
import {
  ATTEMPT_SQL,
  REFUND_SQL,
  reservationVerdict,
  addressBucket,
  recordFailure,
  TEAM_CODE_POLICY,
  TEAM_CODE_GLOBAL_POLICY,
  ADMIN_POLICY,
} from "../src/throttle";
import { identityProblem, isIdentityClash } from "../src/roster";
import {
  playerDevices,
  resolveSpeakerId,
  scrubMacs,
  playerOutput,
  isAudioClass,
  speakerId,
} from "../src/speakers";
import type { ScannedDevice } from "../src/speakers";
import { cleanText, speakerNameFrom, parseTimestamp, intOrNull } from "../src/beacon";
import { DISPATCH_SQL } from "../src/piCommands";
import { parseReport } from "../src/piReports";

const MIN = 60_000;
const T0 = Date.parse("2026-11-10T12:00:00Z");

describe.skipIf(!sqliteAvailable)("atomic throttle (2b)", () => {
  const reserve = (db: ReturnType<typeof schemaDb>, bucket: string, now: number, policy = TEAM_CODE_POLICY) => {
    const row = db.get(ATTEMPT_SQL, bucket, now, policy.windowMs);
    return reservationVerdict({ window_start: row.window_start, count: row.count }, policy, now);
  };

  it("refuses the attempt after `limit` failures, in one statement each", () => {
    const db = schemaDb();
    for (let i = 0; i < TEAM_CODE_POLICY.limit; i++) expect(reserve(db, "code:1.2.3.4", T0 + i).blocked).toBe(false);
    const v = reserve(db, "code:1.2.3.4", T0 + 100);
    expect(v.blocked).toBe(true);
    expect(v.retryAfter).toBe(600);
  });

  it("matches recordFailure: the window never slides, and restarts once elapsed", () => {
    const db = schemaDb();
    let model = null as null | { window_start: number; count: number };
    for (const t of [T0, T0 + 3 * MIN, T0 + 9 * MIN, T0 + 10 * MIN, T0 + 12 * MIN]) {
      model = recordFailure(model, TEAM_CODE_POLICY, t);
      reserve(db, "b", t);
      expect(db.get("SELECT window_start, count FROM auth_attempts WHERE bucket = 'b'")).toEqual(model);
    }
  });

  it("a refund gives back exactly one slot in the same window", () => {
    const db = schemaDb();
    const g = TEAM_CODE_GLOBAL_POLICY;
    const first = reserve(db, "code:*", T0, g);
    reserve(db, "code:*", T0 + 1, g);
    expect(db.run(REFUND_SQL, "code:*", first.windowStart)).toBe(1);
    expect(db.get("SELECT count FROM auth_attempts").count).toBe(1);
    // A refund for a window that has since restarted does nothing.
    expect(db.run(REFUND_SQL, "code:*", first.windowStart - 1)).toBe(0);
  });

  it("the global bucket holds 300 failures an hour", () => {
    expect(TEAM_CODE_GLOBAL_POLICY).toEqual({ limit: 300, windowMs: 60 * MIN });
    expect(ADMIN_POLICY.limit).toBe(10);
  });
});

describe("IPv6 buckets (2b)", () => {
  it("folds IPv6 to its /64 and leaves IPv4 alone", () => {
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:0db8:0001:0002:0:0:0:1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("2001:DB8:1:2::ff")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressBucket("unknown")).toBe("unknown");
    // Two addresses in one /64 share a bucket; the next /64 does not.
    expect(addressBucket("2001:db8:1:2::1")).toBe(addressBucket("2001:db8:1:2:ffff::9"));
    expect(addressBucket("2001:db8:1:3::1")).not.toBe(addressBucket("2001:db8:1:2::1"));
  });
});

describe("identity validation (2h)", () => {
  it("bounds names at 40 and jerseys at 1-3 digits", () => {
    expect(identityProblem("Mack", "Vinton", "12")).toBeNull();
    expect(identityProblem("Mack", "Vinton", null)).toBeNull();
    expect(identityProblem("x".repeat(5000), "Vinton", null)).toBe("That name is too long");
    expect(identityProblem("Mack", "Vinton", "abcdefgh")).toBe("A jersey number is up to three digits");
    expect(identityProblem("Mack", "Vinton", "1234")).toBe("A jersey number is up to three digits");
    expect(identityProblem("", "Vinton", null)).toBe("First and last name are required");
  });

  it("recognises the identity_key UNIQUE failure D1 throws", () => {
    expect(isIdentityClash(new Error("D1_ERROR: UNIQUE constraint failed: users.identity_key: SQLITE_CONSTRAINT"))).toBe(true);
    expect(isIdentityClash(new Error("no such table"))).toBe(false);
  });
});

describe("player speaker list (2a)", () => {
  const SALT = "salt";
  const scan: ScannedDevice[] = [
    { mac: "AA:BB:CC:DD:EE:01", name: "JBL Flip", cod: 0x240414, rssi: -50 }, // audio
    { mac: "AA:BB:CC:DD:EE:02", name: "Mack's iPhone", cod: 0x5a020c, rssi: -40 }, // phone
    { mac: "AA:BB:CC:DD:EE:03", name: null, cod: null, rssi: null },
  ];
  const MAC_SHAPE = /([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/;

  it("lists audio-class devices only, with no MAC anywhere", async () => {
    const list = await playerDevices(scan, SALT);
    expect(list.map((d) => d.name)).toEqual(["JBL Flip"]);
    expect(MAC_SHAPE.test(JSON.stringify(list))).toBe(false);
    expect(list[0].id).toBe(await speakerId("aa:bb:cc:dd:ee:01", SALT));
    expect(isAudioClass(0x240414)).toBe(true);
    expect(isAudioClass(0x5a020c)).toBe(false);
  });

  it("resolves an id back to its device server-side, and never to a phone", async () => {
    const phoneId = await speakerId(scan[1].mac, SALT);
    const speaker = await resolveSpeakerId(scan, await speakerId(scan[0].mac, SALT), SALT);
    expect(speaker?.mac).toBe("AA:BB:CC:DD:EE:01");
    expect(await resolveSpeakerId(scan, phoneId, SALT)).toBeNull();
    expect(await resolveSpeakerId(scan, "AA:BB:CC:DD:EE:01", SALT)).toBeNull();
  });

  it("withholds the relay card and scrubs MACs out of errors", () => {
    expect(playerOutput("relay", "AA:BB:CC:DD:EE:01")).toEqual({ kind: "relay", card: null });
    expect(playerOutput("usb", "1")).toEqual({ kind: "usb", card: "1" });
    expect(playerOutput("usb", "aa-bb-cc-dd-ee-01")).toEqual({ kind: "usb", card: null });
    expect(playerOutput(null, "1")).toBeNull();
    expect(scrubMacs("could not connect to AA:BB:CC:DD:EE:01 (timeout)")).toBe("could not connect to the speaker (timeout)");
    expect(scrubMacs(null)).toBeNull();
  });
});

describe("Pi-supplied fields are bounded, never rejected (2g)", () => {
  it("cleans the speaker name", () => {
    expect(speakerNameFrom("AuxGoat")).toBe("AuxGoat");
    expect(speakerNameFrom(undefined)).toBe("AuxGoat");
    expect(speakerNameFrom(42)).toBe("AuxGoat");
    expect(speakerNameFrom("   ")).toBe("AuxGoat");
    expect(speakerNameFrom("x".repeat(500))).toHaveLength(64);
    expect(speakerNameFrom("Aux\u0000Goat\n\u001b[31m")).toBe("Aux Goat  [31m");
  });

  it("bounds free text and numbers", () => {
    expect(cleanText("  hi  ", 10)).toBe("hi");
    expect(cleanText("", 10)).toBeNull();
    expect(cleanText({}, 10)).toBeNull();
    expect(intOrNull(12.7)).toBe(12);
    expect(intOrNull("12")).toBeNull();
    expect(intOrNull(Infinity)).toBeNull();
  });

  it("accepts only timestamps that parse", () => {
    expect(parseTimestamp("2026-11-10T12:00:00Z")).toBe(T0);
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp(1731240000)).toBeNull();
    expect(parseReport({ kind: "report-full", body: "x", at: "garbage" })!.collected_at).not.toBe("garbage");
    expect(parseReport({ kind: "report-full", body: "x", at: "2026-11-10T12:00:00Z" })!.collected_at).toBe("2026-11-10T12:00:00Z");
  });
});

describe.skipIf(!sqliteAvailable)("atomic command dispatch (2i)", () => {
  it("hands each command out exactly once, oldest first", () => {
    const db = schemaDb();
    db.run("INSERT INTO pi_commands (id, command, created_at) VALUES ('a', 'reboot', '2026-11-10T00:00:01Z')");
    db.run("INSERT INTO pi_commands (id, command, created_at) VALUES ('b', 'report-full', '2026-11-10T00:00:02Z')");
    expect(db.all(DISPATCH_SQL, "t1")).toEqual([{ id: "a", command: "reboot" }]);
    expect(db.all(DISPATCH_SQL, "t2")).toEqual([{ id: "b", command: "report-full" }]);
    expect(db.all(DISPATCH_SQL, "t3")).toEqual([]);
  });
});
