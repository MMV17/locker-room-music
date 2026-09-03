/* ------------------------------------------------------------------ *
 * THE PAGE BACKGROUND — swap the address on the next line.
 * ------------------------------------------------------------------ */

/**
 * Either a file in `web/public/bg/` written as "/bg/name.jpg", or a full
 * "https://..." address pasted straight from Unsplash. Set it to "" for no
 * background at all, which is exactly how the site looked before this existed.
 *
 * Four are already here to try:
 *   /bg/gym.jpg     old high-school gym, warm wood and blue   <- current
 *   /bg/arena.jpg   dark arena roof
 *   /bg/court.jpg   show court, red seating
 *   /bg/game.jpg    game in progress, banners
 */
export const BACKGROUND_IMAGE = "/bg/gym.jpg";

/**
 * How much of it shows through, 0 to 1. Above about 0.35 the wash starts to
 * lift the white cards off the page and the album artwork stops being the
 * brightest thing on screen, which is the one thing this app exists to show.
 */
export const BACKGROUND_STRENGTH = 0.28;

/* ------------------------------------------------------------------ *
 * Below here is just plumbing.
 * ------------------------------------------------------------------ */

/**
 * The four local files are already blurred, and deliberately so: blurring in
 * CSS instead means the browser recomputes a viewport-sized blur, which is a
 * well-known way to make scrolling stutter on an older phone — and that is
 * most of what this runs on. Baking it in costs nothing at runtime and takes
 * each file to about 40 KB. `web/public/bg/CREDITS.md` has the two-line recipe
 * for cutting a replacement to match, plus the photo credits.
 *
 * A remote address works too, but it is fetched by every phone on every load
 * from someone else's server, so prefer downloading it into `web/public/bg/`.
 */
export function applyBackground(): void {
  document.documentElement.style.setProperty(
    "--bg-image",
    BACKGROUND_IMAGE ? `url("${BACKGROUND_IMAGE}")` : "none",
  );
  document.documentElement.style.setProperty("--bg-strength", String(BACKGROUND_STRENGTH));
}
