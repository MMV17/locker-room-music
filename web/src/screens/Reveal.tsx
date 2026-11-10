import { useEffect, useRef } from "react";
import type { NowPlay, Results } from "./../api";
import { Artwork, formatScore, useEscape, useFocusTrap, scoreClass } from "./../components";
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
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  // Dismissable with Escape on the off chance someone is on a laptop.
  useEscape(onClose);
  // A takeover that never takes focus leaves a keyboard or screen-reader user
  // on a button behind it. Results are already in hand when this mounts.
  useFocusTrap(ref);
  useEffect(() => done.current?.focus(), []);

  return (
    <div ref={ref} className="reveal" role="dialog" aria-modal="true" aria-label="Song result">
          <p className="t-label">The room has spoken</p>

          <Artwork
            className="reveal-art"
            src={play.artwork_url}
            fallback={play.artwork_fallback}
          />

          <div>
            <h2 className="t-title">{results.title}</h2>
            <p className="t-sub">{results.artist ?? "Unknown artist"}</p>
          </div>

          {results.voters === 0 ? (
            <p className="empty-title">Nobody voted</p>
          ) : (
            <>
              <p className={"reveal-score " + scoreClass(results.score)}>
                {formatScore(results.score)}
              </p>
              {/* True by construction: the score is (up - down) / (up + down + 5),
                  shown x100 (scoring.ts, formatScore), so it always lies strictly
                  between -100 and +100. */}
              <p className="t-label">Score out of &plusmn;100</p>
              <div className="reveal-split">
                <span className="tally is-up">
                  <ThumbUp />
                  {results.upvotes}
                  <span className="sr-only"> up votes</span>
                </span>
                <span className="tally is-down">
                  <ThumbDown />
                  {results.downvotes}
                  <span className="sr-only"> down votes</span>
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

          <button ref={done} className="btn is-primary" onClick={onClose}>
            Done
          </button>
    </div>
  );
}
