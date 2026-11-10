/** Shapes the Admin endpoints return. */

export interface AdminUser {
  id: string;
  name: string;
  jersey_number: string | null;
  first_name: string;
  last_name: string;
  active: number;
  // Only used to tell the coach what deleting this person costs. Deleting is
  // irreversible, so the confirm has to name the damage rather than ask for a
  // blind yes.
  plays: number;
  votes: number;
}

export interface PiCommand {
  id: string;
  command: string;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  ok: number | null;
  result: string | null;
}

/**
 * Long-form output from the box: a diagnostic dump or a repair log.
 *
 * Kept apart from PiCommand.result because it IS apart — the server truncates
 * that column to 2000 characters, so the body travels on its own beacon
 * payload into `pi_reports`. See backend/migrations/007-remote-diagnostics.sql.
 */
/** What the box last said about itself, from GET /api/admin/pi/commands. */
export interface PiInfo {
  /** null = never reported: the box still runs the pre-updater listener. */
  software: { commit: string; installed_at: string | null } | null;
  /** The hostname the box checks in through. */
  via_host: string | null;
  /** Server clock minus the Pi's clock, in ms. Positive = Pi is behind. */
  clock_skew_ms: number | null;
}

export interface PiReport {
  kind: string;
  collected_at: string;
  body: string;
  ok: boolean;
}

export interface BtDevice {
  mac: string;
  // null means the device advertises no name; we show the MAC for these rather
  // than a blank row, which would read as a bug.
  name: string | null;
  cod: number | null;
  rssi: number | null;
}

export interface SpeakerState {
  devices: BtDevice[];
  // "" is a real answer meaning wired output on purpose. null means nobody has
  // ever chosen, in which case the Pi is still following its own config file.
  selected: string | null;
  selected_name: string | null;
  output: { kind: string; card: string | null } | null;
  relay_connected: boolean | null;
  relay_error: string | null;
  speaker_online: boolean;
}

export interface AdminDevice {
  mac_hash: string;
  mac_hint: string;
  alias: string | null;
  claimed_at: string | null;
  owner_name: string | null;
  plays: number;
}

export interface AdminPlay {
  id: string;
  title: string;
  artist: string | null;
  dj_name: string | null;
  started_at: string;
  counted: number;
  voided: number;
}
