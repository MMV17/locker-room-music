/**
 * Must stay behaviourally identical to `normalize`/`track_key` in
 * pi/lockerroom/lifecycle.py — the Pi debounces on its version and the
 * server dedupes tracks on this one. If they drift, the same song starts
 * accumulating votes under two different track rows.
 */
export function normalize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function trackKey(title: string | null, artist: string | null): string {
  return `${normalize(artist)}|${normalize(title)}`;
}
