import { useEffect, useState } from "react";
import { get } from "./../api";
import type { DjEntry, MyDj } from "./../api";
import { Empty, Spinner, formatScore, scoreClass } from "./../components";

/**
 * Qualified DJs only. Anyone under the threshold is absent from this list
 * entirely (spec 7.2) — they see their own progress in the card at the top,
 * and nobody else sees it at all.
 */
export function DjBoard() {
  const [djs, setDjs] = useState<DjEntry[] | null>(null);
  const [mine, setMine] = useState<MyDj | null>(null);

  useEffect(() => {
    get<{ djs: DjEntry[] }>("/api/leaderboard/djs")
      .then((r) => setDjs(r.djs))
      .catch(() => setDjs([]));
    get<MyDj>("/api/me/dj")
      .then(setMine)
      .catch(() => setMine(null));
  }, []);

  // Scores come back sorted descending, so the leader is [0]. A shared top
  // score is not a tiebreak to invent — it is a tie, and saying so is honest.
  const tiedAtTop = !!djs && djs.length > 1 && djs[1].score === djs[0].score;

  return (
    <main className="screen">
      <header className="screen-head">
        <h1 className="t-display">DJs</h1>
      </header>

      {mine && !mine.qualified && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p className="t-label">Your standing</p>
          <p className="empty-title" style={{ marginTop: 6 }}>
            {mine.counted_plays === 0
              ? "You haven't DJ'd yet"
              : `${mine.counted_plays} counted ${mine.counted_plays === 1 ? "play" : "plays"}`}
          </p>
          <p className="t-sub">
            {mine.plays_until_qualified} more{" "}
            {mine.plays_until_qualified === 1 ? "song" : "songs"} to qualify for this board.
          </p>
        </div>
      )}

      {/* The one moment this board gets to be loud. Everything below is a
          ranked list; this is the only thing anyone will screenshot. */}
      {djs && djs.length > 0 && !tiedAtTop && (
        <div className="goat">
          <span className="jersey">{djs[0].jersey_number || djs[0].name[0]}</span>
          <span className="stack">
            <p className="goat-line">
              <strong>{djs[0].name}</strong> is the{" "}
              <span className="goat-word">AuxGoat</span>
            </p>
            <p className="t-sub goat-sub">
              {djs[0].plays} {djs[0].plays === 1 ? "song" : "songs"} ·{" "}
              {formatScore(djs[0].score)}
            </p>
          </span>
        </div>
      )}

      {/* Crowning one of two people on an identical score would be a coin toss
          the board presented as a fact. Early on, before many songs have been
          rated, matching scores are entirely ordinary. */}
      {djs && tiedAtTop && (
        <div className="goat is-tied">
          <span className="stack">
            <p className="goat-line">
              Tied for <span className="goat-word">AuxGoat</span>
            </p>
            <p className="t-sub goat-sub">
              {djs
                .filter((d) => d.score === djs[0].score)
                .map((d) => d.name)
                .join(" · ")}
            </p>
          </span>
        </div>
      )}

      {!djs ? (
        <Spinner />
      ) : djs.length === 0 ? (
        <Empty title="No qualified DJs yet">
          A DJ needs five counted songs before they appear here.
        </Empty>
      ) : (
        <div className="rows">
          {djs.map((d, i) => (
            <div key={d.id} className="row">
              <span className="row-rank num">{i + 1}</span>
              <span className="jersey">{d.jersey_number || d.name[0]}</span>
              <span className="row-main">
                <span className="row-title">{d.name}</span>
                <span className="row-sub">
                  {d.plays} {d.plays === 1 ? "song" : "songs"}
                </span>
              </span>
              <span className={"row-score " + scoreClass(d.score)}>{formatScore(d.score)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
