import { describe, it, expect } from "vitest";
import { isPiCommand, PI_COMMANDS, isMacAddress, normaliseMac } from "../src/piControl";

/**
 * Choosing the box's output speaker from the Admin screen.
 *
 * The security stance here is the same one pi_commands was built with, and the
 * reason this feature does NOT add a parameterised command: scanning is an
 * action with no parameters, so it is just another allowlisted name, while the
 * chosen MAC is state and travels on the beacon response. That MAC becomes an
 * argv element on the Pi, so it is validated here and again there.
 */
describe("the command allowlist", () => {
  it("accepts the scan command", () => {
    expect(isPiCommand("scan-speakers")).toBe(true);
  });

  it("still refuses anything not on the list", () => {
    expect(isPiCommand("scan-speakers; rm -rf /")).toBe(false);
    expect(isPiCommand("set-relay-speaker AA:BB:CC:DD:EE:FF")).toBe(false);
  });

  it("has no command that takes an argument", () => {
    // The property this whole design exists to preserve. A name with a space
    // in it is a name carrying a parameter.
    for (const c of PI_COMMANDS) expect(c).not.toMatch(/\s/);
  });
});

describe("isMacAddress", () => {
  it("accepts a well-formed MAC in either case", () => {
    expect(isMacAddress("78:66:F3:1C:9D:B6")).toBe(true);
    expect(isMacAddress("78:66:f3:1c:9d:b6")).toBe(true);
  });

  it("refuses a shell injection attempt", () => {
    expect(isMacAddress("$(reboot)")).toBe(false);
    expect(isMacAddress("78:66:F3:1C:9D:B6; reboot")).toBe(false);
  });

  it("refuses the wrong separator, length or characters", () => {
    expect(isMacAddress("78-66-F3-1C-9D-B6")).toBe(false);
    expect(isMacAddress("78:66:F3:1C:9D")).toBe(false);
    expect(isMacAddress("78:66:F3:1C:9D:B6:AA")).toBe(false);
    expect(isMacAddress("ZZ:66:F3:1C:9D:B6")).toBe(false);
  });

  it("refuses an empty string and a non-string", () => {
    // Empty is meaningful elsewhere - it is the explicit "use wired output" -
    // but it is not a MAC, and the two are decided separately on purpose.
    expect(isMacAddress("")).toBe(false);
    expect(isMacAddress(null)).toBe(false);
    expect(isMacAddress({ mac: "78:66:F3:1C:9D:B6" })).toBe(false);
  });

  it("does not accept a MAC with leading or trailing whitespace", () => {
    // Storing an untrimmed value would send the Pi something its own validator
    // rejects, producing a selection that silently never applies.
    expect(isMacAddress(" 78:66:F3:1C:9D:B6")).toBe(false);
  });
});

describe("normaliseMac", () => {
  it("upper-cases, so the same speaker is one row not two", () => {
    expect(normaliseMac("78:66:f3:1c:9d:b6")).toBe("78:66:F3:1C:9D:B6");
  });

  it("returns null for anything that is not a MAC", () => {
    expect(normaliseMac("$(reboot)")).toBeNull();
    expect(normaliseMac(undefined)).toBeNull();
  });
});

import { parseScan } from "../src/speakers";

/**
 * What the Pi reports having seen. The Pi already drops junk, so this is the
 * second gate rather than the first — it exists because a device NAME is chosen
 * by a stranger's phone, arrives verbatim, is stored, and is rendered.
 */
describe("parseScan", () => {
  const good = { mac: "78:66:f3:1c:9d:b6", name: "JBL Charge 6", cod: 2360324, rssi: -54 };

  it("keeps a well-formed device and upper-cases its MAC", () => {
    expect(parseScan([good])).toEqual([
      { mac: "78:66:F3:1C:9D:B6", name: "JBL Charge 6", cod: 2360324, rssi: -54 },
    ]);
  });

  it("drops a device whose MAC does not validate", () => {
    expect(parseScan([{ mac: "$(reboot)", name: "Evil" }, good])).toHaveLength(1);
  });

  it("treats a missing or blank name as nameless rather than empty", () => {
    // The UI shows the MAC for these. An empty string would render a blank row,
    // which reads as a bug rather than as a device with no name.
    expect(parseScan([{ mac: good.mac }])[0].name).toBeNull();
    expect(parseScan([{ mac: good.mac, name: "   " }])[0].name).toBeNull();
  });

  it("keeps a device that reports no class or signal", () => {
    // A speaker that reports no class is still a speaker. Dropping it would
    // hide the exact device somebody is holding.
    const [d] = parseScan([{ mac: good.mac, name: "Speaker" }]);
    expect(d.cod).toBeNull();
    expect(d.rssi).toBeNull();
  });

  it("ignores non-numeric class and signal instead of storing them", () => {
    const [d] = parseScan([{ ...good, cod: "0x240414", rssi: "loud" }]);
    expect(d.cod).toBeNull();
    expect(d.rssi).toBeNull();
  });

  it("bounds the name length", () => {
    const [d] = parseScan([{ ...good, name: "x".repeat(500) }]);
    expect(d.name!.length).toBe(64);
  });

  it("de-duplicates, keeping the first sighting", () => {
    const out = parseScan([good, { ...good, name: "Second" }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("JBL Charge 6");
  });

  it("caps how many devices one beacon can write", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      mac: `AA:BB:CC:DD:${String(Math.floor(i / 256)).padStart(2, "0")}:${i
        .toString(16)
        .padStart(2, "0")
        .slice(-2)}`,
      name: "D",
    }));
    expect(parseScan(many).length).toBeLessThanOrEqual(120);
  });

  it("survives a payload that is not an array at all", () => {
    expect(parseScan(undefined)).toEqual([]);
    expect(parseScan("devices")).toEqual([]);
    expect(parseScan([null, 7, "x"])).toEqual([]);
  });
});

/**
 * forget-selected-phone.
 *
 * Bluetooth has no unpair message, so a one-sided forget leaves the box
 * holding a bond the phone no longer has, and BlueZ refuses the re-pair.
 * The action and the target travel separately for the same reason scanning and
 * selecting do — the allowlist takes no parameters.
 */
describe("forget-selected-phone", () => {
  it("is on the allowlist", () => {
    expect(isPiCommand("forget-selected-phone")).toBe(true);
  });

  it("takes no argument, however tempting", () => {
    expect(isPiCommand("forget-selected-phone 5C:AD:BA:F0:B2:61")).toBe(false);
    expect(isPiCommand("forget-selected-phone --all")).toBe(false);
  });

  it("leaves the no-parameter property intact across the whole list", () => {
    // The property this design exists to protect. A name with whitespace is a
    // name carrying an argument.
    for (const c of PI_COMMANDS) expect(c).not.toMatch(/\s/);
  });

  it("validates the target the same way the relay speaker is validated", () => {
    // Both end up as a bluetoothctl argv element on the Pi, so both go
    // through normaliseMac here and are checked again there.
    expect(normaliseMac("5c:ad:ba:f0:b2:61")).toBe("5C:AD:BA:F0:B2:61");
    expect(normaliseMac("$(reboot)")).toBeNull();
    expect(normaliseMac("5C:AD:BA:F0:B2:61; rm -rf /")).toBeNull();
    expect(normaliseMac("5C:AD:BA:F0:B2")).toBeNull();
  });
});
