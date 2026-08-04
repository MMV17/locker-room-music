import { useEffect, useState } from "react";
import { get } from "./../api";
import type { TrackEntry } from "./../api";
import { Artwork, Empty, Spinner, Tabs, formatScore, scoreClass } from "./../components";

type Window = "season" | "month" | "week";

const WINDOWS: { value: Window; label: string }[] = [
  { value: "season", label: "Season" },
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
];

/**
 * Fetched on load and on tab change only — never polled (spec 8). The server
 * caches these at the edge for 60s on top of that.
 */
export function SongBoard() {
  const [window_, setWindow] = useState<Window>("season");
  const [data, setData] = useState<{ top: TrackEntry[]; bottom: TrackEntry[] } | null>(null);

  useEffect(() => {
    setData(null);
    get<{ top: TrackEntry[]; bottom: TrackEntry[] }>(
      `/api/leaderboard/tracks?window=${window_}`,
    )
      .then(setData)
      .catch(() => setData({ top: [], bottom: [] }));
  }, [window_]);

  return (
    <main className="screen">
      <header className="screen-head">
        <h1 className="t-display">Songs</h1>
      </header>

      <Tabs value={window_} options={WINDOWS} onChange={setWindow} />

      {!data ? (
        <Spinner />
      ) : data.top.length === 0 ? (
        <Empty title="No songs rated yet">Ratings appear after the first song plays.</Empty>
      ) : (
        <>
          <Section title="Best" tracks={data.top} />
          {/* Only worth a second list once there is something to rank against;
              with three tracks total, "worst" is the same list reversed. */}
          {data.bottom.length > 3 && <Section title="Worst" tracks={data.bottom} />}
        </>
      )}
    </main>
  );
}

function Section({ title, tracks }: { title: string; tracks: TrackEntry[] }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2 className="t-section" style={{ marginBottom: 12 }}>
        {title}
      </h2>
      <div className="rows">
        {tracks.map((t, i) => (
          <div key={t.id} className="row">
            <span className="row-rank num">{i + 1}</span>
            <Artwork className="row-art" src={t.artwork_url} fallback={t.artwork_fallback} />
            <span className="row-main">
              <span className="row-title">{t.title}</span>
              <span className="row-sub">
                {t.artist ?? "Unknown artist"} · {t.plays} {t.plays === 1 ? "play" : "plays"} ·{" "}
                {t.voters} {t.voters === 1 ? "vote" : "votes"}
              </span>
            </span>
            <span className={"row-score " + scoreClass(t.score)}>{formatScore(t.score)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
