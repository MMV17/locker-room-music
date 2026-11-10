import { useCallback, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

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
  return () => {
    listeners.delete(fn);
  };
}

// Back and forward (the browser's buttons, the edge swipe, goBack) arrive as
// popstate. The URL has already changed by then, so only the direction is
// left to decide: a lower history index is a step back.
let lastIdx = 0;
if (typeof window !== "undefined") {
  lastIdx = depth();
  window.addEventListener("popstate", () => {
    const idx = depth();
    const motion: Motion = idx < lastIdx ? "pop" : "push";
    lastIdx = idx;
    transition(motion, emit);
  });
}

/** How many in-app steps deep this history entry is. 0 = where the tab landed. */
function depth(): number {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

/**
 * The top-level sections, in tab-bar order. Moving between two of these is a
 * sideways step; anything else is going deeper or coming back. That is all the
 * motion system needs to know to pick a direction.
 */
const TAB_ROOTS = ["/", "/songs", "/djs", "/history", "/settings"];

type Motion = "push" | "pop" | "tab-next" | "tab-prev";

function motionFor(from: string, to: string): Motion {
  const a = TAB_ROOTS.indexOf(from);
  const b = TAB_ROOTS.indexOf(to);
  if (a !== -1 && b !== -1) return b > a ? "tab-next" : "tab-prev";
  // Leaving a pushed page for a tab root reads as coming back.
  return b !== -1 ? "pop" : "push";
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Change the page with an animated transition where the browser has one.
 *
 * The View Transitions API snapshots the old screen, runs `update`, snapshots
 * the new one and animates between them; styles.css picks the animation from
 * `data-motion` on the root element. Where it is missing (older browsers) or
 * unwanted (reduced motion), the update simply happens - the app never
 * depends on the animation having run.
 */
function transition(motion: Motion, update: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  if (typeof doc.startViewTransition !== "function" || reducedMotion()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.motion = motion;
  const done = () => {
    if (root.dataset.motion === motion) delete root.dataset.motion;
  };
  try {
    // flushSync: the new screen has to be in the DOM before the callback
    // returns, or the browser snapshots the old one twice.
    doc.startViewTransition(() => flushSync(update)).finished.then(done, done);
  } catch {
    done();
    update();
  }
}

export function navigate(path: string, replace = false): void {
  const from = window.location.pathname;
  if (path === from) return;
  const idx = replace ? depth() : depth() + 1;
  transition(motionFor(from, path), () => {
    window.history[replace ? "replaceState" : "pushState"]({ idx }, "", path);
    lastIdx = idx;
    window.scrollTo(0, 0);
    emit();
  });
}

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
