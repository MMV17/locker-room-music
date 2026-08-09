/**
 * The landing page, rendered in the Worker with its CSS inlined.
 *
 * Rendered rather than served as a file for two reasons.
 *
 * Cloudflare serves any asset matching the request path *without invoking the
 * Worker*, so an index.html in ./public would be handed straight to the
 * browser and the ?e= error state could never be filled in. Keeping the page
 * in code is what makes `/` reach this Worker at all.
 *
 * And it removes a whole class of bug. The earlier version was a built file
 * with __CODE__ / __ERROR__ tokens the Worker substituted; the file documented
 * its own tokens in a comment, so the first occurrence of each was prose, and
 * String.replace with a string pattern rewrote the comment and served the live
 * tokens raw — __CODE__ sitting in the input box, behind 24 passing tests.
 * There is nothing to substitute here.
 *
 * Inlining the CSS costs ~1.2 kB gzipped and saves a round trip. On the campus
 * wifi this product keeps losing, that is the better trade. The font is the
 * only separate request, and font-display: swap means text paints immediately
 * in a fallback rather than hanging on 32 kB.
 *
 * No JavaScript. The form is a plain GET to /go; the destination is a
 * different origin, so there is a full navigation either way and a fetch would
 * buy nothing while adding a failure mode.
 */

/**
 * Escape for an HTML attribute value. `&` first — reordering it would
 * double-escape the entities introduced by the replacements after it.
 *
 * The rejected code is the only user-controlled string on this page and the
 * only injection surface it has.
 */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
@font-face {
  font-family: "Outfit Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/outfit-latin.woff2") format("woff2-variations");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,
    U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191,
    U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

:root {
  --page: #edf0f5;
  --surface: #ffffff;
  --ink: #14171c;
  --ink-2: #4a515c;
  --muted: #8a93a0;
  --hairline: #e4e8ee;
  --error: #dc2626;
  --shadow: 0 8px 28px rgba(20, 23, 28, 0.07), 0 2px 6px rgba(20, 23, 28, 0.04);
  --safe-b: env(safe-area-inset-bottom, 0px);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }

body {
  min-height: 100svh;
  background: var(--page);
  color: var(--ink);
  font-family: "Outfit Variable", ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  display: grid;
  place-items: center;
  padding: 24px 20px calc(24px + var(--safe-b));
}

.wrap { width: 100%; max-width: 400px; text-align: center; }

/* There is deliberately no logo. The AuxGoat mark is cream and gold on solid
   black, 87% of the artwork is that black field, and it cannot sit on a pale
   page — it was tried in the app header and rejected. The wordmark in type
   carries this instead, and is the most obviously adjustable thing here. */
.mark {
  margin: 0;
  font-size: clamp(44px, 13vw, 60px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.tagline { margin: 10px 0 0; color: var(--ink-2); font-size: 17px; text-wrap: balance; }

.form {
  margin-top: 32px;
  background: var(--surface);
  border-radius: 20px;
  box-shadow: var(--shadow);
  padding: 22px 20px;
  text-align: left;
}

.label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 8px;
}

/* 17px, never smaller: iOS zooms any input under 16px on focus and does not
   zoom back out. Uppercase matches the Join screen so a code looks the same in
   both places. */
.input {
  width: 100%;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--page);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 14px 16px;
  outline: none;
}

.input:focus { border-color: var(--ink); background: var(--surface); }

.error { margin: 12px 0 0; color: var(--error); font-size: 14px; font-weight: 500; }

/* Filled with --ink, not a team colour. There is no team at the apex, so the
   page carries no accent at all rather than borrowing one school's. */
.btn {
  display: block;
  width: 100%;
  margin-top: 16px;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  color: var(--surface);
  background: var(--ink);
  border: 0;
  border-radius: 12px;
  padding: 15px 16px;
  min-height: 52px;
  cursor: pointer;
  box-shadow: var(--shadow);
}

.btn:active { transform: translateY(1px); }

/* The "required" attribute already stops an empty submission natively. This
   only makes the button look the way it behaves. It stays clickable so the
   browser's own "please fill this in" message still fires, which beats a dead
   control. The fill is dropped entirely rather than faded: a half-strength
   button still reads as confidently tappable, which shipped once already on
   the Join screen. */
.form:has(.input:invalid) .btn {
  background: var(--hairline);
  color: var(--muted);
  box-shadow: none;
  cursor: not-allowed;
}

.hint { margin: 20px 0 0; color: var(--muted); font-size: 14px; }

@media (prefers-reduced-motion: reduce) {
  .btn:active { transform: none; }
}
`;

/**
 * @param rejected the code /go just turned away, or null on a clean load.
 *   An empty string still counts as a rejection — it means someone reached
 *   /go with nothing in the field.
 */
export function renderLanding(rejected: string | null, message?: string): string {
  const error =
    rejected === null
      ? ""
      : `<p class="error" role="alert">${
          message ? escapeAttr(message) : "We don&rsquo;t recognise that code."
        }</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#EDF0F5">
<meta name="format-detection" content="telephone=no">
<meta name="description" content="AuxGoat — vote on what&rsquo;s playing in your locker room. Enter your team code to find your team.">
<title>AuxGoat</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
<h1 class="mark">AuxGoat</h1>
<p class="tagline">Vote on what&rsquo;s playing in your locker room.</p>
<form class="form" action="/go" method="get">
<label class="label" for="code">Team code</label>
<input class="input" id="code" name="code" type="text" value="${escapeAttr(rejected ?? "")}"
 required autocapitalize="characters" autocomplete="off" autocorrect="off"
 spellcheck="false" enterkeyhint="go" aria-describedby="hint">
${error}
<button class="btn" type="submit">Go</button>
</form>
<p class="hint" id="hint">Don&rsquo;t have a code? Ask whoever set up your team&rsquo;s speaker.</p>
</main>
</body>
</html>`;
}
