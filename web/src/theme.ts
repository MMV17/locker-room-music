/**
 * Team colour plumbing.
 *
 * The admin sets one hex. Everything else on the page is neutral, so that one
 * value has to survive being anything — a navy, a maroon, or a school gold
 * that is invisible as text on white. The derived tokens below are what make
 * an arbitrary colour safe:
 *
 *   --team      the colour as given, used for fills and the tab underline
 *   --team-on   white or near-black, whichever is readable *on* that fill
 *   --team-ink  the colour darkened until it clears 4.5:1 on white, for text
 *   --team-soft the colour at 10%, for tinted backgrounds
 */

export interface Theme {
  primary: string;
  team_name: string;
}

export const FALLBACK_THEME: Theme = {
  primary: "#2f3a45",
  team_name: "Locker Room",
};

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const NEAR_BLACK: Rgb = [20, 23, 28];

/**
 * Darken toward black until the colour clears 4.5:1 against white. Scaling
 * the channels keeps the hue, so a school gold reads as a dark gold rather
 * than drifting to brown.
 */
function inkFor(rgb: Rgb): Rgb {
  let out = rgb;
  for (let i = 0; i < 24 && contrast(out, WHITE) < 4.5; i++) {
    out = [out[0] * 0.9, out[1] * 0.9, out[2] * 0.9];
  }
  return out;
}

export function applyTheme(theme: Theme): void {
  const rgb = parseHex(theme.primary) ?? parseHex(FALLBACK_THEME.primary)!;
  const root = document.documentElement.style;

  root.setProperty("--team", toHex(rgb));
  root.setProperty(
    "--team-on",
    contrast(rgb, WHITE) >= contrast(rgb, NEAR_BLACK) ? "#ffffff" : toHex(NEAR_BLACK),
  );
  root.setProperty("--team-ink", toHex(inkFor(rgb)));
  root.setProperty("--team-soft", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.1)`);
}

/**
 * Cached in localStorage so a reload paints in team colours immediately
 * rather than flashing the neutral default while the fetch is in flight.
 */
const CACHE_KEY = "lr_theme";

export function cachedTheme(): Theme {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return { ...FALLBACK_THEME, ...JSON.parse(raw) };
  } catch {
    /* localStorage can be unavailable in private mode; the default is fine */
  }
  return FALLBACK_THEME;
}

export function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(theme));
  } catch {
    /* not worth surfacing */
  }
}
