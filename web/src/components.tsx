import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconDjs, IconHistory, IconNow, IconSongs } from "./icons";
import { useNavigate, useRoute } from "./router";

/**
 * Artwork, or the server's per-track colour block when iTunes found nothing.
 * Spec 6.4: no broken images, no placeholder icons. The block is a deliberate
 * design element rather than a failure state — the reference's artwork is
 * abstract colour anyway, so it sits in the design rather than apologising.
 */
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
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  }
  return <div className={className} style={{ background: fallback }} role="presentation" />;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
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

const NAV = [
  { path: "/", label: "Now playing", Icon: IconNow },
  { path: "/songs", label: "Songs", Icon: IconSongs },
  { path: "/djs", label: "DJs", Icon: IconDjs },
  { path: "/history", label: "History", Icon: IconHistory },
];

export function Nav() {
  const route = useRoute();
  const navigate = useNavigate();
  return (
    <nav className="nav" aria-label="Sections">
      {NAV.map(({ path, label, Icon }) => (
        <button
          key={path}
          className={"nav-item" + (route === path ? " is-active" : "")}
          aria-label={label}
          aria-current={route === path ? "page" : undefined}
          onClick={() => navigate(path)}
        >
          <Icon />
        </button>
      ))}
    </nav>
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
    <div className="tabs" role="tablist">
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
 * ("locker-room-music.mmvinton17.workers.dev says"), and on a phone it reads
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
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
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
