import { useEffect, useState } from "react";
import { Banner } from "./../components";
import { useNavigate } from "./../router";
import { PW_KEY, useAdminCall } from "./admin/adminApi";
import { Covers } from "./admin/Covers";
import { Devices } from "./admin/Devices";
import { Speaker } from "./admin/Diagnostics";
import { Plays } from "./admin/Plays";
import { Roster } from "./admin/Roster";
import { SpeakerOutput } from "./admin/SpeakerOutput";
import { Appearance } from "./admin/TeamName";

export function Admin({ teamName }: { teamName: string }) {
  const navigate = useNavigate();
  const [pw, setPw] = useState(() => sessionStorage.getItem(PW_KEY) ?? "");
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useAdminCall(pw);

  // Re-authenticate silently on reload when the password is still in session.
  //
  // Mount only, and against the stored value rather than the live field. With
  // `pw` in the dependency list this fired an admin request on every
  // keystroke, and the form unmounted underneath the user mid-submit as soon
  // as one of those partial attempts happened to succeed.
  useEffect(() => {
    const stored = sessionStorage.getItem(PW_KEY);
    if (!stored) return;
    fetch("/api/admin/users", { headers: { "X-Admin-Password": stored } })
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
  }, []);

  if (!authed) {
    return (
      <main className="screen" style={{ paddingTop: 48 }}>
        <p className="t-label">{teamName}</p>
        <h1 className="t-display" style={{ margin: "6px 0 26px" }}>
          Admin
        </h1>
        {error && <Banner kind="bad">{error}</Banner>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await call("/api/admin/users");
              sessionStorage.setItem(PW_KEY, pw);
              setAuthed(true);
            } catch {
              setError("Wrong password.");
            }
          }}
        >
          <label className="field">
            <span className="t-label">Admin password</span>
            <input
              className="input"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <button className="btn is-primary is-block" disabled={!pw}>
            Sign in
          </button>
        </form>
        <div className="center">
          <button className="btn-quiet" onClick={() => navigate("/")}>
            Back to the app
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen" style={{ paddingBottom: 40 }}>
      <header className="screen-head">
        <h1 className="t-display">Admin</h1>
        <button className="btn-quiet" onClick={() => navigate("/")}>
          Done
        </button>
      </header>

      {/* Ordered by why you opened this screen, not by when it was built.
          It used to lead with the team name — a thing you set once a season —
          and put the remote commands ABOVE the speaker picker they operate on.

          The split that matters is doing vs reading, and output vs input:
          Speaker output is where you change and fix the box, and Diagnostics
          is purely what came back. A "Bluetooth pairings" section with a
          Forget button sat here until 2026-11-13: the box now accepts a phone
          that forgot it re-pairing by itself (JustWorksRepairing = always,
          pi/scripts/bt-repair-policy.sh), which was that button's whole job.
          forget-selected-phone stays on the allowlist, unused. */}
      <SpeakerOutput call={call} />
      <Devices call={call} />
      <Roster call={call} />
      <Plays call={call} />
      <Covers call={call} />
      <Appearance call={call} />
      <Speaker call={call} />
    </main>
  );
}
