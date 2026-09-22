import { useEffect, useState } from "react";
import { ApiError, get, patch, signOut } from "./../api";
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

function SettingsFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <main className="screen set">
      <header className="set-head">
        <button className="btn-quiet" onClick={() => navigate("/")}>
          &lsaquo; Back
        </button>
        <h1 className="t-section">{title}</h1>
      </header>
      {children}
    </main>
  );
}

/** Your name, your number, and the profile header that shows them. */
export function ProfileScreen() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    get<Me>("/api/me").then(setMe).catch(() => setMe(null));
  }, []);
  const initials = me ? (me.first_name[0] ?? "") + (me.last_name[0] ?? "") : "";

  return (
    <SettingsFrame title="Profile">
      {/* The number is the badge, because that is how a locker room identifies
          people; the name confirms it is you. */}
      <div className="prof">
        <span className="prof-badge" aria-hidden="true">
          {me?.jersey_number || initials || "?"}
        </span>
        <span className="prof-who">
          <span className="prof-name">
            {me ? `${me.first_name} ${me.last_name}` : "\u2026"}
          </span>
          <span className="t-chrome prof-sub">
            {me?.jersey_number ? `Number ${me.jersey_number}` : "No number set"}
          </span>
        </span>
      </div>
      <ProfileForm me={me} onSaved={setMe} />
    </SettingsFrame>
  );
}

/** Everything about what the box plays through. */
export function SpeakerScreen() {
  return (
    <SettingsFrame title="Speaker & connection">
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
            <span className="row-title">Claim your phone</span>
            <span className="row-sub">Get credit for the songs you play</span>
          </span>
          <button className="btn" onClick={() => navigate("/claim")}>
            Open
          </button>
        </div>
        <div className="row">
          <span className="row-main">
            <span className="row-title">Sign out</span>
            <span className="row-sub">Sign in as someone else</span>
          </span>
          <SignOutButton onSignedOut={onSignedOut} navigate={navigate} />
        </div>
      </div>
      <p className="t-sub" style={{ marginTop: 10 }}>
        There is no password yet &mdash; the team code is the only gate. Anyone who
        has it can sign in under any name, which is the trade this made to avoid
        a hand-maintained roster.
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
      setError(e instanceof ApiError ? e.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <div className="banner is-bad">{error}</div>}
      {saved && <div className="banner is-ok">Saved.</div>}

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
      {busy ? "Signing out…" : "Change"}
    </button>
  );
}
