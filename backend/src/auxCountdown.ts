/**
 * How long until the aux is free, corrected for how stale the beacon is.
 *
 * The Pi measures the remaining grace at the moment it beacons. By the time a
 * phone reads it, that reading is old — up to a 60s idle beacon interval plus
 * a 7.5s poll, against a grace of 20s. Serving it raw would show a countdown
 * frozen at its starting value and then jumping to free.
 *
 * This is the same correction `played_ms_age_ms` makes for the progress bar,
 * applied server-side because nothing on the site wants the Pi's raw reading.
 * The client re-anchors on this number every poll and ticks locally between
 * them.
 */
export function freshCountdown(
  reported: number | null,
  lastSeenAt: string,
  now: number = Date.now(),
): number | null {
  // NULL means a song is open: AUX_GRACE has not started and there is no
  // deadline to age. Inventing one here would put a number on screen that
  // rewinds every time the holder skips a track, which is the single thing
  // this feature must never do.
  if (reported == null) return null;

  const age = now - Date.parse(lastSeenAt);

  // Clamped at BOTH ends.
  //
  // Floor: 0 is a real state — the grace lapsed, the aux is free, press play.
  // A beacon old enough to drive this negative is one from before it ran out,
  // and free is exactly what the aux became. Negative would render as
  // "yours in -40s".
  //
  // Ceiling: the Pi's clock and the Worker's are not the same clock, and a
  // beacon stamped slightly in the future must not inflate the countdown past
  // what the Pi actually reported.
  return Math.max(0, Math.min(reported, reported - age));
}
