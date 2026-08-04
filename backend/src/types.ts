export interface Env {
  DB: D1Database;
  /** Shared secret the Pi presents in X-Device-Key. */
  DEVICE_KEY: string;
  /** Salt for hashing MACs. Raw MACs never reach this database. */
  MAC_SALT: string;
  /** Code teammates enter to join. */
  TEAM_CODE: string;
  /** Password gate for admin routes. */
  ADMIN_PASSWORD: string;
  /** The built frontend, served same-origin so the session cookie works. */
  ASSETS: Fetcher;
  /** Daily D1 backups. See backup.ts for the cost guardrails. */
  BACKUPS?: R2Bucket;
}

export interface PlayRow {
  id: string;
  track_id: string;
  device_hash: string | null;
  user_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  played_ms: number | null;
  counted: number;
  voided: number;
  keepalive_at?: string | null;
  play_status?: string | null;
}

export interface TrackRow {
  id: string;
  track_key: string;
  title: string;
  artist: string | null;
  album: string | null;
  artwork_url: string | null;
  artwork_state: string;
}
