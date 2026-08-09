import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get, post } from "./../api";
import type { MyDj, NowPlay, NowResponse } from "./../api";
import { Artwork, Empty, Spinner, formatClock } from "./../components";
import { IconSpeaker, ThumbDown, ThumbUp } from "./../icons";
import { useNavigate } from "./../router";
import { Reveal, markRevealed, wasRevealed } from "./Reveal";

/**
 * Spec 8. Polling is still the only thing that could blow the request budget,
 * so this number is a cost decision, not a taste one. Sized 2026-08-05 against
 * **75 players × 2 hours of use a day** = 150 player-hours:
 *
 *   interval   polls/day   + overhead   % of the 100k/day free tier
 *      10s        54,000       57,920         58%
 *     7.5s        72,000       75,920         76%   <- here
 *       7s        77,143       81,063         81%
 *       6s        90,000       93,920         94%
 *
 * Overhead is ~3,900/day: the Pi's beacon (~2,040), votes, first loads and the
 * outbox. It is rounding error next to the polls.
 *
 * 7.5s leaves roughly a quarter of the tier spare for a longer session or a
 * bigger squad. Going to 6s spends 94% of it, which is not a margin — one
 * unusually long practice and the whole thing 500s.
 *
 * If the roster or session length grows, redo the arithmetic before touching
 * this. polls/day = players x hours x 3600 / interval_seconds.
 */
const POLL_MS = 7_500;

export function NowPlaying({ teamName }: { teamName: string }) {
  const navigate = useNavigate();
  const [now, setNow] = useState<NowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [myDj, setMyDj] = useState<MyDj | null>(null);
  const [revealFor, setRevealFor] = useState<NowPlay | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The play we last saw with an *open* window. The reveal fires on the
  // transition out of that, which is also why a cold open onto an
  // already-closed song correctly reveals nothing.
  const openPlay = useRef<NowPlay | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await get<NowResponse>("/api/now");
      const prev = openPlay.current;

      if (prev && (next.play?.id !== prev.id || next.play?.vote_window_open === false)) {
        openPlay.current = null;
        if (!wasRevealed(prev.id)) {
          markRevealed(prev.id);
          setRevealFor(prev);
        }
      }
      if (next.play?.vote_window_open) openPlay.current = next.play;

      setNow(next);
      setError(null);
    } catch (e) {
      // A dropped poll is not worth a visible error; the room's wifi is bad
      // and the next tick will very likely succeed.
      if (e instanceof ApiError && e.status !== 401) setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  /* Poll. Stops when the tab is backgrounded and when nothing is playing —
     both required by spec 8, and between them they are the difference between
     a few thousand requests a day and blowing the free tier before lunch. */
  useEffect(() => {
    let timer: number | undefined;

    const tick = () => {
      if (document.hidden) return;
      void load();
      timer = window.setTimeout(tick, POLL_MS);
    };

    const onVisible = () => {
      window.clearTimeout(timer);
      if (!document.hidden) tick();
    };

    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const play = now?.play ?? null;
  const iAmDj = play?.i_am_dj ?? false;

  // Only the DJ sees their own standing, and only while they are DJing.
  useEffect(() => {
    if (!iAmDj) return;
    get<MyDj>("/api/me/dj")
      .then(setMyDj)
      .catch(() => setMyDj(null));
  }, [iAmDj]);

  const vote = async (value: 1 | -1) => {
    if (!play) return;
    const previous = play.my_vote;
    // Optimistic: the control fills before the network confirms (spec 9.1).
    setNow((s) => (s?.play ? { ...s, play: { ...s.play, my_vote: value } } : s));
    try {
      await post("/api/votes", { play_id: play.id, value });
    } catch (e) {
      setNow((s) => (s?.play ? { ...s, play: { ...s.play, my_vote: previous } } : s));
      if (e instanceof ApiError && e.status === 409) {
        // The window shut between the render and the tap. Show the locked
        // state rather than an error — it is not the user's mistake.
        setNow((s) => (s?.play ? { ...s, play: { ...s.play, vote_window_open: false } } : s));
      } else if (e instanceof ApiError) {
        setError(e.message);
      }
    }
  };

  if (loading) return <Spinner />;

  return (
    <>
      {revealFor && <Reveal play={revealFor} onClose={() => setRevealFor(null)} />}

      <main className="screen np">
        <header className="np-head">
          {/* "Live" used to sit here as a word, and it was read as "music is
              playing". It never meant that: speaker_online is only whether the
              Pi has beaconed in the last three minutes — the box is powered up
              and has a network. It says nothing about a phone being connected
              or anything coming out of the speaker.

              It is an icon now, in the corner opposite the jersey. Spelling it
              out cost a whole second line of header and still pulled the eye
              to the least important thing on the screen. The full sentence
              survives in the label, which is what a screen reader announces
              and what a long-press shows. */}
          <span
            className={"np-speaker" + (now?.speaker_online ? " is-live" : "")}
            role="img"
            aria-label={`Speaker ${now?.speaker_online ? "online" : "offline"}`}
            title={`Speaker ${now?.speaker_online ? "online" : "offline"}`}
          >
            <IconSpeaker muted={!now?.speaker_online} />
          </span>
          <span className="t-label np-head-team">{teamName}</span>
          <button
            className="jersey is-sm"
            onClick={() => navigate("/join")}
            aria-label={`Signed in as ${now?.viewer?.name ?? "unknown"}. Change.`}
          >
            {now?.viewer?.jersey_number || (now?.viewer?.name?.[0] ?? "?")}
          </button>
        </header>

        {error && <div className="banner is-bad">{error}</div>}

        {!play ? (
          <NothingPlaying online={now?.speaker_online ?? false} />
        ) : (
          <>
            <Artwork
              className="np-art"
              src={play.artwork_url}
              fallback={play.artwork_fallback}
              alt={`Artwork for ${play.title}`}
            />

            <div className="np-meta">
              <h1 className="t-title">{play.title}</h1>
              <p className="t-sub">{play.artist ?? "Unknown artist"}</p>
              {play.album && <p className="np-album">{play.album}</p>}
            </div>

            <DjChip play={play} onClaim={() => navigate("/claim")} />

            <Progress play={play} />

            <VoteWindow play={play} />

            {!play.vote_window_open ? (
              <div className="vote-locked">
                <p className="t-label">Voting closed</p>
              </div>
            ) : iAmDj ? (
              <DjStanding myDj={myDj} />
            ) : (
              <div className="votes">
                <button
                  className={"vote" + (play.my_vote === -1 ? " is-on-down" : "")}
                  aria-label="Thumbs down"
                  aria-pressed={play.my_vote === -1}
                  onClick={() => vote(-1)}
                >
                  <ThumbDown />
                </button>
                <button
                  className={"vote" + (play.my_vote === 1 ? " is-on-up" : "")}
                  aria-label="Thumbs up"
                  aria-pressed={play.my_vote === 1}
                  onClick={() => vote(1)}
                >
                  <ThumbUp />
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function NothingPlaying({ online }: { online: boolean }) {
  return online ? (
    <Empty title="Nothing playing">
      Connect to <strong>AuxGoat</strong> over Bluetooth to DJ.
    </Empty>
  ) : (
    <Empty title="Speaker offline">Songs and votes resume when it reconnects.</Empty>
  );
}

/**
 * Who is playing it. When nobody has claimed the phone, this names the phone
 * instead — the play still counts and is still votable, it just has no owner
 * on the DJ leaderboard yet.
 */
function DjChip({ play, onClaim }: { play: NowPlay; onClaim: () => void }) {
  if (play.dj) {
    return (
      <span className="dj-chip">
        <span className="jersey is-sm">{play.dj.jersey_number || play.dj.name[0]}</span>
        <span className="stack">
          {/* Leads rather than trails. A bare "DJ" under a name read as a job
              title — it never said what the chip is actually telling you,
              which is whose phone this song came off. The label first makes
              the whole chip a sentence: now on aux, Jake Moreau.

              Still not "You're DJing" when it is you: the panel below the
              progress bar already says exactly that, and saying it twice reads
              as a bug rather than as emphasis. */}
          <span className="dj-chip-label">Now on aux</span>
          <span className="dj-chip-name">{play.dj.name}</span>
        </span>
      </span>
    );
  }

  if (play.device_unclaimed && play.device) {
    return (
      <span className="stack" style={{ alignItems: "center", gap: 6 }}>
        <span className="dj-chip is-unclaimed">
          <span className="jersey is-sm">?</span>
          <span className="stack">
            <span className="dj-chip-label">Now on aux</span>
            <span className="dj-chip-name">{play.device.alias ?? "Unknown phone"}</span>
            {/* The hint is what lets someone recognise their own phone in a
                room where four are connected. Worth the third line here. */}
            <span className="dj-chip-sub">Unclaimed · {play.device.mac_hint}</span>
          </span>
        </span>
        <button className="btn-quiet" onClick={onClaim}>
          Whose phone is this?
        </button>
      </span>
    );
  }

  return (
    <span className="dj-chip is-unclaimed">
      <span className="jersey is-sm">?</span>
      <span className="stack">
        <span className="dj-chip-label">Now on aux</span>
        <span className="dj-chip-name">Unknown phone</span>
      </span>
    </span>
  );
}

/**
 * Elapsed ticks locally between polls rather than being pushed by the server
 * — a value that only moves every 10 seconds looks broken.
 *
 * The bar is hidden entirely when the Pi never reported a duration. That is
 * not hypothetical: production already holds plays that opened and never
 * closed when the Pi lost its network mid-session.
 */
/** Spec 6.3. Must match VOTE_GRACE_MS in the Worker's voteWindow.ts. */
const VOTE_GRACE_MS = 30_000;

/**
 * How long is left to vote, and whether that number can be trusted.
 *
 * The obvious implementation — count down to `vote_closes_at` — produces a
 * timer that ticks down and then jumps back up. While a song is live the Pi's
 * beacon keeps rolling that timestamp forward (keepalive + 150s + 30s), which
 * is exactly what holds the window open through a pause. Rendering it raw
 * would look broken every time a beacon landed.
 *
 * So this counts down to the thing a player actually cares about: the end of
 * the song, plus the grace. That decreases smoothly and is right in the normal
 * case. Once the song really has ended the server gives a fixed `ended_at` and
 * we switch to counting down to that, which is both exact and the moment the
 * countdown matters most.
 *
 * Returns null when there is no honest number to show — paused (the window
 * stays open as long as the Pi says the song is still on the speaker, so any
 * countdown would be a lie) or no duration reported.
 */
function voteRemainingMs(play: NowPlay, elapsed: number): number | null {
  if (!play.vote_window_open) return null;
  if (play.ended_at) {
    return Math.max(0, Date.parse(play.ended_at) + VOTE_GRACE_MS - Date.now());
  }
  if (play.play_status === "paused") return null;
  if (play.duration_ms == null) return null;
  return Math.max(0, play.duration_ms - elapsed + VOTE_GRACE_MS);
}

/**
 * Playback position, ticking locally between polls.
 *
 * Shared by the progress bar and the voting countdown deliberately — they are
 * two readings of the same clock, and computing it twice is how they end up
 * disagreeing on screen by a second.
 */
function useElapsed(play: NowPlay): number {
  const paused = play.play_status === "paused";
  // A finished play is as still as a paused one. Without this the bar kept
  // running for the whole 30s grace after the song ended: a play that closed
  // at 1:00 was reading 1:30 under an "Ended" label, which is not a rounding
  // error, it is the screen contradicting itself. played_ms is final once the
  // Pi has closed the play, so the anchor is exact rather than extrapolated.
  const ended = !!play.ended_at;
  const frozen = paused || ended;

  // Anchor on the Pi's played_ms when we have it: it counts playback time and
  // excludes pauses, where wall-clock-since-started_at does not. Pausing a
  // song used to make this bar run on past the end of the track.
  // played_ms was measured on the Pi at its last beacon, not at this instant,
  // so it arrives already stale — which showed up as the bar sitting a steady
  // few seconds behind the phone. Add that age back, but only while playing:
  // a stopped track's position is not advancing, so adding it would overshoot.
  const anchor = () =>
    play.played_ms != null
      ? play.played_ms + (frozen ? 0 : (play.played_ms_age_ms ?? 0))
      : Date.now() - Date.parse(play.started_at);

  const [elapsed, setElapsed] = useState(anchor);

  useEffect(() => {
    setElapsed(anchor());
    // Frozen while paused or ended - the music is not moving, so neither is this.
    if (frozen || !play.vote_window_open) return;
    // Tick forward from the anchor rather than recomputing from started_at,
    // so time accumulated during a pause is never counted.
    const startedTicking = Date.now();
    const base = anchor();
    const id = window.setInterval(
      () => setElapsed(base + (Date.now() - startedTicking)),
      1000,
    );
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // played_ms_age_ms is included deliberately: it changes on every poll, so
    // the bar re-anchors to the Pi's reading each time instead of drifting on
    // the client's own clock for the life of the song.
  }, [
    play.started_at,
    play.vote_window_open,
    frozen,
    play.played_ms,
    play.played_ms_age_ms,
  ]);

  return elapsed;
}

/**
 * Playing/paused, and how long is left to vote.
 *
 * Deliberately never a tally or a hint of one — spec non-negotiable #2. This
 * says how long the door is open, never what is behind it.
 */
function VoteWindow({ play }: { play: NowPlay }) {
  const elapsed = useElapsed(play);
  // A closed play keeps whatever play_status it last had, so a finished song
  // still claims to be "playing". Found by testing the last-30-seconds state:
  // it read "PLAYING · VOTING CLOSES IN 0:01", which is two contradictory
  // things at once. ended_at is the authority once it exists.
  const ended = !!play.ended_at;
  const paused = !ended && play.play_status === "paused";
  const remaining = voteRemainingMs(play, elapsed);

  // Nothing here once the window shuts: the panel below already says "Voting
  // closed" where the thumbs were, and saying it twice on one screen reads as
  // a bug. A finished song has no meaningful playing/paused state either.
  if (!play.vote_window_open) return null;

  return (
    <div className={"vote-window" + (paused ? " is-paused" : "")}>
      <span className="vw-state">
        <span
          className={
            "vw-icon" + (ended ? " is-ended" : paused ? " is-paused" : "")
          }
          aria-hidden="true"
        />
        <span className="t-label">
          {ended ? "Ended" : paused ? "Paused" : "Playing"}
        </span>
      </span>

      <span className="vw-sep" aria-hidden="true" />

      {/* Under a minute is the part people act on, so it gets the urgent
          treatment. Above that a ticking clock is just noise. */}
      {remaining == null ? (
        <span className="t-label vw-time">
          {paused ? "Voting stays open" : "Voting open"}
        </span>
      ) : (
        <span className={"vw-time" + (remaining <= 30_000 ? " is-soon" : "")}>
          {/* No literal space between these — .vw-time is a flex row and its
              gap does the spacing. Both would apply. */}
          <span className="t-label">Voting closes in</span>
          <span className="num vw-clock">{formatClock(remaining)}</span>
        </span>
      )}
    </div>
  );
}

function Progress({ play }: { play: NowPlay }) {
  const elapsed = useElapsed(play);
  const duration = play.duration_ms ?? null;
  const shown = duration ? Math.min(elapsed, duration) : elapsed;

  if (!duration) {
    return (
      <div className="np-progress">
        <span className="np-time">{formatClock(shown)}</span>
        <span className="np-bar" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="np-progress">
      <span className="np-time">{formatClock(shown)}</span>
      <span
        className="np-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(shown / 1000)}
      >
        <span className="np-bar-fill" style={{ width: `${(shown / duration) * 100}%` }} />
      </span>
      <span className="np-time">{formatClock(duration)}</span>
    </div>
  );
}

/**
 * What the DJ sees in place of the vote controls. Their standing is private
 * by design (spec 7.2), and this is the one screen where it is relevant.
 */
function DjStanding({ myDj }: { myDj: MyDj | null }) {
  return (
    <div className="vote-locked center">
      <p className="empty-title">You're DJing this one</p>
      <p className="t-sub">
        {!myDj
          ? "You can't rate your own song."
          : myDj.qualified
            ? `${myDj.counted_plays} counted plays — you're on the DJ board.`
            : `${myDj.plays_until_qualified} more ${
                myDj.plays_until_qualified === 1 ? "song" : "songs"
              } to qualify for the DJ board.`}
      </p>
    </div>
  );
}
