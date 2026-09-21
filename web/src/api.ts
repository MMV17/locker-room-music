/**
 * API client. Same-origin with the Worker, so the httpOnly session cookie
 * rides along on its own — nothing here handles a token.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Machine-readable discriminator, when the endpoint sends one. A status
     * alone is not enough: signup returns 403 both for a wrong team code and
     * for a player an admin removed, and treating those the same told someone
     * their code was wrong when it was not.
     */
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    const message = typeof (body as any).error === "string" ? (body as any).error : "Something went wrong";
    const code = typeof (body as any).code === "string" ? (body as any).code : undefined;
    throw new ApiError(res.status, message, code);
  }
  return body as T;
}

export const get = <T,>(path: string) => request<T>(path);

/**
 * Hand the phone back to whoever picks it up next.
 *
 * Deletes the session on the SERVER and clears the cookie. "Not you? / Change"
 * used to just navigate to /join, which the app only renders when signed out -
 * so it landed back on Now Playing as the same person.
 */
export const signOut = () => post("/api/session/signout");
export const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown, headers?: Record<string, string>) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body), headers });
export const patch = <T,>(path: string, body: unknown, headers?: Record<string, string>) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body), headers });

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface Viewer {
  id: string;
  name: string;
  jersey_number: string | null;
}

export interface Dj {
  id: string;
  name: string;
  jersey_number: string | null;
}

export interface DeviceRef {
  mac_hash: string;
  mac_hint: string;
  alias: string | null;
}

export interface NowPlay {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  title: string;
  artist: string | null;
  album: string | null;
  artwork_url: string | null;
  artwork_fallback: string;
  dj: Dj | null;
  device_unclaimed: boolean;
  device: DeviceRef | null;
  i_am_dj: boolean;
  vote_window_open: boolean;
  /** 'playing' | 'paused', from the Pi. Freezes the progress bar. */
  play_status: string;
  /** True playback position from the Pi, excluding paused time. */
  played_ms: number | null;
  /**
   * How old `played_ms` is. The Pi measured it at its last beacon, so treating
   * it as current left the bar a few seconds behind the phone. Add this when
   * the track is playing; when it is paused the position is not moving, so
   * adding it would overshoot.
   */
  played_ms_age_ms: number;
  vote_closes_at: string;
  my_vote: 1 | -1 | null;
  /* No tallies here while the window is open. Spec 6.3 — the single most
     important rule in the project. Do not add them to this type. */
}

/**
 * Who has the speaker right now, straight from the Pi.
 *
 * Null when the speaker is offline — a stale snapshot is worse than none, and
 * naming a holder from twenty minutes ago would stop somebody connecting for
 * no reason.
 */
export interface AuxState {
  /** Null means the aux is free: nobody is connected at all. */
  holder: {
    /** Roster name, when their phone has been claimed. */
    name: string | null;
    /** Bluetooth name, which is all an unclaimed phone has. */
    alias: string | null;
    is_you: boolean;
    /**
     * Milliseconds until anybody may take the aux. Three states, and they are
     * not interchangeable:
     *
     *   null  a song is open. No deadline exists — the grace has not started,
     *         and it restarts on every skip, so any number shown here would
     *         rewind on screen. Show no countdown.
     *   > 0   the song is over and the grace is running out.
     *   0     the grace lapsed. The speaker is still filtered to this phone,
     *         but the aux is free and whoever presses play takes it.
     *
     * Already corrected for beacon age by the Worker. Also null from a Pi
     * running code from before this existed.
     */
    free_in_ms: number | null;
  } | null;
  waiting: number;
  /** Your own phone is connected but not audible. The reason nothing happened. */
  you_are_waiting: boolean;
}

export interface NowResponse {
  speaker_online: boolean;
  viewer: Viewer | null;
  play: NowPlay | null;
  aux: AuxState | null;
}

export interface Results {
  play_id: string;
  title: string;
  artist: string | null;
  upvotes: number;
  downvotes: number;
  voters: number;
  score: number;
  counted: boolean;
}

export interface RosterUser {
  id: string;
  /** Composed server-side from first_name + last_name. */
  name: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
}

export interface TrackEntry {
  id: string;
  title: string;
  artist: string | null;
  artwork_url: string | null;
  artwork_fallback: string;
  plays: number;
  voters: number;
  score: number;
}

export interface DjEntry {
  id: string;
  name: string;
  jersey_number: string | null;
  plays: number;
  score: number;
}

export interface HistoryEntry {
  id: string;
  title: string;
  artist: string | null;
  artwork_url: string | null;
  artwork_fallback: string;
  dj_name: string | null;
  jersey_number: string | null;
  started_at: string;
  counted: boolean;
  score: number;
  voters: number;
}

export interface UnclaimedDevice {
  mac_hash: string;
  mac_hint: string;
  alias: string | null;
  first_seen: string;
  plays: number;
}

export interface MyDj {
  counted_plays: number;
  qualified: boolean;
  plays_until_qualified: number;
}
