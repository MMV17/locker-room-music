import type { Env } from "./types";

/**
 * Daily D1 backup to R2 (spec 13: "a season of data is not reproducible").
 *
 * COST GUARDRAILS. Cloudflare has no hard spend cap for R2 — there is no
 * setting that says "never bill me". So the guardrails here are structural:
 * they make it impossible for this job to approach the free tier at all,
 * rather than relying on a limit that does not exist.
 *
 * R2 free tier, per month: 10 GB-month storage, 1,000,000 Class A operations
 * (writes/lists), 10,000,000 Class B (reads). Egress is always free.
 *
 * This job's ceiling, by construction:
 *   - one write per day             ->    ~31 Class A ops/month (0.003%)
 *   - MAX_BACKUPS objects retained  ->    hard cap on stored bytes
 *   - MAX_DUMP_BYTES per object     ->    refuses to write a runaway dump
 *   - MAX_TOTAL_BYTES over all      ->    refuses to write if the bucket is
 *                                          somehow already large
 *
 * At 30 retained backups the storage ceiling is MAX_BACKUPS * MAX_DUMP_BYTES
 * = 750 MB worst case, 7.5% of the free allowance, and realistically a few MB
 * because the dump is gzipped JSON of a small database.
 *
 * If a limit is breached the job REFUSES and logs, rather than writing
 * anyway. A missed backup is recoverable (Time Travel covers 30 days); a
 * surprise bill is not the failure mode anyone wants from a $0/month project.
 */

/** Keep this many daily backups. Older ones are deleted. */
export const MAX_BACKUPS = 30;
/** Refuse to store a single dump larger than this. */
export const MAX_DUMP_BYTES = 25 * 1024 * 1024;
/** Refuse to write at all if the bucket already holds more than this. */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** Refuse if the database is implausibly large to hold in Worker memory. */
export const MAX_ROWS = 500_000;

const PREFIX = "d1/";

export interface BackupResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  rows?: number;
  pruned?: number;
  error?: string;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runBackup(env: Env, now: Date): Promise<BackupResult> {
  if (!env.BACKUPS) return { ok: false, error: "R2 bucket binding missing" };

  try {
    // Guardrail: refuse before doing any work if the bucket is already big.
    // Also gives us the object list for pruning, in the same Class A op.
    const listed = await env.BACKUPS.list({ prefix: PREFIX });
    const totalBytes = listed.objects.reduce((n, o) => n + o.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: `bucket holds ${totalBytes} bytes, over the ${MAX_TOTAL_BYTES} guardrail - refusing to write`,
      };
    }

    // Read the schema rather than hardcoding a table list: a table added
    // later would otherwise be silently missing from every backup, and
    // nobody discovers that until they need to restore.
    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        ORDER BY name`,
    ).all<{ name: string }>();

    const dump: Record<string, unknown[]> = {};
    let rows = 0;
    for (const { name } of tables) {
      // Table names come from sqlite_master, not from user input, so they
      // cannot be injected - but they still cannot be bound as parameters.
      const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      dump[name] = results;
      rows += results.length;
      if (rows > MAX_ROWS) {
        return { ok: false, error: `over ${MAX_ROWS} rows - refusing to buffer in memory` };
      }
    }

    const body = await gzip(
      JSON.stringify({
        database: "lockerroom",
        taken_at: now.toISOString(),
        tables: dump,
      }),
    );

    if (body.byteLength > MAX_DUMP_BYTES) {
      return {
        ok: false,
        error: `dump is ${body.byteLength} bytes, over the ${MAX_DUMP_BYTES} guardrail`,
      };
    }

    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
    const key = `${PREFIX}lockerroom-${stamp}.json.gz`;
    await env.BACKUPS.put(key, body, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { rows: String(rows), taken_at: now.toISOString() },
    });

    // Prune oldest beyond MAX_BACKUPS. Keys are timestamped, so lexical sort
    // is chronological. Only ever touches this prefix.
    let pruned = 0;
    const keys = [...listed.objects.map((o) => o.key), key].sort();
    if (keys.length > MAX_BACKUPS) {
      const doomed = keys.slice(0, keys.length - MAX_BACKUPS);
      await env.BACKUPS.delete(doomed);
      pruned = doomed.length;
    }

    return { ok: true, key, bytes: body.byteLength, rows, pruned };
  } catch (err) {
    return { ok: false, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

export async function listBackups(env: Env) {
  if (!env.BACKUPS) return { backups: [], error: "R2 bucket binding missing" };
  const listed = await env.BACKUPS.list({ prefix: PREFIX });
  const objects = listed.objects
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
  return {
    backups: objects,
    total_bytes: objects.reduce((n, o) => n + o.size, 0),
    limits: {
      max_backups: MAX_BACKUPS,
      max_dump_bytes: MAX_DUMP_BYTES,
      max_total_bytes: MAX_TOTAL_BYTES,
      free_tier_storage_bytes: 10 * 1024 * 1024 * 1024,
    },
  };
}
