/**
 * The team code handed over by the front door at auxgoat.com.
 *
 * It arrives in the URL FRAGMENT, and that is a privacy decision rather than a
 * style one: a fragment is never sent to the server and never appears in a
 * Referer header. This app loads artwork via <img> straight from Deezer and
 * iTunes, so a `?code=` would hand the team code to Apple and Deezer with
 * every cover it fetches — and that code is currently the only gate on the
 * whole team's data.
 *
 * Captured at BOOT rather than inside Join, which is the whole point of this
 * module existing. Join does not mount for someone who already has a session,
 * so a signed-in player following a handoff link would keep `#code=CRUSADERS`
 * in their address bar for the rest of the session — screenshot-able and
 * shareable, which is exactly what the fragment was chosen to avoid. Found by
 * running the real flow against production, where the tab was already signed
 * in.
 */
let handed: string | null = null;

/**
 * Read the handed-over code and take it out of the address bar immediately.
 * Call once, before the app renders. Safe to call when there is no fragment.
 */
export function captureHandoff(): void {
  if (typeof location === "undefined" || !location.hash) return;

  const raw = new URLSearchParams(location.hash.replace(/^#/, "")).get("code");
  const trimmed = raw?.trim();
  if (!trimmed) return;

  handed = trimmed;

  // replaceState rather than assigning location.hash: this must not add a
  // history entry, or Back would walk the player into the code again.
  history.replaceState(null, "", location.pathname + location.search);
}

/** The captured code, or null. Reads state — does not touch the URL. */
export function handedTeamCode(): string | null {
  return handed;
}
