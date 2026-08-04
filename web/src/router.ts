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

export function navigate(path: string, replace = false): void {
  if (path === window.location.pathname) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  window.scrollTo(0, 0);
  emit();
}

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
