import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { errorMessage, get } from "./api";
import { IconChevron, IconHistory, IconNow, IconSongs, IconUser } from "./icons";
import { goBack, navigate as go, useNavigate, useRoute } from "./router";

/**
 * Artwork, or the server's per-track colour block when iTunes found nothing.
 * Spec 6.4: no broken images, no placeholder icons. The block is a deliberate
 * design element rather than a failure state — the reference's artwork is
 * abstract colour anyway, so it sits in the design rather than apologising.
 */
/**
 * Where to load a stored cover from: through our own origin, not straight from
 * Deezer or Apple. Phones on the campus network could not load the music CDNs
 * (2026-09-27: every song a colour block), and the app's own hostname is the
 * one thing we know gets through. The server only proxies those two hosts;
 * anything else is passed through untouched.
 */
export function artworkSrc(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)(dzcdn\.net|mzstatic\.com|coverartarchive\.org)$/i.test(host)) {
      return "/api/art?u=" + encodeURIComponent(url);
    }
  } catch {
    /* not an absolute URL - leave it alone */
  }
  return url;
}

export function Artwork({
  src,
  fallback,
  className,
  alt = "",
}: {
  src: string | null;
  fallback: string;
  className: string;
  alt?: string;
}) {
  // A cover URL is stored once and trusted forever (spec 6.4), so a CDN that
  // moves or expires an image leaves a permanently dead link. Render the
  // colour block instead of the failure.
  //
  // This is state rather than a DOM poke on the error event. The previous
  // version cleared the element's `src`, and an <img> with no src renders its
  // ALT TEXT — so a dead cover showed the words "Artwork for POWER" sitting on
  // the colour block, which is worse than the torn glyph it was avoiding. It
  // also mutated an element React owns.
  const [failed, setFailed] = useState(false);

  // Reset when the track changes, or the first dead cover in a list would
  // suppress every image rendered by that component afterwards.
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      <img
        className={className}
        src={artworkSrc(src)}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  }
  return <div className={className} style={{ background: fallback }} aria-hidden="true" />;
}

/** Close on Escape. Popovers you cannot dismiss from a keyboard trap people. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside a modal and give focus back when it closes.
 *
 * aria-modal tells a screen reader the page behind is inert; it does nothing
 * for the Tab key, which walked straight out of the confirm dialog and the
 * reveal into the buttons underneath them.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== "Tab" || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (before?.isConnected) before.focus();
    };
  }, [ref]);
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

/**
 * `heading` renders the title as the screen's h1, for the states where the
 * empty message IS the screen (Now Playing with nothing on). Elsewhere the
 * screen already has an h1 and this is a paragraph.
 */
export function Empty({
  title,
  heading = false,
  children,
}: {
  title: string;
  heading?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {heading ? <h1 className="empty-title">{title}</h1> : <p className="empty-title">{title}</p>}
      {children}
    </div>
  );
}

/**
 * A message strip. Errors are an alert, so a screen reader interrupts with
 * them; everything else is a polite status. Hand-rolled `.banner` divs said
 * nothing at all to a screen reader.
 */
export function Banner({ kind, children }: { kind: "bad" | "ok" | "info"; children: ReactNode }) {
  return (
    <div className={"banner is-" + kind} role={kind === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/**
 * GET a path and keep the answer, with a real error state.
 *
 * The boards used to turn a failed fetch into an empty list, so a dropped
 * request on bad wifi read "No songs rated yet". A response for a path the
 * screen has since moved off (a fast tab switch) is dropped, never applied
 * over the newer one.
 */
export function useLoad<T>(path: string): {
  data: T | null;
  error: string | null;
  retry: () => void;
} {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ data: null, error: null });
    get<T>(path)
      .then((data) => current && setState({ data, error: null }))
      .catch(
        (e) =>
          current &&
          setState({ data: null, error: errorMessage(e, "Check your connection and try again.") }),
      );
    return () => {
      current = false;
    };
  }, [path, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** What a screen shows when its data did not load. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty" role="alert">
      <p className="empty-title">Couldn&rsquo;t load this</p>
      <p className="t-sub">{message}</p>
      <button className="btn" style={{ marginTop: 16 }} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** Big number readouts: −1..+1 is meaningless in a locker room as "-0.4285". */
export function scoreClass(score: number): string {
  if (score > 0.02) return "is-pos";
  if (score < -0.02) return "is-neg";
  return "is-flat";
}

export function formatScore(score: number): string {
  const rounded = Math.round(score * 100);
  return (rounded > 0 ? "+" : "") + rounded;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatWhen(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Four places, each with a name under its icon.
 *
 * Until the 2026-11 redesign this was four bare icons (Now, Songs, DJs,
 * History) and everything else - your profile, your phone, the speaker, signing
 * out - hung off a gear that only existed on one screen. So the bar now holds
 * the four things a person comes here to DO, and the fourth is the front door
 * to everything about them:
 *
 *   Now      what is playing, and your vote
 *   Charts   Songs and DJs, one switch apart
 *   History  what played
 *   You      profile, your phone, the speaker, account
 *
 * `match` decides which tab is lit on a page that is not a tab root, so a
 * pushed page still shows where you are.
 */
const NAV = [
  { path: "/", label: "Now", Icon: IconNow, match: (r: string) => r === "/" },
  { path: "/songs", label: "Charts", Icon: IconSongs, match: (r: string) => r === "/songs" || r === "/djs" },
  { path: "/history", label: "History", Icon: IconHistory, match: (r: string) => r === "/history" },
  { path: "/settings", label: "You", Icon: IconUser, match: (r: string) => r.startsWith("/settings") || r === "/claim" },
];

export function Nav() {
  const route = useRoute();
  const navigate = useNavigate();
  return (
    <nav className="nav" aria-label="Sections">
      {NAV.map(({ path, label, Icon, match }) => {
        const active = match(route);
        return (
          <button
            key={path}
            className={"nav-item" + (active ? " is-active" : "")}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              tapFeedback();
              navigate(path);
            }}
          >
            {/* One pill, re-parented to whichever tab is lit. It carries a
                view-transition-name, so the browser slides it across the bar
                rather than fading one out and another in. */}
            {active && <span className="nav-pill" aria-hidden="true" />}
            <Icon />
            <span className="nav-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The lightest tap a phone can give, where it can give one (Android). */
export function tapFeedback(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not supported, or blocked until the first user gesture. Never matters.
  }
}

/**
 * Horizontal swipes on an element: left = next, right = previous.
 *
 * Deliberately a flick detector rather than a drag-follower: it fires once,
 * after the finger has clearly gone sideways (not down the list), and the
 * page transition does the moving. `edge` restricts it to swipes that START
 * at the left edge of the screen, which is the "back" gesture.
 */
export function useSwipe(
  ref: React.RefObject<HTMLElement>,
  { onLeft, onRight, edge = false }: { onLeft?: () => void; onRight?: () => void; edge?: boolean },
) {
  const handlers = useRef({ onLeft, onRight });
  handlers.current = { onLeft, onRight };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let tracking = false;
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      // A swipe that begins on a control with its own sideways meaning (a
      // text field, the segmented switch) is not a page swipe.
      if ((e.target as HTMLElement).closest("input, textarea, [data-no-swipe]")) return;
      if (edge && t.clientX > 28) return;
      x0 = t.clientX;
      y0 = t.clientY;
      t0 = Date.now();
      tracking = true;
    };
    const end = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Date.now() - t0 > 700) return;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
      if (dx < 0) handlers.current.onLeft?.();
      else handlers.current.onRight?.();
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchend", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchend", end);
    };
  }, [ref, edge]);
}

/**
 * The header of a pushed page: a round back button and a large title.
 *
 * Every page that is not a tab root uses this, so "how do I get back" has one
 * answer everywhere - the button, the left-edge swipe (see PushedPage), or the
 * browser's own back.
 */
export function PageHead({ title, back }: { title: string; back: string }) {
  return (
    <header className="page-head">
      <button className="back-btn" aria-label="Back" onClick={() => goBack(back)}>
        <IconChevron />
      </button>
      <h1 className="t-display">{title}</h1>
    </header>
  );
}

/** A pushed page: PageHead plus swipe-from-the-left-edge to go back. */
export function PushedPage({
  title,
  back,
  className = "",
  children,
}: {
  title: string;
  back: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useSwipe(ref, { onRight: () => goBack(back), edge: true });
  return (
    <main ref={ref} className={"screen is-pushed " + className}>
      <PageHead title={title} back={back} />
      {children}
    </main>
  );
}

/**
 * Songs | DJs. The two charts are one tab with a switch, and the switch is
 * also a swipe (see ChartsPage). `replace` on the navigation: flipping between
 * the two should not pile up history that Back then has to walk through.
 */
export function ChartsSwitch({ value }: { value: "songs" | "djs" }) {
  return (
    <div
      className="segmented"
      role="tablist"
      aria-label="Chart"
      data-no-swipe
      style={{ "--seg-i": value === "songs" ? 0 : 1, "--seg-n": 2 } as React.CSSProperties}
    >
      {(["songs", "djs"] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={v === value}
          className={"segmented-item" + (v === value ? " is-active" : "")}
          onClick={() => {
            if (v === value) return;
            tapFeedback();
            go("/" + v, true);
          }}
        >
          {v === "songs" ? "Songs" : "DJs"}
        </button>
      ))}
    </div>
  );
}

/** The shell both chart screens share: big title, the switch, swipe between. */
export function ChartsPage({ value, children }: { value: "songs" | "djs"; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useSwipe(ref, {
    onLeft: () => value === "songs" && go("/djs", true),
    onRight: () => value === "djs" && go("/songs", true),
  });
  return (
    <main ref={ref} className="screen">
      <header className="screen-head">
        <h1 className="t-display">Charts</h1>
      </header>
      <ChartsSwitch value={value} />
      {children}
    </main>
  );
}

/** Season / month / week, and Top / Bottom. The accent's main home. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="tabs"
      role="tablist"
      data-no-swipe
      style={
        {
          "--seg-i": Math.max(0, options.findIndex((o) => o.value === value)),
          "--seg-n": options.length,
        } as React.CSSProperties
      }
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={"tab" + (o.value === value ? " is-active" : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * An in-page confirmation, replacing window.confirm.
 *
 * The native dialog is rendered by the browser, not the page: it cannot be
 * styled, it is prefixed with the bare hostname
 * ("auxgoat-hc.mmvinton17.workers.dev says"), and on a phone it reads
 * more like a security warning than like part of the product. For a control
 * that deletes a player or empties every leaderboard, looking untrustworthy is
 * the wrong problem to have.
 *
 * The API stays promise-shaped so call sites read the same as before:
 *
 *     if (!(await confirm({ ... }))) return;
 */
export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  /** The destructive action, named. "OK" is what people click without reading. */
  confirmLabel: string;
  danger?: boolean;
}

export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolve = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((res) => {
        resolve.current = res;
        setOptions(opts);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    setOptions(null);
    // Always resolve, including on a cancel. A dismissed dialog that never
    // settles leaves the caller awaiting forever, which looks like a hang
    // rather than a decline.
    resolve.current?.(ok);
    resolve.current = null;
  }, []);

  const dialog = options ? (
    <ConfirmDialog {...options} onSettle={settle} />
  ) : null;

  return { confirm, dialog };
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onSettle,
}: ConfirmOptions & { onSettle: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef);

  useEffect(() => {
    // Focus lands on CANCEL, never on the destructive button — a stray Return
    // keypress should walk away from the action, not into it.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSettle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSettle]);

  return (
    <div
      className="modal-backdrop"
      // Tapping outside dismisses, matching every sheet on a phone. Guarded on
      // the target so a click that started inside the card does not close it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onSettle(false);
      }}
    >
      <div ref={cardRef} className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2 className="t-section" style={{ marginBottom: 8 }}>
          {title}
        </h2>
        <p className="t-sub" style={{ marginBottom: 18 }}>
          {body}
        </p>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={() => onSettle(false)}>
            Cancel
          </button>
          <button
            className={"btn is-primary" + (danger ? " is-destructive" : "")}
            onClick={() => onSettle(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A folding section, used by both Admin and Settings.
 *
 * Admin had five of these stacked into one shapeless scroll; Settings has the
 * same problem in miniature. Folded, either screen opens as a short menu.
 *
 * `<details>` RATHER THAN A REACT ACCORDION, deliberately. It is keyboard
 * operable, it announces expanded/collapsed to a screen reader, and it is
 * find-in-page friendly, all without a line of code from me. A div with an
 * onClick and an aria-expanded I maintained by hand would be strictly worse at
 * every one of those.
 *
 * WHICH ONE IS OPEN IS REMEMBERED, per section, in localStorage. A coach
 * usually comes here to do one thing repeatedly — clear a stuck play, fix the
 * speaker — and reopening the same fold every time is the kind of small tax
 * that makes a tool feel cheap. Wrapped in try/catch because localStorage
 * throws in private mode, where the default simply applies.
 *
 * `action` moved from the heading row INTO the content. Its original note said
 * it sat up there because Recent plays is fifty rows long and anything below
 * is a scroll away — still true, and the content top is still above those
 * rows. The heading cannot hold it any more: a button inside <summary> is a
 * button that toggles the fold when you click it.
 */
const FOLD_KEY = "lr_admin_folds";

function readFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function Fold({
  title,
  action,
  defaultOpen = false,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => readFolds()[title] ?? defaultOpen);

  const remember = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFolds(), [title]: next }));
    } catch {
      /* private mode; the fold still works, it just will not be remembered */
    }
  };

  return (
    <details
      className="fold"
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) remember(next);
      }}
    >
      <summary className="fold-head">
        <span className="t-section fold-title">{title}</span>
        <span className="fold-mark" aria-hidden="true" />
      </summary>
      {action && <div className="fold-action">{action}</div>}
      {children}
    </details>
  );
}
