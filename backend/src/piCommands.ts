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
