import { useEffect, useState } from "react";
import { get, signOut } from "./../api";
import type { NowResponse } from "./../api";
import { useNavigate } from "./../router";
import { SpeakerSection } from "./SpeakerSection";

/**
 * Everything a player sets for themselves, in one place.
 *
 * Speaker selection lives here rather than on Now Playing. It was briefly on
 * the speaker icon in that header, which was discoverable but wrong: Now
 * Playing is the screen you look at while music is on, and a control you touch
 * once a season does not belong in it. A settings page is also where a person
 * goes LOOKING for this, which a status icon that turns out to be a button is
 * not.
 *
 * Reached from the jersey button in the Now Playing header — already the "you"
 * control, and already labelled as the way to change who you are.
 */
export function Settings({ onSignedOut }: { onSignedOut: () => void }) {
  const navigate = useNavigate();
  const [switching, setSwitching] = useState(false);
  const [me, setMe] = useState<NowResponse["viewer"] | null>(null);

  useEffect(() => {
    get<NowResponse>("/api/now")
      .then((n) => setMe(n.viewer ?? null))
      .catch(() => setMe(null));
  }, []);

  return (
    <main className="screen set">
      <header className="set-head">
        <button className="btn-quiet" onClick={() => navigate("/")}>
          ‹ Back
        </button>
        <h1 className="t-section">Settings</h1>
      </header>

      <section className="set-section">
        <h2 className="t-section" style={{ marginBottom: 4 }}>
          You
        </h2>
        <p className="t-sub" style={{ marginBottom: 12 }}>
          Signed in as <strong>{me?.name ?? "…"}</strong>
          {me?.jersey_number ? ` · #${me.jersey_number}` : ""}
        </p>
        <div className="rows">
          <div className="row">
            <span className="row-main">
              <span className="row-title">Claim your phone</span>
              <span className="row-sub">
                Get credit for the songs you play
              </span>
            </span>
            <button className="btn" onClick={() => navigate("/claim")}>
              Open
            </button>
          </div>
          <div className="row">
            <span className="row-main">
              <span className="row-title">Not you?</span>
              <span className="row-sub">Sign in as someone else</span>
            </span>
            <button
              className="btn"
              disabled={switching}
              onClick={async () => {
                setSwitching(true);
                try {
                  await signOut();
                } finally {
                  // Even if the request failed, send them to the join screen -
                  // App re-probes the session, so a still-valid one simply
                  // lands them back here rather than stranding them.
                  onSignedOut();
                  navigate("/");
                }
              }}
            >
              {switching ? "Signing out…" : "Change"}
            </button>
          </div>
        </div>
      </section>

      <SpeakerSection />
    </main>
  );
}
