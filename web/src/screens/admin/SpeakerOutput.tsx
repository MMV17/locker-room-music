import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner, Spinner } from "./../../components";
import type { PiCommand, SpeakerState } from "./types";
import type { Call } from "./adminApi";

/**
 * Which speaker the box plays OUT through.
 *
 * The flow this is built around: press Scan, wait for it to say scanning, THEN
 * put the speaker in pairing mode, then pick it. That order is deliberate and
 * the instruction text is load-bearing. The Pi idles at a 60-second beacon, so
 * the FIRST press can wait that long before the box even hears about it —
 * nothing can tell the Pi to pay attention before it next checks in. Putting
 * the wait in front of the pairing window rather than inside it is what stops
 * a speaker timing out of pairing mode while we queue. After that first press
 * the box is attentive and everything is seconds.
 *
 * Devices are SORTED, never filtered. Class of Device is self-reported and some
 * speakers get it wrong or leave it blank, so a filter can hide the exact
 * speaker somebody is holding — the one failure that would make this screen
 * untrustworthy.
 */

/** Bluetooth major device class 0x04 is Audio/Video. */
function isAudio(cod: number | null): boolean {
  return cod !== null && ((cod >> 8) & 0x1f) === 0x04;
}

function outputLabel(s: SpeakerState): string {
  if (!s.output) return "Unknown — the speaker hasn't reported yet";
  if (s.output.kind === "relay") {
    return `Bluetooth → ${s.selected_name || s.output.card || "a speaker"}`;
  }
  if (s.output.kind === "usb") return "USB audio";
  if (s.output.kind === "jack") return "3.5mm jack";
  return s.output.kind;
}

export function SpeakerOutput({ call }: { call: Call }) {
  const [state, setState] = useState<SpeakerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Without this, a bare `confirm` silently resolves to window.confirm — the
  // typechecker caught it, but only because the signatures differ.
  const [scanState, setScanState] = useState<"idle" | "queued" | "scanning" | "done">("idle");
  // What the Pi said when a scan did not work. "Scan finished." over an empty
  // list hid a refusal (a song was playing) the same way the team screen did.
  const [scanFailure, setScanFailure] = useState<string | null>(null);

  const load = useCallback(
    () =>
      call<SpeakerState>("/api/admin/pi/speakers")
        .then(setState)
        .catch(() => setState(null)),
    [call],
  );

  useEffect(() => {
    load();
  }, [load]);

  // While a scan is in flight, watch the command history for it. Polling only
  // then, and never otherwise: this screen is open for minutes at a time and
  // there is nothing to see between scans.
  useEffect(() => {
    if (scanState !== "queued" && scanState !== "scanning") return;
    const timer = setInterval(async () => {
      try {
        const r = await call<{ commands: PiCommand[] }>("/api/admin/pi/commands");
        const scan = r.commands.find((c) => c.command === "scan-speakers");
        if (!scan) return;
        if (scan.completed_at) {
          setScanState("done");
          setScanFailure(scan.ok === 0 ? scan.result || "the scan failed" : null);
          load();
        } else if (scan.dispatched_at) {
          setScanState("scanning");
        }
      } catch {
        /* a failed poll is not worth surfacing; the next one is 3s away */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [scanState, call, load]);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/commands", {
        method: "POST",
        body: JSON.stringify({ command: "scan-speakers" }),
      });
      setScanState("queued");
      setScanFailure(null);
    } catch (e) {
      setError(errorMessage(e, "Could not start a scan"));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (mac: string | null, name: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/speakers", {
        method: "PUT",
        body: JSON.stringify({ mac, name }),
      });
      await load();
    } catch (e) {
      setError(errorMessage(e, "Could not set that speaker"));
    } finally {
      setBusy(false);
    }
  };

  // Audio gear first, then the strongest signal — the speaker in your hand is
  // usually the nearest one. Unknown class and unknown signal both sort last
  // rather than being guessed at in either direction.
  const sorted = state
    ? [...state.devices].sort((a, b) => {
        const audio = Number(isAudio(b.cod)) - Number(isAudio(a.cod));
        if (audio !== 0) return audio;
        const rssi = (b.rssi ?? -999) - (a.rssi ?? -999);
        if (rssi !== 0) return rssi;
        return (a.name ?? a.mac).localeCompare(b.name ?? b.mac);
      })
    : [];

  const scanMessage = {
    idle: "",
    queued: "Waiting for the speaker to check in — this can take up to a minute.",
    scanning: "Scanning now. Put your speaker in pairing mode.",
    done: scanFailure ? `Scan didn't run: ${scanFailure}` : "Scan finished.",
  }[scanState];

  return (
    <Section title="Speaker output">
      {error && <Banner kind="bad">{error}</Banner>}

      {!state ? (
        <Spinner />
      ) : (
        <>
          <div className="rows" style={{ marginBottom: 14 }}>
            <div className="row">
              <span className="row-main">
                <span className="row-title">Playing through</span>
                <span className="row-sub">
                  {outputLabel(state)}
                  {state.relay_error ? ` · ${state.relay_error}` : ""}
                </span>
              </span>
              {state.selected ? (
                <button
                  className="btn-quiet"
                  disabled={busy}
                  onClick={() => choose(null, null)}
                >
                  Use wired output
                </button>
              ) : null}
            </div>
          </div>

          <p className="t-sub" style={{ marginBottom: 10 }}>
            Press <strong>Scan</strong>, wait for it to say it's scanning, and{" "}
            <em>then</em> put your speaker into pairing mode. The speaker checks
            in about once a minute, so the first press can take that long to
            start.
          </p>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
            <button className="btn" disabled={busy} onClick={scan}>
              {scanState === "queued" || scanState === "scanning"
                ? "Scanning…"
                : "Scan for speakers"}
            </button>
            {scanMessage && <span className="t-sub">{scanMessage}</span>}
          </div>

          {sorted.length === 0 ? (
            <div className="empty">
              <p className="empty-title">No devices found yet</p>
              Run a scan with your speaker switched on and in pairing mode.
            </div>
          ) : (
            <div className="rows">
              {sorted.map((d) => {
                const chosen = state.selected === d.mac;
                return (
                  <div key={d.mac} className="row">
                    <span className="row-main">
                      <span className="row-title">{d.name ?? d.mac}</span>
                      <span className="row-sub">
                        {isAudio(d.cod) ? "Audio device" : "Other device"}
                        {d.name ? ` · ${d.mac}` : ""}
                        {chosen
                          ? state.relay_connected
                            ? " · connected"
                            : " · selected, not connected"
                          : ""}
                      </span>
                    </span>
                    <button
                      className={chosen ? "btn-quiet" : "btn"}
                      disabled={busy || chosen}
                      onClick={() => choose(d.mac, d.name)}
                    >
                      {chosen ? "In use" : "Use this one"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
