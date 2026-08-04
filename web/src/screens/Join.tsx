import { useState } from "react";
import { ApiError, post } from "./../api";
import { navigate } from "./../router";

/**
 * Team code, then your own name and number. No admin-curated roster and no
 * per-player secret: it is a locker room, everyone is on the same team, and a
 * PIN is one more thing a hundred teenagers can forget. Nothing behind this
 * gate is worth more than that trade.
 *
 * Signing up with a name and number you have used before returns you to the
 * SAME player rather than creating a second one, so clearing Safari's data or
 * switching phones does not split your history.
 */
export function Join({ teamName, onJoined }: { teamName: string; onJoined: () => void }) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"code" | "name">("code");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [jersey, setJersey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = first.trim() !== "" && last.trim() !== "";

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/session", {
        team_code: code.trim(),
        first_name: first.trim(),
        last_name: last.trim(),
        jersey_number: jersey.trim() || null,
      });
      navigate("/", true);
      onJoined();
    } catch (err) {
      // The code is only checked here, so a wrong one surfaces at the very
      // last step. Send them back rather than leaving them stuck on a form.
      if (err instanceof ApiError && err.status === 403) {
        setStep("code");
        setError("That team code isn't right.");
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not sign you in. Try again.");
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
      ) : (
        <form onSubmit={join}>
          <label className="field">
            <span className="t-label">First name</span>
            <input
              className="input"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              autoCapitalize="words"
              autoComplete="given-name"
              autoCorrect="off"
              autoFocus
              aria-label="First name"
            />
          </label>

          <label className="field">
            <span className="t-label">Last name</span>
            <input
              className="input"
              value={last}
              onChange={(e) => setLast(e.target.value)}
              autoCapitalize="words"
              autoComplete="family-name"
              autoCorrect="off"
              aria-label="Last name"
            />
          </label>

          <label className="field">
            <span className="t-label">Number</span>
            <input
              className="input"
              value={jersey}
              onChange={(e) => setJersey(e.target.value)}
              // Numeric keypad without type="number": jersey numbers are worn
              // as "07" as often as "7", and a number input would eat the
              // leading zero and add spinner arrows nobody wants here.
              inputMode="numeric"
              maxLength={3}
              autoComplete="off"
              aria-label="Jersey number"
            />
          </label>

          <button className="btn is-primary is-block" disabled={!ready || busy}>
            {busy ? "Signing in…" : "Start rating"}
          </button>

          <div className="center">
            <button type="button" className="btn-quiet" onClick={() => setStep("code")}>
              Back
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
