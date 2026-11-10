/**
 * The key/value `settings` table, in one place.
 *
 * Several features keep a single value here (the team name, the speaker
 * selection, the artwork-heal cursor) precisely so that none of them needs a
 * schema migration. They used to carry their own copy of the same two
 * statements; this is the only copy now.
 */
import type { Env } from "./types";

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** The upsert as a statement, for callers that batch several writes together. */
export function putSettingStmt(
  env: Env,
  key: string,
  value: string,
  now: string = new Date().toISOString(),
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, now);
}

export async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await putSettingStmt(env, key, value).run();
}
