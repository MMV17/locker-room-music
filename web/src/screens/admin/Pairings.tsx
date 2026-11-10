import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner, useConfirm } from "./../../components";
import type { SpeakerState } from "./types";
import type { Call } from "./adminApi";

/**
 * Voiding a play drops it from every ranking without deleting the row —
 * a season of data is not reproducible. Voiding an individual *vote* stays
 * API-only; picking one vote out of a tally is not a phone-screen task.
 */
/**
 * Bluetooth pairings — the INPUT side.
 *
 * Forget used to sit on the speaker picker, and that was wrong in a way worth
 * writing down: that list answers "what does the box play OUT through", and a
 * pairing answers "what connects IN to it". A JBL and a teammate's iPhone were
 * appearing as near-identical rows with opposite meanings, and the destructive
 * button was on the output list.
 *
 * WHAT THIS LIST ACTUALLY IS, because it is not quite "paired devices":
 * bt-scan.sh reports "everything nearby plus everything ever paired", so a
 * device here may never have been bonded. That is deliberate on its side — a
 * paired-but-switched-off speaker has to stay selectable — and it means Forget
 * can be pressed on something that was never paired. bt-forget.sh answers that
 * honestly rather than claiming success, so the imprecision is safe to leave.
 */
export function Pairings({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [state, setState] = useState<SpeakerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<SpeakerState>("/api/admin/pi/speakers")
      .then(setState)
      .catch(() => setState(null));
  }, [call]);
  useEffect(load, [load]);

  const forget = async (mac: string, name: string | null) => {
    const ok = await confirm({
      title: `Forget ${name ?? mac}?`,
      body:
        "Use this when someone forgot the speaker on their phone and now cannot reconnect. They will have to pair again — one tap on their side. Nobody else is affected.",
      confirmLabel: "Forget it",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/admin/pi/forget", {
        method: "POST",
        body: JSON.stringify({ mac }),
      });
      // Nothing changes on screen until the Pi picks the command up on its next
      // beacon, and the row stays either way — this list is what the last SCAN
      // saw, not what is currently bonded. So say so rather than looking broken.
      setNote(`Queued. ${name ?? mac} will be forgotten on the speaker's next check-in.`);
    } catch (e) {
      setError(errorMessage(e, "Could not forget that device"));
    } finally {
      setBusy(false);
    }
  };

  const devices = state?.devices ?? [];

  return (
    <Section title="Bluetooth pairings">
      {dialog}
      {error && <Banner kind="bad">{error}</Banner>}
      {note && <Banner kind="info">{note}</Banner>}

      <p className="t-sub" style={{ marginBottom: 12 }}>
        What the speaker has paired with or seen nearby. Forget one when
        somebody removed AuxGoat on their phone and now cannot reconnect —
        Bluetooth has no way to tell us they did, so the speaker keeps a
        pairing they no longer have and refuses them.
      </p>

      {devices.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing seen yet</p>
          Run a scan from Speaker output first.
        </div>
      ) : (
        <div className="rows">
          {devices.map((d) => {
            const chosen = state?.selected === d.mac;
            return (
              <div key={d.mac} className="row">
                <span className="row-main">
                  <span className="row-title">{d.name ?? d.mac}</span>
                  <span className="row-sub">
                    {chosen ? "This is the output speaker" : d.name ? d.mac : "No name"}
                  </span>
                </span>
                {/* Not offered for the speaker in use: forgetting it drops
                    audio with no error anywhere and costs the one-tap return.
                    The server refuses it and the Pi refuses it again — but not
                    drawing the button is the only one of the three a coach
                    ever sees. */}
                {!chosen && (
                  <button
                    className="btn-quiet is-danger"
                    disabled={busy}
                    onClick={() => forget(d.mac, d.name)}
                  >
                    Forget
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
