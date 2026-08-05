/**
 * Detect that this tab is running a bundle the server no longer serves, and
 * reload once to pick up the current one.
 *
 * Why this is not paranoia. The Worker's asset handler answers **200 with
 * index.html** for any path it does not recognise, including a hashed bundle
 * from a previous deploy. So a tab holding a stale index.html asks for a
 * script that no longer exists and is handed HTML, which the browser then
 * tries to execute as JavaScript. That is a white screen, not a degraded
 * page — and it lands on whoever opened the site before the last deploy,
 * which in a locker room is most of the team.
 *
 * There is no build-time plumbing here on purpose. Vite already content-hashes
 * the entry bundle, so the filename the live index.html points at IS the build
 * id. Comparing that against the script this page actually loaded needs no
 * version file, no header, and nothing kept in sync across two deploys.
 */

/** The entry bundle this page is running, straight from the DOM. */
function runningBundle(): string | null {
  const el = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]',
  );
  const src = el?.getAttribute("src");
  if (src) return new URL(src, location.origin).pathname;
  // Built output should always have that tag; fall back to our own module URL
  // rather than silently doing nothing.
  try {
    return new URL(import.meta.url).pathname;
  } catch {
    return null;
  }
}

/** The entry bundle the server is serving right now. */
async function servedBundle(): Promise<string | null> {
  // `no-store` matters: asking the cache what the cache already has would
  // answer the question with itself.
  const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) return null;
  const html = await res.text();
  return html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

// Survives the reload, so a mismatch that somehow persists cannot become a
// refresh loop. Cleared as soon as we agree with the server again.
const TRIED_KEY = "lr_stale_reload";

export async function reloadIfStale(): Promise<void> {
  const mine = runningBundle();
  if (!mine) return;

  let theirs: string | null;
  try {
    theirs = await servedBundle();
  } catch {
    return; // offline, or the network blinked. Not our problem to solve.
  }

  if (!theirs || theirs === mine) {
    sessionStorage.removeItem(TRIED_KEY);
    return;
  }
  if (sessionStorage.getItem(TRIED_KEY) === theirs) return; // already tried
  sessionStorage.setItem(TRIED_KEY, theirs);
  location.reload();
}

/**
 * Check now, whenever the tab comes back to the foreground, and occasionally
 * while it sits open. The foreground case is the one that matters: a phone
 * left on this screen through a practice is exactly the tab that goes stale.
 */
export function watchForStaleBuild(intervalMs = 5 * 60_000): void {
  void reloadIfStale();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reloadIfStale();
  });
  setInterval(() => void reloadIfStale(), intervalMs);
}
