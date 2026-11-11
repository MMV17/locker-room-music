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
 * wifi this product keeps losing, that is the better trade. The two fonts
 * (the same pair as the team app: Unbounded for the wordmark, Manrope for the
 * rest) are the only separate requests, and font-display: swap means text
 * paints immediately in a fallback rather than hanging on 76 kB.
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

/**
 * The app's palette, so the front door matches the black app it hands off to
 * instead of a pale page that flashes to black on arrival. Same values as
 * web/src/styles.css. Every text/background pairing on this page is checked
 * against WCAG AA in test/apex.test.ts from this object, not from a comment.
 */
export const TOKENS = {
  page: "#000000",
  surface: "#121214",
  ink: "#F8F2E9",
  ink2: "#B3AEA8",
  muted: "#9A9690",
  hairline: "#232221",
  /** Outlined control edge: 3.40:1 on page, 3.03:1 on surface (WCAG 1.4.11). */
  control: "#63615D",
  error: "#f42f2f",
  gold: "#A98C5C",
  onGold: "#12100C",
} as const;

const T = TOKENS;

const CSS = `
@font-face {
  font-family: "Unbounded Variable";
  font-style: normal;
  font-weight: 200 900;
  font-display: swap;
  src: url("/fonts/unbounded-latin.woff2") format("woff2-variations");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,
    U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191,
    U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Manrope Variable";
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url("/fonts/manrope-latin.woff2") format("woff2-variations");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,
    U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191,
    U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

:root {
  --page: ${T.page};
  --surface: ${T.surface};
  --ink: ${T.ink};
  --ink-2: ${T.ink2};
  --muted: ${T.muted};
  --hairline: ${T.hairline};
  --control: ${T.control};
  --error: ${T.error};
  --gold: ${T.gold};
  --on-gold: ${T.onGold};
  --safe-b: env(safe-area-inset-bottom, 0px);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }

body {
  min-height: 100svh;
  /* The same warm glow the team app has behind every page. Its lightest stop
     under any text here is #0a0907, darker than --surface, so every measured
     contrast pair below still holds. */
  background: radial-gradient(120% 55% at 50% -10%, #1b160d 0%, #0a0907 40%, #000 72%) fixed var(--page);
  color: var(--ink);
  font-family: "Manrope Variable", ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  display: grid;
  place-items: center;
  padding: 24px 20px calc(24px + var(--safe-b));
}

.wrap { width: 100%; max-width: 400px; text-align: center; }

/* The wordmark in type, not the logo image: one less request on campus wifi,
   and it is the most obviously adjustable thing here. */
.mark {
  margin: 0;
  /* Unbounded, like every heading in the team app this page hands off to. It
     runs wide, so the wordmark is a step smaller than it was in the old face. */
  font-family: "Unbounded Variable", ui-sans-serif, system-ui, sans-serif;
  font-size: clamp(38px, 11.5vw, 52px);
  font-weight: 650;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.tagline { margin: 10px 0 0; color: var(--ink-2); font-size: 17px; text-wrap: balance; }

/* A hairline, not a drop shadow: on black a shadow is invisible. */
.form {
  margin-top: 32px;
  /* A bronze tint and edge, like the app's cards, rather than a grey box. */
  background: rgba(214, 186, 134, 0.05);
  border: 1px solid rgba(214, 186, 134, 0.2);
  border-radius: 20px;
  padding: 22px 20px;
  text-align: left;
}

.label {
  display: block;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.14em;
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
  /* --control, not --hairline: the field's edge is how you find it. */
  border: 1px solid var(--control);
  border-radius: 12px;
  padding: 14px 16px;
  outline: none;
}

.input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(169, 140, 92, 0.25); }

.error { margin: 12px 0 0; color: var(--error); font-size: 14px; font-weight: 500; }

/* The app's bronze, not a team colour: there is no team at the apex. */
.btn {
  display: block;
  width: 100%;
  margin-top: 16px;
  font: inherit;
  font-size: 17px;
  font-weight: 700;
  color: var(--on-gold);
  background: linear-gradient(180deg, #d9be8b, var(--gold));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 12px 26px -10px rgba(169, 140, 92, 0.6);
  border: 0;
  border-radius: 12px;
  padding: 15px 16px;
  min-height: 52px;
  cursor: pointer;
}

.btn:active { transform: translateY(1px); }

.btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }

/* The "required" attribute already stops an empty submission natively. This
   only makes the button look the way it behaves. It stays clickable so the
   browser's own "please fill this in" message still fires, which beats a dead
   control. The fill is dropped entirely rather than faded: a half-strength
   button still reads as confidently tappable, which shipped once already on
   the Join screen. */
.form:has(.input:invalid) .btn {
  background: rgba(169, 140, 92, 0.12);
  box-shadow: inset 0 0 0 1px rgba(169, 140, 92, 0.28);
  color: var(--muted);
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
<meta name="theme-color" content="#000000">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png" sizes="180x180">
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
