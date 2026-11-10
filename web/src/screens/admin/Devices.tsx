import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner, Spinner, useConfirm } from "./../../components";
import type { AdminDevice } from "./types";
import type { Call } from "./adminApi";

export function Devices({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ devices: AdminDevice[] }>("/api/admin/devices")
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, [call]);

  useEffect(load, [load]);

  const unclaim = async (d: AdminDevice) => {
    setError(null);
    try {
      await call(`/api/admin/devices/${d.mac_hash}/unclaim`, { method: "POST" });
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not un-claim that phone"));
    }
  };

  // For clearing out noise: a visitor's phone, a laptop that paired once. The
  // songs stay, but they lose the phone they came from — and an unclaimed song
  // can then never be claimed, because picking your phone off the list is the
  // only thing tying a play to a person. Worth saying out loud in the confirm.
  const remove = async (d: AdminDevice) => {
    const name = d.alias ?? "this phone";
    const cost = d.plays
      ? d.owner_name
        ? `Its ${d.plays} ${d.plays === 1 ? "song stays" : "songs stay"} on record with ${d.owner_name}.`
        : `Its ${d.plays} unclaimed ${d.plays === 1 ? "song stays" : "songs stay"} on record, and nobody will be able to claim ${d.plays === 1 ? "it" : "them"} afterwards.`
      : "It has played nothing.";
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: `${cost} It comes back if that phone plays again.`,
      confirmLabel: "Delete phone",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await call(`/api/admin/devices/${d.mac_hash}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not delete that phone"));
    }
  };

  return (
    <Section title="Phones">
      {dialog}
      {error && <Banner kind="bad">{error}</Banner>}
      <p className="t-sub" style={{ marginBottom: 12 }}>
        Un-claiming leaves the songs on record but removes DJ credit for them. Deleting
        removes the phone itself — the songs stay, and the phone reappears the next time
        it plays.
      </p>
      {!devices ? (
        <Spinner />
      ) : devices.length === 0 ? (
        <p className="t-sub">No phones have played yet.</p>
      ) : (
        <div className="rows">
          {devices.map((d) => (
            <div key={d.mac_hash} className="row">
              <span className="row-main">
                <span className="row-title">{d.alias ?? "Unknown phone"}</span>
                <span className="row-sub">
                  Ends in {d.mac_hint} · {d.plays} {d.plays === 1 ? "song" : "songs"} ·{" "}
                  {d.owner_name ?? "unclaimed"}
                </span>
              </span>
              <span className="row-actions">
                {d.owner_name && (
                  <button className="btn-quiet" onClick={() => unclaim(d)}>
                    Un-claim
                  </button>
                )}
                <button className="btn-quiet is-danger" onClick={() => remove(d)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
