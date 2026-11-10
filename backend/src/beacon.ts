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
