import { useEffect, useState } from "react";
import { ApiError, get, post } from "./../api";
import type { RosterUser } from "./../api";
import { Spinner } from "./../components";
import { navigate } from "./../router";

/**
 * Team code, then pick your name. No per-player secret by decision: it is a
 * locker room, everyone is on the same team, and a PIN is one more thing a
 * hundred teenagers can forget. Nothing behind this gate is worth more than
 * that trade.
 */
export function Join({ teamName, onJoined }: { teamName: string; onJoined: () => void }) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"code" | "name">("code");
  const [roster, setRoster] = useState<RosterUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step !== "name") return;
    get<{ users: RosterUser[] }>("/api/roster")
      .then((r) => setRoster(r.users))
      .catch(() => setRoster([]));
  }, [step]);

  const join = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      await post("/api/session", { team_code: code.trim(), user_id: userId });
      navigate("/", true);
      onJoined();
    } catch (e) {
      // The code is only checked here, so a wrong one surfaces at the very
      // last step. Send them back rather than leaving them stuck on a list.
      if (e instanceof ApiError && e.status === 403) {
        setStep("code");
        setError("That team code isn't right.");
      } else if (e instanceof ApiError) {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen" style={{ paddingTop: 48, paddingBottom: 32 }}>
      <p className="t-label">{teamName}</p>
      <h1 className="t-display" style={{ margin: "6px 0 26px" }}>
        {step === "code" ? "Join" : "Who are you?"}
      </h1>

      {error && <div className="banner is-bad">{error}</div>}

      {step === "code" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) setStep("name");
          }}
        >
          <label className="field">
            <span className="t-label">Team code</span>
            <input
              className="input is-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              aria-label="Team code"
            />
          </label>
          <button className="btn is-primary is-block" disabled={!code.trim()}>
            Continue
          </button>
        </form>
      ) : !roster ? (
        <Spinner />
      ) : roster.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No roster yet</p>
          Names appear here once a coach adds the team.
        </div>
      ) : (
        <>
          <div className="rows">
            {roster.map((u) => (
              <button key={u.id} className="row" disabled={busy} onClick={() => join(u.id)}>
                <span className="jersey">{u.jersey_number || u.name[0]}</span>
                <span className="row-main">
                  <span className="row-title">{u.name}</span>
                  {u.position && <span className="row-sub">{u.position}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="center">
            <button className="btn-quiet" onClick={() => setStep("code")}>
              Back
            </button>
          </div>
        </>
      )}
    </main>
  );
}
