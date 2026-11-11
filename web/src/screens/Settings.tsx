import { useEffect, useState } from "react";
import { errorMessage, get, patch, signOut } from "./../api";
import { Banner, PushedPage } from "./../components";
import { IconChevron, IconPhone, IconShield, IconSignOut, IconSpeaker, IconUser } from "./../icons";
import { useNavigate } from "./../router";
import { SpeakerSection } from "./SpeakerSection";

export interface Me {
  id: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
}

/**
 * The three settings screens.
 *
 * They used to be three folds on one Settings page, reached from the gear.
 * The gear now opens a menu instead and each item lands on its own screen —
 * one thing per page, with a back button, rather than a page that is three
 * things at once. The fold was the right shape for Admin, which has five
 * sections a coach moves between; it was the wrong shape for this, where you
 * arrive already knowing which of the three you came for.
 */

/** Every page under You: the shared pushed-page shell, back to the hub. */
function SettingsFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <PushedPage title={title} back="/settings" className="set">
      {children}
    </PushedPage>
  );
}

const SpeakerGlyph = ({ className }: { className?: string }) => <IconSpeaker className={className} />;

function useMe(): [Me | null, (m: Me) => void] {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    get<Me>("/api/me").then(setMe).catch(() => setMe(null));
  }, []);
  return [me, setMe];
}

function Identity({ me }: { me: Me | null }) {
  const initials = me ? (me.first_name[0] ?? "") + (me.last_name[0] ?? "") : "";
  return (
    <div className="prof">
      {/* The number is the badge, because that is how a locker room identifies
          people; the name confirms it is you. */}
      <span className="prof-badge" aria-hidden="true">
        {me?.jersey_number || initials || "?"}
      </span>
      <span className="prof-who">
        <span className="prof-name">{me ? `${me.first_name} ${me.last_name}` : "\u2026"}</span>
        <span className="t-chrome prof-sub">
          {me?.jersey_number ? `Number ${me.jersey_number}` : "No number set"}
        </span>
      </span>
    </div>
  );
}

/**
 * You - the fourth tab, and the front door to everything about the person
 * holding the phone.
 *
 * This replaced a gear on the Now Playing screen. The pages it leads to were
 * always there; what was missing was a place that listed them, reachable from
 * anywhere, with a way back that worked the same every time.
 */
export function YouScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const navigate = useNavigate();
  const [me] = useMe();
  const [busy, setBusy] = useState(false);
  const rows = [
    { to: "/settings/profile", title: "Profile", sub: "Your name and number", Icon: IconUser },
    { to: "/claim", title: "Your phone", sub: "Get credit for the songs you play", Icon: IconPhone },
    { to: "/settings/speaker", title: "Speaker", sub: "What the box plays through", Icon: SpeakerGlyph },
  ];
  return (
    <main className="screen you">
      <header className="screen-head">
        <h1 className="t-display">You</h1>
      </header>
      <button className="you-card" onClick={() => navigate("/settings/profile")}>
        <Identity me={me} />
        <IconChevron className="group-chev" />
      </button>

      <div className="group">
        {rows.map(({ to, title, sub, Icon }) => (
          <button key={to} className="group-row" onClick={() => navigate(to)}>
            <span className="group-icon" aria-hidden="true">
              <Icon />
            </span>
            <span className="group-main">
              <span className="group-title">{title}</span>
              <span className="group-sub">{sub}</span>
            </span>
            <IconChevron className="group-chev" />
          </button>
        ))}
      </div>

      <div className="group">
        <button className="group-row" onClick={() => navigate("/settings/account")}>
          <span className="group-icon" aria-hidden="true">
            <IconShield />
          </span>
          <span className="group-main">
            <span className="group-title">Account</span>
            <span className="group-sub">How signing in works</span>
          </span>
          <IconChevron className="group-chev" />
        </button>
        <button
          className="group-row is-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signOut();
            } finally {
              onSignedOut();
              navigate("/");
            }
          }}
        >
          <span className="group-icon" aria-hidden="true">
            <IconSignOut />
          </span>
          <span className="group-main">
            <span className="group-title">{busy ? "Signing out\u2026" : "Sign out"}</span>
            <span className="group-sub">Sign in as someone else</span>
          </span>
        </button>
      </div>

      <a className="you-coach" href="/admin">
        Coach? Open the admin screen
      </a>
    </main>
  );
}

/** Your name, your number, and the profile header that shows them. */
export function ProfileScreen() {
  const [me, setMe] = useMe();
  return (
    <SettingsFrame title="Profile">
      <Identity me={me} />
      <ProfileForm me={me} onSaved={setMe} />
    </SettingsFrame>
  );
}

/** Everything about what the box plays through. */
export function SpeakerScreen() {
  return (
    <SettingsFrame title="Speaker">
      <SpeakerSection />
    </SettingsFrame>
  );
}

/** Signing in and out, and an honest note about what gates this. */
export function AccountScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const navigate = useNavigate();
  return (
    <SettingsFrame title="Account">
      <div className="rows">
        <div className="row">
          <span className="row-main">
            <span className="row-title">Sign out</span>
            <span className="row-sub">Sign in as someone else</span>
          </span>
          <SignOutButton onSignedOut={onSignedOut} navigate={navigate} />
        </div>
      </div>
      <p className="t-sub" style={{ marginTop: 10 }}>
        There&rsquo;s no password - anyone with the team code can sign in. If
        someone signs in as you, tell your coach.
      </p>
    </SettingsFrame>
  );
}

/**
 * Editing your own name and number.
 *
 * NOT cosmetic, and the copy says so. The roster's identity_key is built from
 * name plus number, and it is what makes a re-signup on a new phone find your
 * existing history instead of starting a second, empty you. Change either and
 * the old pair stops matching — see PATCH /api/me.
 */
function ProfileForm({ me, onSaved }: { me: Me | null; onSaved: (m: Me) => void }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [jersey, setJersey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded from the fetch rather than initialised from it: the fold can be
  // open before /api/me lands.
  useEffect(() => {
    if (!me) return;
    setFirst(me.first_name);
    setLast(me.last_name);
    setJersey(me.jersey_number ?? "");
  }, [me]);

  const dirty =
    !!me &&
    (first !== me.first_name || last !== me.last_name || jersey !== (me.jersey_number ?? ""));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await patch<Me & { ok: true }>("/api/me", {
        first_name: first,
        last_name: last,
        jersey_number: jersey,
      });
      onSaved({ id: me!.id, first_name: r.first_name, last_name: r.last_name, jersey_number: r.jersey_number });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(errorMessage(e, "Could not save that"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Banner kind="bad">{error}</Banner>}
      {saved && <Banner kind="ok">Saved.</Banner>}

      <label className="field">
        <span className="t-label">First name</span>
        <input className="input" value={first} onChange={(e) => setFirst(e.target.value)} />
      </label>
      <label className="field">
        <span className="t-label">Last name</span>
        <input className="input" value={last} onChange={(e) => setLast(e.target.value)} />
      </label>
      <label className="field">
        <span className="t-label">
          Jersey number <span className="t-optional">optional</span>
        </span>
        <input
          className="input"
          value={jersey}
          inputMode="numeric"
          onChange={(e) => setJersey(e.target.value)}
        />
      </label>

      <p className="t-sub" style={{ marginBottom: 12 }}>
        Your name and number are how a new phone finds your play history. If you
        change them, signing in with the old ones will not find you.
      </p>

      <button className="btn is-primary is-block" disabled={!dirty || busy} onClick={save}>
        {busy ? "Saving…" : "Save"}
      </button>
    </>
  );
}

function SignOutButton({
  onSignedOut,
  navigate,
}: {
  onSignedOut: () => void;
  navigate: (to: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signOut();
        } finally {
          // Even if the request failed, send them to the join screen — App
          // re-probes the session, so a still-valid one simply lands them back
          // here rather than stranding them.
          onSignedOut();
          navigate("/");
        }
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
