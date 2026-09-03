/* ------------------------------------------------------------------ *
 * THE PAGE BACKGROUND — swap the address on the next line.
 * ------------------------------------------------------------------ */

/**
 * Either a file in `web/public/bg/` written as "/bg/name.jpg", or a full
 * "https://..." address. Set it to "" for no background at all, which is
 * exactly how the site looked before this existed.
 */
export const BACKGROUND_IMAGE = "/bg/opt1.jpg";

/**
 * How much of it shows through, 0 to 1.
 *
 * The right value depends entirely on the picture, so change the picture and
 * re-judge this number. Two things bound it.
 *
 * Upward: a picture with anything dark in it starts competing with the text
 * laid over it, and past roughly 0.35 it lifts the white cards off the page
 * and the album artwork stops being the brightest thing on screen, which is
 * the one thing this app exists to show. The current abstract is near-white
 * and low-contrast, so it is not what holds this value down.
 *
 * Downward: below about 0.15 it stops reading as a deliberate texture and
 * starts looking like a gradient that rendered wrong.
 *
 * 0.28 was picked by eye against the song list at phone width: the curves are
 * present at the edges and quiet everywhere the content sits.
 */
export const BACKGROUND_STRENGTH = 0.28;

/* ------------------------------------------------------------------ *
 * Below here is just plumbing.
 * ------------------------------------------------------------------ */

/**
 * Keep the file small. The source for the current one was 1.6 MB, which is a
 * miserable thing to send to a phone on cellular in a locker room before it
 * can show anything; downscaling it to 1100px wide costs nothing visible at
 * this size and takes it to 140 KB. `web/public/bg/CREDITS.md` has the
 * one-liner.
 *
 * A remote address works too, but it is then fetched by every phone on every
 * load from someone else's server, so prefer downloading it into
 * `web/public/bg/`.
 */
export function applyBackground(): void {
  document.documentElement.style.setProperty(
    "--bg-image",
    BACKGROUND_IMAGE ? `url("${BACKGROUND_IMAGE}")` : "none",
  );
  document.documentElement.style.setProperty("--bg-strength", String(BACKGROUND_STRENGTH));
}
