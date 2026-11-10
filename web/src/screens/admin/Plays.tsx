import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./../../api";
import { Fold as Section, Banner, Spinner, formatWhen, useConfirm } from "./../../components";
import type { AdminPlay } from "./types";
import type { Call } from "./adminApi";

export function Plays({ call }: { call: Call }) {
  const { confirm, dialog } = useConfirm();
  const [plays, setPlays] = useState<AdminPlay[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ plays: AdminPlay[]; total: number }>("/api/admin/plays")
      .then((r) => {
        setPlays(r.plays);
        setTotal(r.total);
      })
      .catch(() => setPlays([]));
  }, [call]);

  useEffect(load, [load]);

  const voidPlay = async (p: AdminPlay) => {
    const ok = await confirm({
      title: `Void "${p.title}"?`,
      body: "It stays on record but stops counting toward every ranking.",
      confirmLabel: "Void song",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setNote(null);
    try {
      await call(`/api/admin/plays/${p.id}/void`, { method: "POST" });
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not void that song"));
    }
  };

  // For the end of a test run or the start of a season. The leaderboards are
  // cumulative, so without this a week of experiments sits on top of the first
  // real session forever.
  const clearAll = async () => {
    // One dialog, not two. The second prompt existed because a native
    // confirm's button just says OK, so the only way to slow someone down was
    // to ask twice. A button that says "Clear 66 songs" is stronger protection
    // than a second identical prompt, and does not train anyone to double-tap.
    const ok = await confirm({
      title: "Clear history?",
      body: `All ${total} ${total === 1 ? "song stops" : "songs stop"} counting toward every ranking and the leaderboards go empty. The songs stay on record, but this cannot be undone from here.`,
      confirmLabel: `Clear ${total} ${total === 1 ? "song" : "songs"}`,
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setNote(null);
    try {
      const r = await call<{ voided: number; spared: number }>(
        "/api/admin/plays/void-all",
        { method: "POST" },
      );
      // A success with a footnote, not an error: the open song is spared on
      // purpose.
      if (r.spared) {
        setNote(
          `Cleared ${r.voided}. The song on the speaker right now was left alone — clear again once it finishes.`,
        );
      }
      load();
    } catch (e) {
      setError(errorMessage(e, "Could not clear history"));
    }
  };

  return (
    <Section
      title="Recent plays"
      action={
        <button
          className="btn-quiet is-danger"
          onClick={clearAll}
          disabled={!total}
          /* Right padding dropped so it sits flush with the section edge;
             the vertical padding stays, because it is the tap target. */
          style={{ flexShrink: 0, padding: "8px 0 8px 10px" }}
        >
          Clear history ({total})
        </button>
      }
    >
      {dialog}
      {error && <Banner kind="bad">{error}</Banner>}
      {note && <Banner kind="info">{note}</Banner>}
      {!plays ? (
        <Spinner />
      ) : plays.length === 0 ? (
        <p className="t-sub">Nothing has played yet.</p>
      ) : (
        <>
          <div className="rows">
          {plays.map((p) => (
            <div key={p.id} className="row">
              <span className="row-main">
                <span className={"row-title" + (p.voided ? " is-inactive" : "")}>{p.title}</span>
                <span className="row-sub">
                  {p.dj_name ?? "Unclaimed"} · {formatWhen(p.started_at)}
                  {!p.counted && " · skipped"}
                  {!!p.voided && " · voided"}
                </span>
              </span>
              {!p.voided && (
                <button className="btn-quiet is-danger" onClick={() => voidPlay(p)}>
                  Void
                </button>
              )}
            </div>
          ))}
          </div>
        </>
      )}
    </Section>
  );
}
