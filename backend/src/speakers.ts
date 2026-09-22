/**
 * The relay speaker: what the box plays OUT through.
 *
 * The design decision worth knowing before changing anything here is that this
 * feature adds no parameterised command. `pi_commands` maps a fixed name to a
 * fixed argv on both ends, and its schema comment explains what that is
 * protecting. So the two halves of "pick a speaker" travel differently:
 *
 *   scanning    an action with no parameters -> the `scan-speakers` command
 *   selecting   a fact about the box         -> a `settings` row, sent down on
 *                                              the beacon response
 *
 * See docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md.
 */
import {
  FORGET_DEVICE_MAC_KEY,
  normaliseMac,
  RELAY_SPEAKER_MAC_KEY,
  RELAY_SPEAKER_NAME_KEY,
} from "./piControl";
import type { Env } from "./types";

/** One device as the Pi's scan reported it. */
export type ScannedDevice = {
  mac: string;
  name: string | null;
  cod: number | null;
  rssi: number | null;
};

/**
 * A scan can, in a crowded room, be large. This is a bound on what one beacon
 * may write, not a claim about how many speakers exist.
 */
const MAX_DEVICES = 120;
const MAX_NAME = 64;

/**
 * Take the Pi at its word about what it saw, but not about the shape of it.
 *
 * The Pi already drops junk, so this is the second gate rather than the first.
 * It exists because a device NAME is chosen by a stranger's phone: it arrives
 * here verbatim, is stored, and is rendered in the Admin screen. Anything whose
 * MAC does not validate is dropped rather than stored, and names are bounded.
 */
export function parseScan(raw: unknown): ScannedDevice[] {
  if (!Array.isArray(raw)) return [];

  const out: ScannedDevice[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const mac = normaliseMac((entry as any).mac);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);

    const rawName = (entry as any).name;
    const name =
      typeof rawName === "string" && rawName.trim() !== ""
        ? rawName.slice(0, MAX_NAME)
        : null;

    out.push({
      mac,
      name,
      cod: intOrNull((entry as any).cod),
      rssi: intOrNull((entry as any).rssi),
    });
    if (out.length >= MAX_DEVICES) break;
  }
  return out;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/**
 * Replace the device list wholesale.
 *
 * A device list is a snapshot, not a log. Keeping the previous scan would keep
 * offering speakers that have since left the building, and there is no version
 * of this screen where a stale device is more useful than an absent one.
 *
 * An EMPTY scan still clears the table: "I looked and found nothing" is a real
 * answer, and leaving last week's devices on screen would misrepresent it.
 */
export async function replaceDevices(
  env: Env,
  devices: ScannedDevice[],
  scannedAt: string,
): Promise<void> {
  const statements = [env.DB.prepare("DELETE FROM bt_devices")];
  for (const d of devices) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO bt_devices (mac, name, cod, rssi, scanned_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(d.mac, d.name, d.cod, d.rssi, scannedAt),
    );
  }
  // Batched so a scan is never half-applied: a delete that landed without its
  // inserts would show an empty picker for no reason anyone could explain.
  await env.DB.batch(statements);
}

export async function listDevices(env: Env): Promise<ScannedDevice[]> {
  const { results } = await env.DB.prepare(
    `SELECT mac, name, cod, rssi FROM bt_devices`,
  ).all<ScannedDevice>();
  return results ?? [];
}

/**
 * What the Pi should be relaying to, in the three-state convention the Pi
 * expects:
 *
 *   null  no opinion  -> the Pi falls back to its own config.toml
 *   ""    explicitly off -> wired output, overriding config.toml
 *   MAC   relay to this
 *
 * Returning `undefined` for "no row" is not an option: it disappears from JSON,
 * and the Pi would not be able to tell it from a malformed response.
 */
export async function getSelection(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(RELAY_SPEAKER_MAC_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  // Anything stored that is not a MAC and not the empty string is treated as
  // "off" rather than passed on. The write path validates, so this only fires
  // on a hand-edited row - and sending junk down would just be refused by the
  // Pi anyway, silently.
  return row.value === "" ? "" : (normaliseMac(row.value) ?? "");
}

export async function getSelectionName(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(RELAY_SPEAKER_NAME_KEY)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Store the operator's choice. `null` means "use wired output", which is stored
 * as the empty string rather than by deleting the row — the distinction is the
 * whole point. A deleted row means "never configured", and the Pi would then
 * fall back to config.toml and turn the speaker straight back on.
 */
export async function setSelection(
  env: Env,
  mac: string | null,
  name: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(RELAY_SPEAKER_MAC_KEY, mac ?? "", now),
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(RELAY_SPEAKER_NAME_KEY, name ?? "", now),
  ]);
}

/**
 * Which device the operator asked to forget, for the next
 * `forget-selected-phone` to act on.
 *
 * Deliberately NOT the three-state convention getSelection() uses. "" means
 * something real for a relay speaker — explicitly wired output — and means
 * nothing here: there is no such thing as explicitly forgetting nothing. So
 * this is a MAC or it is null, and null is what the Pi reads as "nothing
 * pending".
 */
export async function getForgetTarget(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(FORGET_DEVICE_MAC_KEY)
    .first<{ value: string }>();
  if (!row || row.value === "") return null;
  // Anything stored that is not a MAC is dropped rather than passed on. The
  // write path validates, so this only fires on a hand-edited row — and the
  // Pi would refuse it anyway, which is the point of validating twice.
  return normaliseMac(row.value);
}

/**
 * Store which device to forget. `null` clears the request.
 *
 * The caller queues the command separately: this is only the target. That
 * split is what keeps the allowlist free of parameters, and it is why a stale
 * row here is harmless — nothing acts on it until somebody presses the button.
 */
export async function setForgetTarget(env: Env, mac: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(FORGET_DEVICE_MAC_KEY, mac ?? "", new Date().toISOString())
    .run();
}
