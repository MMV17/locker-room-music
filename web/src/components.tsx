import { useEffect, useState } from "react";
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
