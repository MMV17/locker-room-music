import type { HistoryEntry } from "./../api";
import {
  Artwork,
  Empty,
  LoadError,
  Spinner,
  formatScore,
  formatWhen,
  scoreClass,
  useLoad,
} from "./../components";

/**
 * Recent plays with final scores. The server omits any play whose vote window
 * is still open, so nothing here can leak a live tally.
 */
export function History() {
  const { data, error, retry } = useLoad<{ plays: HistoryEntry[] }>("/api/history");
  const plays = data?.plays ?? null;

  return (
    <main className="screen">
      <header className="screen-head">
        <h1 className="t-display">History</h1>
      </header>

      {error ? (
        <LoadError message={error} onRetry={retry} />
      ) : !plays ? (
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
