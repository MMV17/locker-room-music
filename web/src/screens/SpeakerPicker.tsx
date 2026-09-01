import { useCallback, useEffect, useState } from "react";
import { get, post, put, ApiError } from "./../api";
import { Spinner } from "./../components";

/**
 * Point the AuxGoat at a speaker, from the team app.
 *
 * This lives here rather than in Admin because choosing the output speaker is a
 * DJ's job, not a coach's. A DJ walks into a room with whatever speaker is
 * there; making them find the coach — or handing every DJ the coach password —
 * is not a plan.
 *
 * WHAT MAKES THAT SAFE: the server only allows it when one of your claimed
 * phones is currently connected to the box over Bluetooth. That is a proof of
 * being in the room (about ten metres) that nobody can fake from home, and it
 * needs no new code handed out. It is also refused while somebody ELSE's song
 * is playing — moving the output mid-song is taking the speaker away from the
 * person DJing, which is the same courtesy the aux rule already encodes.
 *
 * The gate is enforced on the SERVER. Everything here is presentation: this
 * component hides buttons it knows will be refused, which is a kindness rather
 * than a control.
 */

interface BtDevice {
  mac: string;
  name: string | null;
  cod: number | null;
  rssi: number | null;
}

interface SpeakerState {
  devices: BtDevice[];
  scanned_at: string | null;
  scanning: "queued" | "scanning" | null;
  selected: string | null;
  selected_name: string | null;
  output: { kind: string; card: string | null } | null;
  relay_connected: boolean | null;
  relay_error: string | null;
  can_change: boolean;
  reason: string;
}

/** Bluetooth major device class 0x04 is Audio/Video. */
function isAudio(cod: number | null): boolean {
  return cod !== null && ((cod >> 8) & 0x1f) === 0x04;
}

function outputLabel(s: SpeakerState): string {
  if (!s.output) return "Not reported yet";
  if (s.output.kind === "relay") {
    return s.selected_name || s.output.card || "a Bluetooth speaker";
  }
  if (s.output.kind === "usb") return "The USB cable";
  if (s.output.kind === "jack") return "The headphone cable";
  return s.output.kind;
}

export function SpeakerPicker({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SpeakerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOthers, setShowOthers] = useState(false);

  const load = useCallback(
    () =>
      get<SpeakerState>("/api/speakers")
        .then((s) => {
          setState(s);
          return s;
        })
        .catch(() => null),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Poll only while a scan is actually in flight. This panel can sit open while
  // somebody wanders around looking for the speaker, and there is nothing to
  // watch between scans.
  useEffect(() => {
    if (!state?.scanning) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [state?.scanning, load]);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      await post("/api/speakers/scan");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start a scan");
    } finally {
      setBusy(false);
    }
  };

  const choose = async (mac: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await put("/api/speakers", { mac });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't change the speaker");
    } finally {
      setBusy(false);
    }
  };

  // Audio gear first, then the strongest signal — the speaker in your hand is
  // usually the nearest one.
  const byCloseness = (a: BtDevice, b: BtDevice) =>
    (b.rssi ?? -999) - (a.rssi ?? -999) ||
    (a.name ?? a.mac).localeCompare(b.name ?? b.mac);

  const speakers = (state?.devices ?? []).filter((d) => isAudio(d.cod)).sort(byCloseness);
  const others = (state?.devices ?? []).filter((d) => !isAudio(d.cod)).sort(byCloseness);

  const row = (d: BtDevice) => {
    const chosen = state?.selected === d.mac;
    return (
      <div key={d.mac} className="row">
        <span className="row-main">
          <span className="row-title">{d.name ?? d.mac}</span>
          <span className="row-sub">
            {chosen
              ? state?.relay_connected
                ? "Playing through this"
                : "Chosen — connecting"
              : d.name
                ? d.mac
                : "No name"}
          </span>
        </span>
        {state?.can_change && !chosen && (
          <button className="btn" disabled={busy} onClick={() => choose(d.mac)}>
            Use this
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a speaker"
    >
      <div className="modal sp-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-section" style={{ marginBottom: 4 }}>
          Speaker
        </h2>
        <p className="t-sub" style={{ marginBottom: 14 }}>
          Playing through: <strong>{state ? outputLabel(state) : "…"}</strong>
          {state?.relay_error ? ` — ${state.relay_error}` : ""}
        </p>

        {error && <div className="banner is-bad">{error}</div>}

        {!state ? (
          <Spinner />
        ) : !state.can_change ? (
          /* The reason always says what to DO. A dead button with no
             explanation is the failure this feature is most likely to
             produce, and "connect your phone first" is the whole fix. */
          <div className="empty">
            <p className="empty-title">You can't change the speaker yet</p>
            {state.reason}
          </div>
        ) : (
          <>
            <p className="t-sub" style={{ marginBottom: 10 }}>
              Tap <strong>Find speakers</strong>, wait for it to start looking,
              and <em>then</em> put your speaker into pairing mode.
            </p>

            <button
              className="btn is-primary"
              style={{ width: "100%", marginBottom: 12 }}
              disabled={busy || !!state.scanning}
              onClick={scan}
            >
              {state.scanning === "queued"
                ? "Waiting for the AuxGoat…"
                : state.scanning === "scanning"
                  ? "Looking…"
                  : "Find speakers"}
            </button>

            {state.devices.length === 0 ? (
              <div className="empty">
                <p className="empty-title">No speakers found yet</p>
                {state.scanning
                  ? "Hold on — it's looking now."
                  : "Tap Find speakers with your speaker switched on."}
              </div>
            ) : (
              <>
                <div className="rows">{speakers.map(row)}</div>
                {speakers.length === 0 && (
                  <p className="t-sub" style={{ marginBottom: 10 }}>
                    Nothing nearby called itself a speaker. Some speakers don't,
                    so check the other devices.
                  </p>
                )}

                {others.length > 0 &&
                  (showOthers ? (
                    <>
                      <p className="t-sub" style={{ margin: "12px 0 6px" }}>
                        Everything else nearby
                      </p>
                      <div className="rows">{others.map(row)}</div>
                    </>
                  ) : (
                    <button
                      className="btn-quiet"
                      style={{ marginTop: 10 }}
                      onClick={() => setShowOthers(true)}
                    >
                      Show other devices ({others.length})
                    </button>
                  ))}
              </>
            )}

            {state.selected ? (
              <button
                className="btn"
                style={{ width: "100%", marginTop: 14 }}
                disabled={busy}
                onClick={() => choose(null)}
              >
                Use the cable instead
              </button>
            ) : null}
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
