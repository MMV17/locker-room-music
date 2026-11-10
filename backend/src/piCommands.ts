/**
 * The Pi's command queue (`pi_commands`), shared by the Admin and player
 * routes that put work on it.
 */
import type { Env } from "./types";
import { nowIso, uuid } from "./util";

/**
 * A dispatched command that has not reported back within this long is treated
 * as finished for queueing purposes. `reboot` never reports - the Pi is gone
 * before it can - so without this the first reboot would block every command
 * that followed it.
 */
export const STALE_DISPATCH_MS = 5 * 60_000;

/** The ISO time before which a dispatched-but-silent command no longer counts. */
export function staleCutoff(now: number = Date.now()): string {
  return new Date(now - STALE_DISPATCH_MS).toISOString();
}

/**
 * Whether a command is already queued or running.
 *
 * One outstanding command at a time. Queueing three reboots because the first
 * appeared to do nothing would reboot the Pi three times, and three scans
 * would occupy the radio that is also carrying the music.
 *
 * "Outstanding" excludes commands dispatched long ago and never reported.
 * Without that escape hatch a Pi that died mid-command would block the queue
 * forever - and `reboot` does exactly that every single time.
 */
export async function hasOutstandingCommand(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM pi_commands
      WHERE completed_at IS NULL
        AND (dispatched_at IS NULL OR dispatched_at > ?)`,
  )
    .bind(staleCutoff())
    .first<{ id: string }>();
  return !!row;
}

/** Put one command on the queue. The caller has already checked the allowlist. */
export async function queueCommand(env: Env, name: string): Promise<string> {
  const id = uuid();
  await env.DB.prepare("INSERT INTO pi_commands (id, command, created_at) VALUES (?, ?, ?)")
    .bind(id, name, nowIso())
    .run();
  return id;
}

/**
 * Hand out the oldest undispatched command, atomically.
 *
 * It used to be SELECT, then UPDATE by id: two beacons landing together (a
 * retry racing the original) could both read the same row and both dispatch
 * it - "reboot" twice. The claim and the read are one statement now, and the
 * `AND dispatched_at IS NULL` means only one caller can ever win the row.
 */
export const DISPATCH_SQL = `UPDATE pi_commands SET dispatched_at = ?1
  WHERE id = (SELECT id FROM pi_commands WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 1)
    AND dispatched_at IS NULL
  RETURNING id, command`;

/** reboot never reports back (the Pi is gone first), so it completes on dispatch. */
export const REBOOT_COMPLETE_SQL = `UPDATE pi_commands SET completed_at = ?1, ok = 1,
    result = 'reboot issued - the Pi cannot report back, watch for the speaker coming online'
  WHERE id = ?2`;
