import { useCallback, useSyncExternalStore } from "react";

/**
 * Seven screens and no nested routes, so a router library would be more bytes
 * than behaviour. This is the whole thing.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

/** How many in-app steps deep this history entry is. 0 = where the tab landed. */
function depth(): number {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

export function navigate(path: string, replace = false): void {
  if (path === window.location.pathname) return;
  const idx = replace ? depth() : depth() + 1;
  window.history[replace ? "replaceState" : "pushState"]({ idx }, "", path);
  window.scrollTo(0, 0);
  emit();
}

/**
 * Back to wherever the player came from, when that was inside the app;
 * otherwise (a deep link, a fresh tab) to `fallback`. Always jumping to "/"
 * threw away where they were.
 */
export function goBack(fallback = "/"): void {
  if (depth() > 0) window.history.back();
  else navigate(fallback, true);
}

/**
 * A one-shot message for the next screen: "Claimed - ..." shown on return
 * from Claim. Read with peekFlash() and dropped with clearFlash(), separately,
 * so React's double-invoked initialisers in StrictMode cannot eat it.
 */
let flash: string | null = null;
export const setFlash = (message: string) => {
  flash = message;
};
export const peekFlash = () => flash;
export const clearFlash = () => {
  flash = null;
};

export function useRoute(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
}

export function useNavigate(): (path: string, replace?: boolean) => void {
  return useCallback(navigate, []);
}
