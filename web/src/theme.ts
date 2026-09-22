/**
 * The team NAME, and nothing else.
 *
 * This file used to derive four colour tokens from one admin-set hex —
 * --team, --team-on, --team-ink and --team-soft — with a luminance search
 * that darkened an arbitrary school colour until it cleared 4.5:1 on white.
 * That machinery is gone, along with the colour itself.
 *
 * WHY, so nobody rebuilds it: AuxGoat now owns the chrome. The palette is
 * the logo's — black, ivory, antique gold — and it is fixed, so there is no
 * per-school hex to be safe about. A school is still NAMED on screen; it is
 * just not coloured. See the token block at the top of styles.css.
 *
 * The cache stays. The name paints on the first frame from localStorage
 * rather than flashing "Locker Room" while the fetch is in flight.
 */

export interface Theme {
  team_name: string;
}

export const FALLBACK_THEME: Theme = {
  team_name: "Locker Room",
};

const CACHE_KEY = "lr_theme";

export function cachedTheme(): Theme {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    // Spread over the fallback deliberately: a cache written by the OLD build
    // carries a `primary` key too, and this quietly drops it rather than
    // letting a stale colour ride along in the object.
    if (raw) return { team_name: (JSON.parse(raw) as Theme).team_name ?? FALLBACK_THEME.team_name };
  } catch {
    /* localStorage can be unavailable in private mode; the default is fine */
  }
  return FALLBACK_THEME;
}

export function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ team_name: theme.team_name }));
  } catch {
    /* not worth surfacing */
  }
}
