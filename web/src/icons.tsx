/**
 * Inline SVG only — no icon font, no emoji, nothing fetched at runtime.
 * Everything inherits currentColor and sizes from CSS.
 */

type P = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/* The two that matter. Solid, because a filled shape reads at arm's length
   in a loud room where an outline does not. */

export const ThumbUp = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="currentColor"
      d="M7 21H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3v10Zm2-10.4 4.2-7.1a1 1 0 0 1 1.4-.3l.6.4a2.6 2.6 0 0 1 1 2.8L15.5 9H20a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 18.6 20H9V10.6Z"
    />
  </svg>
);

export const ThumbDown = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="currentColor"
      d="M7 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3V3Zm2 10.4 4.2 7.1a1 1 0 0 0 1.4.3l.6-.4a2.6 2.6 0 0 0 1-2.8L15.5 15H20a2 2 0 0 0 2-2.4l-1.4-7A2 2 0 0 0 18.6 4H9v9.4Z"
    />
  </svg>
);

/* Navigation */

export const IconNow = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...stroke} d="M9 18V5l11-2v13" />
    <circle {...stroke} cx="6" cy="18" r="3" />
    <circle {...stroke} cx="17" cy="16" r="3" />
  </svg>
);

export const IconSongs = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...stroke} d="M4 20V10m6 10V4m6 16v-7m-12 7h12" />
  </svg>
);

export const IconDjs = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle {...stroke} cx="12" cy="8" r="4" />
    <path {...stroke} d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

export const IconHistory = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle {...stroke} cx="12" cy="12" r="8.5" />
    <path {...stroke} d="M12 7.5V12l3 2" />
  </svg>
);

/* Utility */

export const IconBack = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...stroke} d="M15 5l-7 7 7 7" />
  </svg>
);

export const IconClose = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...stroke} d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconPhone = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect {...stroke} x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path {...stroke} d="M10.5 18.5h3" />
  </svg>
);

export const IconSettings = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle {...stroke} cx="12" cy="12" r="3" />
    <path
      {...stroke}
      d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 14H3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.3 7.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3 1Z"
    />
  </svg>
);

/* Speaker liveness, in the corner opposite the jersey.
   The waves are the whole signal: present means the Pi has beaconed, struck
   through means it has not. Colour says the same thing a second time and is
   never the only thing saying it — a red-green blind player sees the slash. */
export const IconSpeaker = ({ className, muted }: P & { muted?: boolean }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...stroke} d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    {muted ? (
      <path {...stroke} d="M16 9.5l4.5 5M20.5 9.5l-4.5 5" />
    ) : (
      <path {...stroke} d="M15.5 9.2a4 4 0 0 1 0 5.6M18.4 6.8a8 8 0 0 1 0 10.4" />
    )}
  </svg>
);

export const IconRefresh = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path {...stroke} d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" />
  </svg>
);
