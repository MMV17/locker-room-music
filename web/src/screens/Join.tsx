import { useEffect, useState } from "react";
import { ApiError, post } from "./../api";
import { navigate } from "./../router";
import { Spinner } from "./../components";

/**
 * A team code handed over by the front door at auxgoat.com, which already
 * asked for it once. Nobody should type the same word twice in one sitting.
 *
 * It arrives in the URL FRAGMENT rather than the query string, and that is a
 * privacy decision, not a style one: a fragment is never sent to the server
 * and never appears in a Referer header. This app loads artwork via <img>
 * straight from Deezer and iTunes, so a `?code=` would hand the team code to
 * Apple and Deezer with every cover it fetches — and that code is currently
 * the only gate on the whole team's data.
 */
function codeFromHash(): string | null {
  if (typeof location === "undefined" || !location.hash) return null;
  const code = new URLSearchParams(location.hash.replace(/^#/, "")).get("code");
  return code && code.trim() ? code.trim() : null;
}

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
  const [handed] = useState(codeFromHash);
  const [code, setCode] = useState(handed ?? "");
  // Start verifying immediately when a code was handed over, so the code form
  // never flashes on screen before being skipped past.
  const [verifying, setVerifying] = useState(handed !== null);
  const [step, setStep] = useState<"code" | "name">("code");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [jersey, setJersey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = first.trim() !== "" && last.trim() !== "";

  /**
   * Verify a handed-over code before skipping the step, rather than trusting
   * the redirect. The apex's team map and this Worker's TEAM_CODE secret are
   * independent, so a rotated code would otherwise sail past here and fail at
   * the final submit — which is exactly the "sent back three fields later"
   * confusion that check-code was added to kill.
   */
  useEffect(() => {
    if (handed === null) return;

    // Take it out of the address bar. It has done its job, and leaving a team
    // code in a URL invites it into a screenshot, a shared link, or the tab
    // someone hands to a friend.
    history.replaceState(null, "", location.pathname + location.search);

    let cancelled = false;
    (async () => {
      try {
        await post("/api/session/check-code", { team_code: handed });
        if (!cancelled) setStep("name");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.code === "wrong_team_code"
            ? "That team code isn't right."
            : "Could not check that code. Try again.",
        );
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handed]);

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
      // Branch on `code`, not the status. This endpoint returns 403 both for a
      // wrong team code and for a player an admin removed, and treating them
      // alike told someone their code was wrong when it was correct — which
      // cost a real debugging session. Only a code failure goes back to step
      // one; anything else belongs here, in the player's own words.
      if (err instanceof ApiError && err.code === "wrong_team_code") {
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

      {verifying ? (
        // The code came from the front door and is being checked. Showing the
        // form here would flash a field the player is about to skip past.
        <div className="center" style={{ paddingTop: 24 }}>
          <Spinner />
        </div>
      ) : step === "code" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!code.trim() || busy) return;
            // Check the code here rather than letting it fail after the name
            // form. Getting sent back three fields later is the single most
            // confusing thing in this flow, and a first-timer does it once.
            setBusy(true);
            setError(null);
            try {
              await post("/api/session/check-code", { team_code: code.trim() });
              setStep("name");
            } catch (err) {
              if (err instanceof ApiError && err.code === "wrong_team_code") {
                setError("That team code isn't right.");
              } else {
                setError("Could not check that code. Try again.");
              }
            } finally {
              setBusy(false);
            }
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
          <button
            className="btn is-primary is-block"
            disabled={!code.trim() || busy}
          >
            {busy ? "Checking…" : "Continue"}
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
            {/* Only first and last name gate `ready`, so say so — a first-timer
                doing this once, fast, should not stall hunting for a number
                they may not have been given yet. */}
            <span className="t-label">
              Number <span className="t-optional">optional</span>
            </span>
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
