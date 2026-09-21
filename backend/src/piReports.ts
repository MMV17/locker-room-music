/**
 * Long-form output from the box: the diagnostic dump and the repair log.
 *
 * Why this is not just `pi_commands.result`: that column is truncated to 2000
 * characters by the beacon handler, and a full diagnostic dump is many times
 * that. A truncated dump is worse than none — the line you needed disappears
 * with nothing on screen admitting it was dropped, which is how 2026-09-20 cost
 * an hour. So the body travels as its own beacon payload into its own table,
 * exactly the way a Bluetooth scan travels into `bt_devices`. See migration 007
 * and speakers.ts, which this deliberately mirrors.
 */
import type { Env } from "./types";

/** The command names whose output is stored here. */
export const REPORT_KINDS = ["report-full", "run-repair"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * A bound on what ONE beacon may write, not a claim about how big a real dump
 * is. A healthy `report-full` runs well under this; the cap exists so a box
 * looping on a wedged unit cannot write a megabyte of journal into D1 every
 * sixty seconds.
 *
 * 64 KiB, against `pi_commands.result`'s 2000. The whole point of this table is
 * that the dump arrives intact.
 */
export const MAX_BODY = 64 * 1024;

/**
 * The marker appended when a body IS cut.
 *
 * Non-negotiable: silent truncation is the specific failure this table was
 * built to stop repeating, so a cut says so, in the body, where whoever is
 * reading the dump on their phone will see it.
 */
export const TRUNCATION_NOTICE =
  "\n\n--- CUT HERE: the report exceeded the server's size limit and the REST IS MISSING ---";

export type PiReport = {
  kind: ReportKind;
  collected_at: string;
  body: string;
  ok: boolean;
};

function isReportKind(value: unknown): value is ReportKind {
  return typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);
}

/**
 * Take the Pi at its word about what it saw, but not about the shape of it —
 * the same stance parseScan() takes, and for the same reason: this text is
 * stored and then rendered in the Admin screen.
 *
 * Returns null for anything that is not a report we asked for. A junk `kind` is
 * dropped rather than stored under itself, which would let the Pi (or anything
 * that could impersonate it) grow this table without bound one key at a time.
 */
export function parseReport(raw: unknown): PiReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (!isReportKind(r.kind)) return null;
  if (typeof r.body !== "string" || r.body === "") return null;

  const body =
    r.body.length > MAX_BODY
      ? r.body.slice(0, MAX_BODY - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE
      : r.body;

  return {
    kind: r.kind,
    // The Pi's clock, when it is sane. Falling back to ours is better than
    // refusing the report: a box with a bad clock is still a box worth seeing.
    collected_at: typeof r.at === "string" && r.at !== "" ? r.at : new Date().toISOString(),
    body,
    // Absent means "assume it worked" only because a report that arrived at all
    // ran far enough to produce one. `false` has to be explicit.
    ok: r.ok !== false,
  };
}

/**
 * Store a report, replacing that kind's previous one.
 *
 * Per KIND, not wholesale: a repair log must not delete the diagnostic that
 * justified running it — reading the two side by side is the entire workflow.
 * Within a kind it is a snapshot the way bt_devices is, because the state of
 * the box an hour ago is not what anyone opened the screen to find out.
 */
export async function storeReport(env: Env, report: PiReport): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pi_reports (kind, collected_at, body, ok) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       collected_at = excluded.collected_at,
       body = excluded.body,
       ok = excluded.ok`,
  )
    .bind(report.kind, report.collected_at, report.body, report.ok ? 1 : 0)
    .run();
}

export async function listReports(env: Env): Promise<PiReport[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, collected_at, body, ok FROM pi_reports ORDER BY collected_at DESC`,
  ).all<{ kind: ReportKind; collected_at: string; body: string; ok: number }>();
  return (results ?? []).map((r) => ({ ...r, ok: r.ok !== 0 }));
}
