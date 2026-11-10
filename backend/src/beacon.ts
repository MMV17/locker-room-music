/**
 * The beacon's writes, as pure statement builders.
 *
 * WHY THIS IS ONE CONDITIONAL STATEMENT. A beacon used to cost a heartbeat
 * upsert, an aux UPDATE, an output UPDATE and, while a song played, a keepalive
 * UPDATE: three or four row-writes, every one of them charged even when it
 * changed nothing (D1 counts an UPDATE that rewrites the same value). At a 10s
 * idle beacon that alone is ~26,000-35,000 writes a day against the free
 * plan's 100,000. Now an unchanged beacon writes NOTHING, and a changed one
 * writes one row.
 *
 * What still forces a write, and why each is safe to skip otherwise:
 *
 *   last_seen_at older than HEARTBEAT_REFRESH_MS
 *       The offline threshold is OFFLINE_AFTER_MS (3 minutes). Refreshing at
 *       60s keeps the stored stamp at most 60s + one beacon interval stale.
 *   any rendered aux/output value changed
 *       Readers see the new value, stamped with a fresh last_seen_at.
 *   aux_free_in_ms > 0
 *       freshCountdown() ages the countdown by (now - last_seen_at). While the
 *       grace is running the stamp MUST move with the value, so a countdown
 *       always writes - which it does anyway, because the value changes. NULL
 *       (a song is open) and 0 (free) do not age, so a stale stamp is harmless.
 */

/** How stale the stored heartbeat may get before an unchanged beacon rewrites it. */
export const HEARTBEAT_REFRESH_MS = 60_000;

export interface AuxWrite {
  holderHash: string | null;
  holderAlias: string | null;
  /** JSON [{hash, alias}], as stored. */
  waitingJson: string;
  freeInMs: number | null;
}

export interface OutputWrite {
  kind: string | null;
  card: string | null;
  relayConnected: number | null;
  relayError: string | null;
}

export interface HeartbeatWrite {
  speakerName: string;
  /** Server time, ISO. */
  now: string;
  /** Undefined = the beacon did not report the aux; leave the columns alone. */
  aux?: AuxWrite;
  /** Undefined = the beacon reported neither output nor relay. */
  output?: OutputWrite;
}

const AUX_COLS = ["aux_holder_hash", "aux_holder_alias", "aux_waiting", "aux_free_in_ms"];
const OUT_COLS = ["output_kind", "output_card", "relay_connected", "relay_error"];

/**
 * ?11 says whether the aux was reported and ?12 whether the output was: a Pi
 * on older code that omits either keeps whatever was stored, exactly as the
 * separate UPDATEs this replaces did.
 */
export const HEARTBEAT_UPSERT_SQL = `INSERT INTO heartbeats
  (speaker_name, last_seen_at, ${AUX_COLS.join(", ")}, ${OUT_COLS.join(", ")})
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  ON CONFLICT(speaker_name) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    ${AUX_COLS.map((c) => `${c} = CASE WHEN ?11 THEN excluded.${c} ELSE heartbeats.${c} END`).join(",\n    ")},
    ${OUT_COLS.map((c) => `${c} = CASE WHEN ?12 THEN excluded.${c} ELSE heartbeats.${c} END`).join(",\n    ")}
  WHERE heartbeats.last_seen_at < ?13
     OR (?11 AND (${AUX_COLS.map((c) => `heartbeats.${c} IS NOT excluded.${c}`).join(" OR ")}
                  OR excluded.aux_free_in_ms > 0))
     OR (?12 AND (${OUT_COLS.map((c) => `heartbeats.${c} IS NOT excluded.${c}`).join(" OR ")}))`;

export function heartbeatParams(w: HeartbeatWrite): (string | number | null)[] {
  const nowMs = Date.parse(w.now);
  return [
    w.speakerName,
    w.now,
    w.aux?.holderHash ?? null,
    w.aux?.holderAlias ?? null,
    w.aux?.waitingJson ?? null,
    w.aux?.freeInMs ?? null,
    w.output?.kind ?? null,
    w.output?.card ?? null,
    w.output?.relayConnected ?? null,
    w.output?.relayError ?? null,
    w.aux ? 1 : 0,
    w.output ? 1 : 0,
    new Date(nowMs - HEARTBEAT_REFRESH_MS).toISOString(),
  ];
}

/**
 * The legacy /api/heartbeat: liveness only, with the same refresh throttle.
 */
export const HEARTBEAT_TOUCH_SQL = `INSERT INTO heartbeats (speaker_name, last_seen_at) VALUES (?1, ?2)
  ON CONFLICT(speaker_name) DO UPDATE SET last_seen_at = excluded.last_seen_at
  WHERE heartbeats.last_seen_at < ?3`;

export function heartbeatTouchParams(speakerName: string, now: string): string[] {
  return [speakerName, now, new Date(Date.parse(now) - HEARTBEAT_REFRESH_MS).toISOString()];
}

/**
 * The song still on the speaker.
 *
 * keepalive_at holds the vote window open (KEEPALIVE_STALE_MS = 150s), and
 * played_ms with keepalive_at is what the progress bar extrapolates from. So a
 * write is needed only when:
 *
 *   the status flipped (playing <-> paused)  the bar must freeze or resume
 *   keepalive_at is older than 30s           well inside the 150s window
 *   the position jumped more than 3s         a seek: extrapolating from the
 *                                            stored pair would now be wrong
 *
 * "Jumped" is measured against where the stored pair says playback should be:
 * stored played_ms plus the time since keepalive_at if it was playing, or
 * nothing if paused. Steady playback therefore never counts as a jump.
 */
export const KEEPALIVE_REFRESH_MS = 30_000;
export const SEEK_TOLERANCE_MS = 3_000;

export const KEEPALIVE_SQL = `UPDATE plays
    SET keepalive_at = ?1, play_status = ?2, played_ms = COALESCE(?3, played_ms)
  WHERE id = ?4 AND ended_at IS NULL
    AND (keepalive_at IS NULL
         OR keepalive_at < ?5
         OR play_status IS NOT ?2
         OR (?3 IS NOT NULL AND (played_ms IS NULL OR ABS(?3 - played_ms
              - CASE WHEN play_status = 'playing'
                     THEN (julianday(?1) - julianday(keepalive_at)) * 86400000.0
                     ELSE 0 END) > ?6)))`;

export function keepaliveParams(
  playId: string,
  status: string,
  playedMs: number | null,
  now: string,
): (string | number | null)[] {
  return [
    now,
    status,
    playedMs,
    playId,
    new Date(Date.parse(now) - KEEPALIVE_REFRESH_MS).toISOString(),
    SEEK_TOLERANCE_MS,
  ];
}

/* ------------------------------------------------------------------ *
 * Bounding what the Pi sends
 *
 * Everything here is stored and later rendered (the Admin screen, the aux
 * banner), and the device key that authorises it lives on a box in a locker
 * room. So fields are bounded and stripped of control characters - but never
 * REJECTED: the speaker in the field runs older listener code, and a beacon it
 * sends today must keep working. A field that cannot be cleaned is dropped to
 * its default, not turned into a 400.
 * ------------------------------------------------------------------ */

export const DEFAULT_SPEAKER_NAME = "AuxGoat";
export const MAX_SPEAKER_NAME = 64;
export const MAX_ALIAS = 64;
export const MAX_SHORT_FIELD = 32;
export const MAX_ERROR_TEXT = 300;

// C0 controls, DEL and C1 controls. Built from code points so the source file
// carries no literal control characters.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/** A trimmed, bounded, control-free string, or null for anything else/empty. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL, " ").trim().slice(0, max).trim();
  return s === "" ? null : s;
}

export function speakerNameFrom(v: unknown): string {
  return cleanText(v, MAX_SPEAKER_NAME) ?? DEFAULT_SPEAKER_NAME;
}

/** Epoch ms for a Pi-supplied ISO timestamp, or null if it does not parse. */
export function parseTimestamp(v: unknown): number | null {
  if (typeof v !== "string" || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** A finite integer, or null. */
export function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/* ------------------------------------------------------------------ *
 * Clock skew, software version, and the hostname the Pi checks in through
 *
 * All three live in `settings` (no schema change) and are written by
 * statements that change nothing - and so cost no row-write - unless the
 * value actually moved. No read is needed first.
 * ------------------------------------------------------------------ */

export const PI_CLOCK_SKEW_KEY = "pi_clock_skew_ms";
export const PI_SOFTWARE_KEY = "pi_software";
export const PI_VIA_HOST_KEY = "pi_via_host";

/** Skew beyond this is logged: votes and plays are stamped with the Pi's clock. */
export const SKEW_LOG_MS = 60_000;
/** The stored skew is rewritten only when it moves by more than this. */
export const SKEW_STORE_DELTA_MS = 5_000;

/** server now - Pi `at`, in ms; null when `at` is absent or does not parse. */
export function clockSkewMs(serverNow: number, at: unknown): number | null {
  const t = parseTimestamp(at);
  return t === null ? null : Math.round(serverNow - t);
}

/** ?1 value (integer ms as text), ?2 now, ?3 the delta. */
export const SKEW_UPSERT_SQL = `INSERT INTO settings (key, value, updated_at) VALUES ('${PI_CLOCK_SKEW_KEY}', ?1, ?2)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE ABS(CAST(settings.value AS INTEGER) - CAST(excluded.value AS INTEGER)) > ?3`;

/** ?1 key, ?2 value, ?3 now: written only when the value differs. */
export const SETTING_IF_CHANGED_SQL = `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE settings.value IS NOT excluded.value`;

export interface PiSoftware {
  /** 4-40 lowercase hex, or the literal "unknown". */
  commit: string;
  /** ISO-8601, or null when the box does not know. */
  installed_at: string | null;
}

const COMMIT = /^(?:[0-9a-f]{4,40}|unknown)$/;

/**
 * The `software` block newer listeners add to every beacon, validated, or null
 * when absent or malformed (dropped, never a 400 - see the section above).
 * Extra keys inside it are ignored.
 */
export function parseSoftware(raw: unknown): PiSoftware | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.commit !== "string" || !COMMIT.test(r.commit)) return null;
  let installed: string | null = null;
  if (r.installed_at !== null && r.installed_at !== undefined) {
    if (parseTimestamp(r.installed_at) === null) return null;
    installed = r.installed_at as string;
  }
  return { commit: r.commit, installed_at: installed };
}

/** Stored form: stable key order, so an unchanged report compares equal. */
export function softwareJson(s: PiSoftware): string {
  return JSON.stringify({ commit: s.commit, installed_at: s.installed_at });
}

/** The parsed stored value, or null for a missing or hand-mangled row. */
export function readSoftware(stored: string | null): PiSoftware | null {
  if (!stored) return null;
  try {
    return parseSoftware(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** A hostname fit to store and show: lowercase DNS characters only. */
export function validHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  const h = host.toLowerCase();
  return h.length > 0 && h.length <= 253 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) ? h : null;
}
