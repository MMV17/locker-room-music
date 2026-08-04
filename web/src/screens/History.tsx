import { useEffect, useState } from "react";
import { get } from "./../api";
import type { HistoryEntry } from "./../api";
import {
  Artwork,
  Empty,
  Spinner,
  formatScore,
  formatWhen,
  scoreClass,
} from "./../components";

/**
 * Recent plays with final scores. The server omits any play whose vote window
 * is still open, so nothing here can leak a live tally.
 */
export function History() {
  const [plays, setPlays] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    get<{ plays: HistoryEntry[] }>("/api/history")
      .then((r) => setPlays(r.plays))
      .catch(() => setPlays([]));
  }, []);

  return (
    <main className="screen">
      <header className="screen-head">
        <h1 className="t-display">History</h1>
      </header>

      {!plays ? (
        <Spinner />
      ) : plays.length === 0 ? (
        <Empty title="Nothing played yet">
          Songs appear here once the first one finishes.
        </Empty>
      ) : (
        <div className="rows">
          {plays.map((p) => (
            <div key={p.id} className="row">
              <Artwork className="row-art" src={p.artwork_url} fallback={p.artwork_fallback} />
              <span className="row-main">
                <span className="row-title">{p.title}</span>
                <span className="row-sub">
                  {p.dj_name ?? "Unclaimed"} · {formatWhen(p.started_at)}
                  {!p.counted && " · skipped"}
                </span>
              </span>
              {p.voters > 0 && (
                <span className={"row-score " + scoreClass(p.score)}>
                  {formatScore(p.score)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
