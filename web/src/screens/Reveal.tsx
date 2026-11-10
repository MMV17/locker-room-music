import { useEffect } from "react";
import type { NowPlay, Results } from "./../api";
import { Artwork, formatScore, scoreClass } from "./../components";
import { ThumbDown, ThumbUp } from "./../icons";

/**
 * Reveal-once bookkeeping.
 *
 * Without this a reload re-pops a result the user already saw, and someone
 * opening the app cold gets a verdict on a song they were never in the room
 * for. The list is capped because it is written once per song, forever.
 */
const KEY = "lr_revealed";
const CAP = 60;

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function wasRevealed(playId: string): boolean {
  return readIds().includes(playId);
}

export function markRevealed(playId: string): void {
  try {
    const next = [playId, ...readIds().filter((id) => id !== playId)].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: the reveal simply repeats on reload, which is survivable */
  }
}

/**
 * The tally is hidden for the whole song and then lands. Spec 9.2 asks for
 * this one transition to get proper attention and for animation elsewhere to
 * stay near zero — that is why this is a full takeover rather than a toast.
 */
export function Reveal({
  play,
  results,
  onClose,
}: {
  play: NowPlay;
  results: Results;
  onClose: () => void;
}) {
  // Dismissable with Escape on the off chance someone is on a laptop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="reveal" role="dialog" aria-modal="true" aria-label="Song result">
          <p className="t-label">The room has spoken</p>

          <Artwork
            className="reveal-art"
            src={play.artwork_url}
            fallback={play.artwork_fallback}
          />

          <div>
            <h1 className="t-title">{results.title}</h1>
            <p className="t-sub">{results.artist ?? "Unknown artist"}</p>
          </div>

          {results.voters === 0 ? (
            <p className="empty-title">Nobody voted</p>
          ) : (
            <>
              <p className={"reveal-score " + scoreClass(results.score)}>
                {formatScore(results.score)}
              </p>
              <div className="reveal-split">
                <span className="tally is-up">
                  <ThumbUp />
                  {results.upvotes}
                </span>
                <span className="tally is-down">
                  <ThumbDown />
                  {results.downvotes}
                </span>
              </div>
              <p className="t-sub">
                {results.voters} {results.voters === 1 ? "vote" : "votes"}
              </p>
            </>
          )}

          {!results.counted && (
            <p className="t-label">Skipped early — not counted toward rankings</p>
          )}

          <button className="btn is-primary" onClick={onClose}>
            Done
          </button>
    </div>
  );
}
