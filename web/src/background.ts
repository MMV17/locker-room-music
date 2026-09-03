/**
 * Page background.
 *
 * A candidate is a single pre-blurred JPEG in `web/public/bg/`, painted
 * full-bleed behind everything and faded almost all the way out. The point is
 * atmosphere, not a picture: at the default strength the room behind the cards
 * is barely legible as a room, and every existing surface, hairline and piece
 * of type keeps exactly the contrast it has today.
 *
 * WHY THE FILES ARE ALREADY BLURRED. The obvious implementation is a full-size
 * photo under `filter: blur()`, and it is the wrong one twice over. A blur that
 * large is recomputed by the compositor against the whole viewport, which is
 * the classic way to make scrolling stutter on an older phone — and this app is
 * used one-handed, on cellular, in a locker room. Baking the blur in at build
 * time costs nothing at runtime and takes each file to ~40 KB, because a smooth
 * image is almost nothing to a JPEG encoder. `pi/scripts/` has no part in this;
 * the recipe is in bg/CREDITS.md so a replacement can be cut the same way.
 *
 * SWAPPING ONE IN. Drop a JPEG in `web/public/bg/`, add a line to CANDIDATES,
 * and it is selectable. Nothing else knows these names.
 */

export interface Candidate {
  /** Value accepted by `?bg=`. Also the filename stem. */
  id: string;
  /** Shown only in the console hint. */
  label: string;
}

export const CANDIDATES: Candidate[] = [
  { id: "gym", label: "Old high-school gym — warm wood, blue trim" },
  { id: "arena", label: "Arena roof at night — dark, high contrast" },
  { id: "court", label: "Show court — dark with red seating" },
  { id: "game", label: "Game in progress — banners, blue and white" },
];

/**
 * What ships. "none" is deliberate: the background is still being chosen, and
 * a half-picked one on everybody's phone is worse than the flat page that has
 * worked all season. Set this to a candidate id to make it the default.
 */
export const DEFAULT_ID = "none";

/**
 * How much of the photo shows through, 0–1. Tuned against the light palette:
 * above roughly 0.35 the wash starts to lift the white cards off the page and
 * the artwork stops being the brightest thing on screen, which is the one
 * thing this screen exists to show.
 */
export const DEFAULT_STRENGTH = 0.28;

const ID_KEY = "lr_bg";
const STRENGTH_KEY = "lr_bg_strength";

/** Ids are interpolated into a url(), so keep them boring. */
const SAFE_ID = /^[a-z0-9-]{1,32}$/;

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode; the choice just will not survive the reload */
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * `?bg=` wins and is remembered, so a phone can be pointed at a candidate once
 * by URL and then kept there across reloads — which is the whole workflow for
 * judging one of these, since a background only reads correctly on the device
 * it will be used on. `?bg=none` turns it off again.
 */
export function chosenId(search: string, stored: string | null): string {
  const asked = new URLSearchParams(search).get("bg");
  const candidate = asked ?? stored ?? DEFAULT_ID;
  if (candidate === "none") return "none";
  if (!SAFE_ID.test(candidate)) return DEFAULT_ID === "none" ? "none" : DEFAULT_ID;
  return CANDIDATES.some((c) => c.id === candidate) ? candidate : "none";
}

/** `?bgs=0.4` to try a different wash without a rebuild. */
export function chosenStrength(search: string, stored: string | null): number {
  const asked = new URLSearchParams(search).get("bgs");
  const raw = asked ?? stored;
  if (raw === null) return DEFAULT_STRENGTH;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_STRENGTH;
}

/**
 * Called before the first paint, so the wash never fades in after the content
 * has already landed.
 */
export function applyBackground(search = window.location.search): void {
  const id = chosenId(search, load(ID_KEY));
  const strength = chosenStrength(search, load(STRENGTH_KEY));

  if (new URLSearchParams(search).has("bg")) store(ID_KEY, id);
  if (new URLSearchParams(search).has("bgs")) store(STRENGTH_KEY, String(strength));

  const root = document.documentElement.style;
  root.setProperty("--bg-image", id === "none" ? "none" : `url("/bg/${id}.jpg")`);
  root.setProperty("--bg-strength", String(strength));
}
