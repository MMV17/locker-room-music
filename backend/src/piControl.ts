/**
 * Remote control for the Pi, over the only route the locker room network
 * leaves open.
 *
 * Measured on site: HCGuest allows outbound 443 and blocks 7844 (both TCP and
 * UDP, while 443 to the same Cloudflare edge IPs is open), which rules out
 * Cloudflare Tunnel entirely. Tailscale is blocked by SNI. Guest clients
 * cannot reach each other on TCP/22. Nothing can connect *to* the Pi.
 *
 * So the direction is inverted: the Pi POSTs to us, and the response carries
 * any pending command. That request doubles as the liveness heartbeat, which
 * is why it replaced the old queued one — a heartbeat means "alive right now",
 * and replaying a stale one from a durable outbox asserts nothing. The outbox
 * is for plays and votes, the things spec 5.3's never-drop rule is about.
 *
 * The command set is a fixed allowlist, not a shell. A `run arbitrary string`
 * command would turn a locker room speaker into remote code execution, so it
 * does not exist — and the Pi re-checks this list rather than trusting us.
 */
export const PI_COMMANDS = [
  "restart-listener",
  "reboot",
  "report-status",
  // Discovers nearby Bluetooth devices for the speaker picker. It takes NO
  // parameters, which is the only reason it can be a command at all: choosing
  // a speaker is state, and travels as a `settings` row on the beacon response
  // instead. See docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md.
  "scan-speakers",
  // Read-only diagnostic dump: is-active AND is-enabled for every lockerroom
  // unit, `hciconfig hci0`, audio-check.sh, the network, and recent journal
  // lines. Built after 2026-09-20, when the box stopped accepting pairings and
  // `report-status` could not see any of the units that were actually broken.
  //
  // Its body does NOT come back in pi_commands.result, which is truncated to
  // 2000 characters. It rides its own beacon payload into `pi_reports`, the
  // way a scan rides into bt_devices. See migration 007.
  "report-full",
  // Pull the repo on the Pi and run the COMMITTED repair script at a fixed
  // path. Still no parameter: the thing you are varying is the commit you
  // pushed, not an argument on this list.
  //
  // It must never touch the listener package — the listener IS this control
  // channel, and a mechanism that can replace it can destroy remote access
  // while using it. The Pi enforces that, not us. See pi/scripts/run-repair.sh.
  "run-repair",
  // Forget ONE paired device. Bluetooth has no unpair message, so when
  // somebody forgets this box on their phone we keep a bond they no longer
  // have, and BlueZ refuses the re-pair — locking them out until the bond is
  // removed HERE. Before this, that needed a serial cable.
  //
  // WHICH device is NOT a parameter: it rides the beacon response as a
  // `settings` row and is validated on the Pi, the same split the speaker
  // picker makes between scanning and selecting.
  "forget-selected-phone",
] as const;
export type PiCommand = (typeof PI_COMMANDS)[number];

export function isPiCommand(value: unknown): value is PiCommand {
  return typeof value === "string" && (PI_COMMANDS as readonly string[]).includes(value);
}

/** How stale a beacon may be before the site calls the speaker offline. */
export const OFFLINE_AFTER_MS = 3 * 60_000;

/**
 * The same regex the Pi uses in `lockerroom/macaddr.py`, deliberately.
 *
 * A MAC accepted here is stored, handed to the Pi on its next beacon, and
 * passed to bluetoothctl as an argv element. Both ends validate it: this one so
 * junk never enters the database, and the Pi's so a compromised or misdeployed
 * server cannot be the only thing standing between a locker room speaker and a
 * subprocess. Neither is redundant.
 *
 * Whitespace is NOT trimmed. An untrimmed value stored here would be refused by
 * the Pi's validator, producing a selection that silently never applies - so
 * padding is rejected loudly at the point of entry instead.
 */
const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

export function isMacAddress(value: unknown): value is string {
  return typeof value === "string" && MAC.test(value);
}

/** Upper-cased, so one speaker is one row rather than one per browser. */
export function normaliseMac(value: unknown): string | null {
  return isMacAddress(value) ? value.toUpperCase() : null;
}

/** The settings keys the speaker picker owns. */
export const RELAY_SPEAKER_MAC_KEY = "relay_speaker_mac";
export const RELAY_SPEAKER_NAME_KEY = "relay_speaker_name";

/**
 * Which device `forget-selected-phone` will remove.
 *
 * A pending instruction rather than configuration, which is why the Pi keeps
 * it on /run and not /var/lib: a forget request that survived a reboot would
 * fire days later at a phone somebody had since re-paired.
 */
export const FORGET_DEVICE_MAC_KEY = "forget_device_mac";
