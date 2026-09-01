/**
 * Who may point the AuxGoat at a different speaker.
 *
 * The problem this solves: speaker selection started life in the Admin screen,
 * next to reboot and restart-listener. Those are coach controls. Choosing the
 * output speaker is not — a DJ walks into a room with whatever speaker is
 * there, and gating that behind the coach password means either every DJ has
 * the admin code or every DJ has to find the coach first. Neither is the
 * product.
 *
 * THE PERMISSION ALREADY EXISTED IN THE DATA. A phone connected to the AuxGoat
 * over Bluetooth is standing within about ten metres of it. That is a proof of
 * presence nobody can fake from home, it needs no new code to hand out, and the
 * beacon already reports the whole connected set (the aux holder plus everyone
 * waiting). Phones are already tied to players by the Claim screen.
 *
 * So: you may change the speaker if one of your claimed phones is currently
 * connected to the box. And you may not change it out from under somebody
 * else's song, which is the same courtesy the aux rule already encodes.
 */
import { OFFLINE_AFTER_MS } from "./piControl";
import type { Env } from "./types";

export type Permission = {
  allowed: boolean;
  /** Shown to the player verbatim, so it must say what to DO, not what failed. */
  reason: string;
};

const OK: Permission = { allowed: true, reason: "" };

type Heartbeat = {
  last_seen_at: string;
  aux_holder_hash: string | null;
  aux_waiting: string | null;
};

/**
 * Every phone the box currently has a Bluetooth connection to: the routed one
 * and everyone queued behind it.
 *
 * A malformed waiting list degrades to "just the holder" rather than throwing.
 * Being wrongly told to connect your phone is a small, self-correcting
 * annoyance; a 500 on the speaker screen is not.
 */
export function connectedHashes(hb: Heartbeat): string[] {
  const hashes: string[] = [];
  if (hb.aux_holder_hash) hashes.push(hb.aux_holder_hash);
  try {
    const waiting: { hash?: string }[] = hb.aux_waiting ? JSON.parse(hb.aux_waiting) : [];
    for (const w of waiting) if (typeof w?.hash === "string") hashes.push(w.hash);
  } catch {
    /* see above */
  }
  return hashes;
}

/**
 * May this player change the speaker right now?
 *
 * Deliberately returns a REASON on every refusal. The failure this is most
 * likely to produce is a DJ tapping a speaker and nothing happening, and the
 * difference between "connect your phone first" and a dead button is the
 * difference between a working feature and a bug report.
 */
export async function mayChangeSpeaker(env: Env, userId: string): Promise<Permission> {
  const hb = await env.DB.prepare(
    `SELECT last_seen_at, aux_holder_hash, aux_waiting
       FROM heartbeats ORDER BY last_seen_at DESC LIMIT 1`,
  ).first<Heartbeat>();

  if (!hb || Date.now() - Date.parse(hb.last_seen_at) > OFFLINE_AFTER_MS) {
    return { allowed: false, reason: "The AuxGoat is offline right now." };
  }

  const hashes = connectedHashes(hb);
  if (hashes.length === 0) {
    return {
      allowed: false,
      reason: "Connect your phone to the AuxGoat over Bluetooth first.",
    };
  }

  // Is one of those connected phones this player's? Claimed devices only —
  // an unclaimed phone belongs to nobody, so it grants nobody anything.
  const placeholders = hashes.map(() => "?").join(",");
  const mine = await env.DB.prepare(
    `SELECT 1 FROM devices
      WHERE user_id = ? AND mac_hash IN (${placeholders}) LIMIT 1`,
  )
    .bind(userId, ...hashes)
    .first();

  if (!mine) {
    return {
      allowed: false,
      reason: "Connect your phone to the AuxGoat over Bluetooth first.",
    };
  }

  // Not out from under somebody else's song. An open play is a song the room
  // is listening to; moving the output mid-song is taking the speaker away
  // from whoever is DJing, which is exactly what the aux rule exists to stop.
  //
  // Your OWN song is fine: if you are the one playing, the speaker is yours to
  // point wherever you like.
  const openPlay = await env.DB.prepare(
    `SELECT device_hash FROM plays
      WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
  ).first<{ device_hash: string | null }>();

  if (openPlay?.device_hash) {
    const isMine = await env.DB.prepare(
      "SELECT 1 FROM devices WHERE user_id = ? AND mac_hash = ? LIMIT 1",
    )
      .bind(userId, openPlay.device_hash)
      .first();
    if (!isMine) {
      return {
        allowed: false,
        reason: "Someone's song is playing. Wait for it to finish.",
      };
    }
  }

  return OK;
}

/**
 * How long a scan stays visible to the team.
 *
 * The Admin screen shows every device found, because there hiding a speaker is
 * the worse failure. In the team UI the tradeoff flips: that list is every
 * nearby device NAME, and left standing it becomes a permanent record of who
 * was in the room, readable by all 75 players. Ten minutes is long enough to
 * pick a speaker and short enough not to be a roster.
 */
export const SCAN_VISIBLE_MS = 10 * 60_000;

export function isScanFresh(scannedAt: string | null | undefined, now = Date.now()): boolean {
  if (!scannedAt) return false;
  const t = Date.parse(scannedAt);
  return Number.isFinite(t) && now - t < SCAN_VISIBLE_MS;
}
