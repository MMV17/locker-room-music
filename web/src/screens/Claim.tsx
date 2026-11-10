import { useState } from "react";
import { ApiError, errorMessage, post } from "./../api";
import type { UnclaimedDevice } from "./../api";
import { Banner, Empty, LoadError, PushedPage, Spinner, useLoad } from "./../components";
import { IconPhone } from "./../icons";
import { setFlash, useNavigate } from "./../router";

/**
 * Claiming a device is what turns anonymous plays into DJ credit. It is also
 * first-tap-wins — the API lets any signed-in user claim any unclaimed
 * device and inherit its whole history.
 *
 * The mitigation is this confirm step. Naming the device and stating the
 * number of songs it is about to credit makes a wrong tap obvious and a
 * deliberate one attributable. An admin can un-claim either way.
 */
export function Claim() {
  const navigate = useNavigate();
  const list = useLoad<{ devices: UnclaimedDevice[] }>("/api/devices/unclaimed");
  const devices = list.data?.devices ?? null;
  const [confirming, setConfirming] = useState<UnclaimedDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const claim = async (device: UnclaimedDevice) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/devices/${device.mac_hash}/claim`);
      setFlash("Claimed - your songs now count for you");
      navigate("/");
    } catch (e) {
      // 401 is App's: it is already returning to Join.
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(errorMessage(e, "Could not claim that phone. Try again."));
      }
      setConfirming(null);
      list.retry();
    } finally {
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <main className="screen" style={{ paddingTop: 48 }}>
        <p className="t-label">Claim a phone</p>
        <h1 className="t-title" style={{ margin: "8px 0 18px" }}>
          Is {confirming.alias ?? "this phone"} yours?
        </h1>

        <div className="card" style={{ marginBottom: 20 }}>
          <p className="t-sub">
            Ends in <strong>{confirming.mac_hint}</strong>
          </p>
          <p className="t-sub" style={{ marginTop: 10 }}>
            Claiming credits{" "}
            <strong>
              {confirming.plays} {confirming.plays === 1 ? "song" : "songs"}
            </strong>{" "}
            it has already played to you on the DJ board. Only claim your own phone.
          </p>
        </div>

        <button
          className="btn is-primary is-block"
          disabled={busy}
          onClick={() => claim(confirming)}
          style={{ marginBottom: 10 }}
        >
          Yes, it's mine
        </button>
        <button className="btn is-block" disabled={busy} onClick={() => setConfirming(null)}>
          Cancel
        </button>
      </main>
    );
  }

  return (
    <PushedPage title="Your phone" back="/settings">

      {error && <Banner kind="bad">{error}</Banner>}

      {list.error ? (
        <LoadError message={list.error} onRetry={list.retry} />
      ) : !devices ? (
        <Spinner />
      ) : devices.length === 0 ? (
        <Empty title="No unclaimed phones">
          Phones appear here after they play a song without an owner.
        </Empty>
      ) : (
        <>
          <p className="t-sub" style={{ marginBottom: 14 }}>
            Your phone's own name is usually enough to recognise it.
          </p>
          <div className="rows">
            {devices.map((d) => (
              <button key={d.mac_hash} className="row" onClick={() => setConfirming(d)}>
                <span className="jersey" aria-hidden="true" style={{ background: "var(--hairline)", color: "var(--muted)" }}>
                  <IconPhone />
                </span>
                <span className="row-main">
                  <span className="row-title">{d.alias ?? "Unknown phone"}</span>
                  <span className="row-sub">
                    Ends in {d.mac_hint} · {d.plays} {d.plays === 1 ? "song" : "songs"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </PushedPage>
  );
}
