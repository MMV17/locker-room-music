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
export const PI_COMMANDS = ["restart-listener", "reboot", "report-status"] as const;
export type PiCommand = (typeof PI_COMMANDS)[number];

export function isPiCommand(value: unknown): value is PiCommand {
  return typeof value === "string" && (PI_COMMANDS as readonly string[]).includes(value);
}

/** How stale a beacon may be before the site calls the speaker offline. */
export const OFFLINE_AFTER_MS = 3 * 60_000;
