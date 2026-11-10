import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, get, isNetworkError, post } from "./../api";
import type { AuxState, MyDj, NowPlay, NowResponse, Results } from "./../api";
import {
  Artwork,
  Banner,
  Empty,
  Spinner,
  formatClock,
  formatWhen,
  useEscape,
} from "./../components";
import { IconCheck, IconSettings, IconSpeaker, ThumbDown, ThumbUp } from "./../icons";
import { clearFlash, peekFlash, useNavigate } from "./../router";
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

/**
 * Backoff for when there is nothing to vote on. The table above assumes a song
 * is playing for the whole two hours, and most of a practice is not that:
 * between songs nothing can change faster than someone pressing play, and with
 * the speaker offline nothing can change at all until the box comes back.
 * These are what keep 75 players inside the free plan; do not shorten them.
 */
const IDLE_POLL_MS = 20_000;
const OFFLINE_POLL_MS = 60_000;

function pollDelay(now: NowResponse | null): number {
  if (!now || now.play) return POLL_MS;
  return now.speaker_online ? IDLE_POLL_MS : OFFLINE_POLL_MS;
}

/**
 * How long to keep asking for a finished song's results. With back-to-back
 * songs the next one starts inside the previous one's 30s grace, so the first
 * ask is normally refused with a `closes_at`; past four minutes the moment has
 * gone and a verdict would land on a song nobody remembers.
 */
const REVEAL_GIVE_UP_MS = 4 * 60_000;
/** Retry delay when the results request failed for a reason other than "not yet". */
const REVEAL_RETRY_MS = 5_000;

/** Consecutive failed polls before the screen admits it has lost the server. */
const RECONNECT_AFTER = 2;

const VOTE_FAILED = "Your vote didn\u2019t go through - tap again.";

export function NowPlaying({ teamName }: { teamName: string }) {
  const navigate = useNavigate();
  const [now, setNow] = useState<NowResponse | null>(null);
  const [failures, setFailures] = useState(0);
  const [myDj, setMyDj] = useState<MyDj | null>(null);
  const [reveal, setReveal] = useState<{ play: NowPlay; results: Results } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voteFailed, setVoteFailed] = useState(false);
  const [speakerOpen, setSpeakerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Read out by the polite live region: the song changing, a vote landing.
  const [announce, setAnnounce] = useState("");
  const speakerBtn = useRef<HTMLButtonElement>(null);
  const gearBtn = useRef<HTMLButtonElement>(null);
  const lastPlayId = useRef<string | null | undefined>(undefined);
  // A confirmation carried over from the previous screen (a claim).
  const [flash, setFlashShown] = useState(peekFlash);
  useEffect(() => {
    clearFlash();
    if (!flash) return;
    const id = window.setTimeout(() => setFlashShown(null), 6_000);
    return () => window.clearTimeout(id);
  }, [flash]);

  // The play we last saw with an *open* window. The reveal fires on the
  // transition out of that, which is also why a cold open onto an
  // already-closed song correctly reveals nothing.
  const openPlay = useRef<NowPlay | null>(null);
  // The latest applied /api/now, for the poll loop's backoff decision.
  const nowRef = useRef<NowResponse | null>(null);
  const alive = useRef(true);

  // Polls can overlap (a visibility change, a slow response) and resolve out
  // of order on bad wifi. Each request takes a number; a response older than
  // the newest one already applied is dropped.
  const issued = useRef(0);
  const applied = useRef(0);

  // While a vote is in flight - and for any poll that was already on the wire
  // when it landed - the server's my_vote is older than the tap. This keeps
  // the local choice on screen instead of flicking back.
  const voteGuard = useRef<{ playId: string; value: 1 | -1; throughSeq: number } | null>(null);
  const voting = useRef(false);
  const queuedVote = useRef<{ playId: string; value: 1 | -1 } | null>(null);
  const revertTo = useRef<1 | -1 | null>(null);

  // The one play whose results we are waiting for. Replacing it is how a
  // stale reveal is cancelled: only the song that just ended may reveal.
  const revealTarget = useRef<string | null>(null);
  const revealTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      revealTarget.current = null;
      window.clearTimeout(revealTimer.current);
    };
  }, []);

  /**
   * Fetch a finished play's results, waiting out its vote window if the next
   * song started before it closed. Marked revealed only once the results are
   * actually in hand - marking it up front is why back-to-back songs never
   * revealed at all.
   */
  const requestReveal = useCallback((target: NowPlay, firstWait: number) => {
    window.clearTimeout(revealTimer.current);
    revealTarget.current = target.id;
    const giveUpAt = Date.now() + REVEAL_GIVE_UP_MS;
    let refusals = 0;

    const attempt = async () => {
      if (!alive.current || revealTarget.current !== target.id) return;
      try {
        const results = await get<Results>(`/api/plays/${target.id}/results`);
        if (!alive.current || revealTarget.current !== target.id) return;
        revealTarget.current = null;
        markRevealed(target.id);
        setReveal({ play: target, results });
      } catch (e) {
        if (!alive.current || revealTarget.current !== target.id) return;
        let wait: number | null = null;
        const closesAt = e instanceof ApiError ? e.body?.closes_at : undefined;
        if (e instanceof ApiError && e.status === 403 && typeof closesAt === "string") {
          // A second past the close, but never a tight loop: a phone whose
          // clock runs behind the server's would otherwise ask every second.
          refusals += 1;
          const floor = Math.min(30_000, 1_000 * 2 ** refusals);
          wait = Math.max(floor, Date.parse(closesAt) + 1_000 - Date.now());
        } else if (isNetworkError(e) || (e instanceof ApiError && e.status >= 500)) {
          wait = REVEAL_RETRY_MS;
        }
        if (wait == null || Number.isNaN(wait) || Date.now() + wait > giveUpAt) {
          revealTarget.current = null;
          return;
        }
        revealTimer.current = window.setTimeout(attempt, wait);
      }
    };
    if (firstWait > 0) revealTimer.current = window.setTimeout(attempt, firstWait);
    else void attempt();
  }, []);

  const load = useCallback(async () => {
    const seq = ++issued.current;
    try {
      let next = await get<NowResponse>("/api/now");
      if (!alive.current || seq < applied.current) return;
      applied.current = seq;

      const guard = voteGuard.current;
      if (guard && next.play?.id === guard.playId && seq <= guard.throughSeq) {
        next = { ...next, play: { ...next.play, my_vote: guard.value } };
      }

      const prev = openPlay.current;
      if (prev && (next.play?.id !== prev.id || next.play?.vote_window_open === false)) {
        openPlay.current = null;
        if (!wasRevealed(prev.id)) {
          // When the next song is already on, the previous one ended about
          // when it started, and its window stays open for the grace after
          // that. Asking before then is a guaranteed 403, so wait it out;
          // the retry above still covers a clock that disagrees.
          const opensAt = next.play && next.play.id !== prev.id
            ? Date.parse(next.play.started_at) + VOTE_GRACE_MS + 1_000
            : 0;
          const wait = Math.min(VOTE_GRACE_MS + 5_000, Math.max(0, opensAt - Date.now()));
          requestReveal(prev, Number.isNaN(wait) ? 0 : wait);
        }
      }
      if (next.play?.vote_window_open) openPlay.current = next.play;

      // Not on the first load: the h1 already says it, and a cold open
      // should not talk over the page being read.
      const id = next.play?.id ?? null;
      if (lastPlayId.current !== undefined && id && id !== lastPlayId.current && next.play) {
        setAnnounce(`Now playing ${next.play.title} by ${next.play.artist ?? "an unknown artist"}`);
      }
      lastPlayId.current = id;

      nowRef.current = next;
      setNow(next);
      setFailures(0);
      setError(null);
      setVoteFailed(false);
    } catch (e) {
      // A 401 is App's to handle: it returns to Join. Anything else is a
      // dropped poll, counted so a run of them can say "Reconnecting".
      if (!alive.current || (e instanceof ApiError && e.status === 401)) return;
      setFailures((f) => f + 1);
    }
  }, [requestReveal]);

  /* Poll. Stops when the tab is backgrounded and backs off when there is
     nothing to vote on — both required by spec 8, and between them they are
     the difference between a few thousand requests a day and blowing the free
     tier before lunch. The next tick is chained off the settled request, never
     scheduled alongside it, so a slow network cannot stack polls up. */
  useEffect(() => {
    let timer: number | undefined;
    let inFlight = false;
    let stopped = false;

    const tick = async () => {
      window.clearTimeout(timer);
      if (stopped || inFlight || document.hidden) return;
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
        if (!stopped && !document.hidden) {
          timer = window.setTimeout(tick, pollDelay(nowRef.current));
        }
      }
    };

    // Back in the foreground: poll at once rather than waiting out a timer
    // that may have been 60s long.
    const onVisible = () => {
      if (document.hidden) window.clearTimeout(timer);
      else void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
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

  const setMyVote = (playId: string, value: 1 | -1 | null) =>
    setNow((s) => (s?.play?.id === playId ? { ...s, play: { ...s.play, my_vote: value } } : s));

  /**
   * Sends votes one at a time. Taps while one is in flight replace whatever is
   * queued, so a nervous double-switch sends only the final choice - and the
   * server never sees two POSTs racing each other to be the last word.
   */
  const flushVotes = async () => {
    voting.current = true;
    while (queuedVote.current) {
      const { playId, value } = queuedVote.current;
      queuedVote.current = null;
      try {
        await post("/api/votes", { play_id: playId, value });
        revertTo.current = value;
        // A tap that went back to this same choice while it was in flight
        // has nothing left to say.
        const q = queuedVote.current as { playId: string; value: 1 | -1 } | null;
        if (q && q.playId === playId && q.value === value) queuedVote.current = null;
        if (!queuedVote.current && alive.current) {
          voteGuard.current = { playId, value, throughSeq: issued.current };
          setAnnounce(`Vote counted: ${value === 1 ? "Fire" : "Nah"}`);
          setVoteFailed(false);
          setError(null);
        }
      } catch (e) {
        if (queuedVote.current || !alive.current) continue; // a newer tap supersedes this one
        voteGuard.current = null;
        setMyVote(playId, revertTo.current);
        if (e instanceof ApiError && e.status === 409) {
          // The window shut between the render and the tap. Show the locked
          // state rather than an error — it is not the user's mistake.
          setNow((s) =>
            s?.play?.id === playId ? { ...s, play: { ...s.play, vote_window_open: false } } : s,
          );
        } else if (e instanceof ApiError && e.status === 401) {
          // App is already on its way back to Join.
        } else if (isNetworkError(e) || (e instanceof ApiError && e.status >= 500)) {
          setVoteFailed(true);
        } else {
          setError(errorMessage(e, VOTE_FAILED));
        }
      }
    }
    voting.current = false;
  };

  const vote = (value: 1 | -1) => {
    if (!play) return;
    if (!voting.current) revertTo.current = play.my_vote;
    // Optimistic: the control fills before the network confirms (spec 9.1).
    setMyVote(play.id, value);
    setVoteFailed(false);
    voteGuard.current = { playId: play.id, value, throughSeq: Infinity };
    queuedVote.current = { playId: play.id, value };
    if (!voting.current) void flushVotes();
  };

  if (!now) {
    return failures >= RECONNECT_AFTER ? (
      <main className="screen np">
        <Empty title={"Reconnecting\u2026"} heading>
          Lost the connection to AuxGoat. This screen picks up again on its own.
        </Empty>
      </main>
    ) : (
      <Spinner />
    );
  }

  return (
    <>
      {reveal && (
        <Reveal play={reveal.play} results={reveal.results} onClose={() => setReveal(null)} />
      )}

      <main className="screen np">
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
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
          <span className="np-speaker-wrap">
            <button
              ref={speakerBtn}
              className={"np-speaker" + (now?.speaker_online ? " is-live" : "")}
              aria-label={`Speaker ${now?.speaker_online ? "online" : "offline"}. Details.`}
              aria-expanded={speakerOpen}
              onClick={() => setSpeakerOpen((v) => !v)}
            >
              <IconSpeaker muted={!now?.speaker_online} />
            </button>
            {speakerOpen && (
              <SpeakerPopover
                online={now?.speaker_online ?? false}
                lastSeen={now?.speaker_last_seen ?? null}
                aux={now?.aux ?? null}
                onClose={() => {
                  setSpeakerOpen(false);
                  speakerBtn.current?.focus();
                }}
              />
            )}
          </span>
          <span className="t-label t-chrome np-head-team">{teamName}</span>
          {/* A gear, not the jersey number. The number was doing two jobs and
              neither well: it read as a score, and nothing about it said
              "settings". Identity moved into the Profile screen. */}
          <span className="np-gear-wrap">
            <button
              ref={gearBtn}
              className="np-gear"
              aria-label={`Settings. Signed in as ${now?.viewer?.name ?? "unknown"}.`}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <IconSettings />
            </button>
            {menuOpen && (
              <SettingsMenu
                onClose={() => {
                  setMenuOpen(false);
                  gearBtn.current?.focus();
                }}
              />
            )}
          </span>
        </header>

        {failures >= RECONNECT_AFTER && (
          <p className="t-label np-reconnecting" role="status">
            Reconnecting&hellip;
          </p>
        )}
        {flash && <Banner kind="ok">{flash}</Banner>}
        {error && <Banner kind="bad">{error}</Banner>}
        {voteFailed && <Banner kind="bad">{VOTE_FAILED}</Banner>}
        <WaitingBanner aux={now?.aux ?? null} />

        {!play ? (
          <NothingPlaying online={now?.speaker_online ?? false} aux={now?.aux ?? null} />
        ) : (
          /* .np-stage and .np-side are layout-transparent on a phone
             (display: contents) and become the two columns on a wide,
             tall screen. */
          <div className="np-stage">
            {/* The artwork is the ONLY thing on this screen that gives. See
                .np-artwrap — everything else has a job that does not
                compress, so the art takes what is left and no more. */}
            <div className="np-artwrap">
              <Artwork
                className="np-art"
                src={play.artwork_url}
                fallback={play.artwork_fallback}
                alt=""
              />
            </div>

            <div className="np-side">
            <div className="np-meta">
              <span className="np-eyebrow">
                <span className="t-chrome np-eyebrow-label">Now playing</span>
                <span className="np-eyebrow-rule" aria-hidden="true" />
              </span>
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
              /* Each thumb is a button plus a caption, and the selected one
                 also gets a check badge. Three signals, only one of which is
                 colour — the old version said "you voted" by turning green or
                 red and nothing else, which is the exact pairing that is
                 hardest to tell apart. See .vote.is-on-up in styles.css. */
              <div className="votes">
                <span className="vote-pick">
                  <button
                    className={"vote" + (play.my_vote === -1 ? " is-on-down" : "")}
                    aria-label="Thumbs down"
                    aria-pressed={play.my_vote === -1}
                    onClick={() => vote(-1)}
                  >
                    <ThumbDown />
                    {play.my_vote === -1 && (
                      <span className="vote-check">
                        <IconCheck />
                      </span>
                    )}
                  </button>
                  <span
                    className={
                      "t-chrome vote-cap" + (play.my_vote === -1 ? " is-mine" : "")
                    }
                  >
                    {play.my_vote === -1 ? "Your vote" : "Nah"}
                  </span>
                </span>

                <span className="vote-pick">
                  <button
                    className={"vote" + (play.my_vote === 1 ? " is-on-up" : "")}
                    aria-label="Thumbs up"
                    aria-pressed={play.my_vote === 1}
                    onClick={() => vote(1)}
                  >
                    <ThumbUp />
                    {play.my_vote === 1 && (
                      <span className="vote-check">
                        <IconCheck />
                      </span>
                    )}
                  </button>
                  <span
                    className={
                      "t-chrome vote-cap" + (play.my_vote === 1 ? " is-mine" : "")
                    }
                  >
                    {play.my_vote === 1 ? "Your vote" : "Fire"}
                  </span>
                </span>
                {play.my_vote == null && (
                  <p className="vote-hint">Votes stay secret until the song ends</p>
                )}
              </div>
            )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}

/**
 * The screen a blocked player is looking at.
 *
 * "Connect to AuxGoat over Bluetooth to DJ" was true when anyone could, and
 * became a lie the moment one phone at a time was enforced — it told the one
 * person who could NOT get audio to go and do the thing that would not work.
 * So it asks who has the speaker before saying anything.
 */
function NothingPlaying({ online, aux }: { online: boolean; aux: AuxState | null }) {
  if (!online) {
    return <Empty title="Speaker offline" heading>Songs and votes resume when it reconnects.</Empty>;
  }

  const holder = aux?.holder;
  if (holder && !holder.is_you) {
    // Anyone connected and waiting already has all of this from WaitingBanner,
    // countdown included, a few pixels further up. Repeating it here would put
    // two different sentences about one fact on the same screen — and the
    // "you can connect too" half is actively wrong for someone who already is.
    if (aux?.you_are_waiting) {
      return <Empty title="Nothing playing" heading>Nobody has pressed play yet.</Empty>;
    }
    // Roster name when the phone is claimed, Bluetooth name when it is not —
    // an unclaimed phone has nothing else, and naming it still beats silence.
    const who = holder.name ?? holder.alias ?? "Someone else";
    return (
      <Empty title="Someone else has the aux" heading>
        {who} is connected. You can connect too — you&rsquo;ll be able to play once
        they&rsquo;re done.
      </Empty>
    );
  }

  if (holder?.is_you) {
    return <Empty title="You have the aux" heading>Press play on your phone.</Empty>;
  }

  return (
    /* /api/now does not report the speaker's Bluetooth name, so this names
       the one the box is set up with. */
    <Empty title="Nothing playing" heading>
      Want to DJ? Open Bluetooth on your phone, connect to the speaker called{" "}
      <strong>AuxGoat</strong>, then press play. Everyone here votes on each song.
    </Empty>
  );
}

/**
 * The countdown to the aux coming free, ticking locally between polls.
 *
 * Polls are 7.5s apart and the grace is 20s, so a number that only moved on a
 * poll would spend most of its life frozen and then jump. Same shape as
 * useElapsed: anchor on the server's reading, tick from there, and re-anchor
 * on every poll rather than trusting the browser's clock for the whole window.
 *
 * Returns null whenever there is no honest number — which is most of the time,
 * because a holder who is actually playing music has no deadline at all.
 */
function useAuxCountdown(freeInMs: number | null): number | null {
  const [left, setLeft] = useState(freeInMs);

  useEffect(() => {
    setLeft(freeInMs);
    // Nothing to count: either a song is open (null) or it already hit zero.
    if (freeInMs == null || freeInMs <= 0) return;
    const startedTicking = Date.now();
    const id = window.setInterval(
      () => setLeft(Math.max(0, freeInMs - (Date.now() - startedTicking))),
      1000,
    );
    return () => window.clearInterval(id);
    // freeInMs changes on every poll, so this re-anchors to the Pi's reading
    // each time instead of drifting.
  }, [freeInMs]);

  return left;
}

/**
 * The only thing that tells a specific person the silence is about them.
 *
 * Shown while a song IS playing, because that is exactly when someone is
 * waiting — and it reuses the banner slot under the header rather than adding
 * a permanent line naming the holder, which would just repeat the DJ chip.
 *
 * Three states, driven by holder.free_in_ms. The one rule they exist to obey:
 * the number NEVER rewinds on screen. The grace restarts on every skip, scrub
 * and play, so when the holder starts another song the Pi sends null and the
 * countdown DISAPPEARS rather than snapping back to 20s. Same rule
 * voteRemainingMs follows above, for the same reason.
 */
function WaitingBanner({ aux }: { aux: AuxState | null }) {
  // Hooks run before the early return: React requires an unconditional call,
  // and this one is cheap and idle when there is nothing to count.
  const left = useAuxCountdown(aux?.holder?.free_in_ms ?? null);
  if (!aux?.you_are_waiting) return null;

  const who = aux.holder?.name ?? aux.holder?.alias ?? "someone else";

  // The grace has lapsed and nobody is entitled to the speaker any more. The
  // Pi hands it to whoever presses play next, so say that rather than keep
  // naming a holder who no longer holds anything — which is what this screen
  // did for the whole length of the grace before free_in_ms existed.
  if (left === 0) {
    return (
      <Banner kind="info">
        The aux is free — press play and it&rsquo;s yours.
      </Banner>
    );
  }

  // Their song is over and the clock is running.
  if (left != null) {
    return (
      <Banner kind="info">
        {who} has the aux — yours in {Math.ceil(left / 1000)}s.
      </Banner>
    );
  }

  // A song is open. No deadline exists, so promise nothing but the rule.
  return (
    <Banner kind="info">
      You&rsquo;re connected, but {who} has the aux. Press play once
      they&rsquo;re done and it&rsquo;s yours.
    </Banner>
  );
}

/**
 * The gear's menu. Three destinations, each its own screen.
 *
 * A menu rather than a straight jump to a settings page: you almost always
 * arrive here knowing which of the three you came for, and a page that is
 * three things at once makes you read all of them first. Anchored to the right
 * rail because that is the icon it belongs to.
 */
function SettingsMenu({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  useEscape(onClose);
  const items: [string, string, string][] = [
    ["/settings/profile", "Profile", "Your name and number"],
    ["/settings/speaker", "Speaker & connection", "What the box plays through"],
    ["/settings/account", "Account", "Claim a phone, sign out"],
  ];
  return (
    <>
      <button className="pop-scrim" aria-label="Close" onClick={onClose} />
      {/* A labelled group of buttons, not role="menu": a menu promises
          arrow-key navigation, and this has none. */}
      <div className="pop is-right" role="group" aria-label="Settings">
        {items.map(([to, label, sub]) => (
          <button key={to} className="pop-item" onClick={() => go(to)}>
            <span>
              {label}
              <span className="pop-item-sub">{sub}</span>
            </span>
            <span className="pop-item-mark" aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * What the speaker icon actually means, on tap.
 *
 * The icon used to be a `role="img"` with a `title`, and a title attribute
 * does nothing at all on a phone — so the one place the meaning was written
 * down was unreachable on the only device this product runs on. It is a real
 * button now.
 *
 * WHY IT SAYS WHEN AND NOT JUST WHETHER: `speaker_online` is only "the Pi has
 * beaconed in the last three minutes". It says nothing about a phone being
 * connected or about anything coming out of the speaker, and that distinction
 * has misled people on this project before — "Live" was removed from this
 * header for exactly that reason. Two minutes stale is a blip; two hours is a
 * box to go and look at, and "Offline" alone cannot tell you which.
 */
function SpeakerPopover({
  online,
  lastSeen,
  aux,
  onClose,
}: {
  online: boolean;
  lastSeen: string | null;
  aux: AuxState | null;
  onClose: () => void;
}) {
  const holder = aux?.holder ?? null;
  useEscape(onClose);
  return (
    <>
      {/* Catches the next tap anywhere. A popover you cannot dismiss by
          tapping away is a popover people get stuck in. */}
      <button className="pop-scrim" aria-label="Close" onClick={onClose} />
      <div className="pop" role="dialog" aria-label="Speaker status">
        <span className="pop-row">
          <span className={"pop-dot" + (online ? " is-live" : "")} aria-hidden="true" />
          <span className="t-chrome pop-state">{online ? "AuxGoat online" : "AuxGoat offline"}</span>
        </span>
        <p className="pop-line">
          {online
            ? "The box is powered up and on the network."
            : "No check-in for over three minutes. It may be unplugged, or off the wifi."}
        </p>
        <p className="pop-line pop-meta">
          {lastSeen ? `Last check-in ${formatWhen(lastSeen)}` : "It has never checked in."}
        </p>
        <span className="pop-rule" aria-hidden="true" />
        <p className="pop-line">
          {holder
            ? holder.is_you
              ? "Your phone has the aux."
              : `${holder.name ?? holder.alias ?? "Someone"} has the aux.`
            : "Nobody is connected over Bluetooth."}
        </p>
        <p className="pop-line pop-meta">
          Online only means the box is reachable — not that a phone is
          connected, and not that sound is coming out.
        </p>
      </div>
    </>
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
        <span className="jersey is-sm" aria-hidden="true">{play.dj.jersey_number || play.dj.name[0]}</span>
        <span className="stack">
          {/* Leads rather than trails. A bare "DJ" under a name read as a job
              title — it never said what the chip is actually telling you,
              which is whose phone this song came off. The label first makes
              the whole chip a sentence: now on aux, Jake Moreau.

              Still not "You're DJing" when it is you: the panel below the
              progress bar already says exactly that, and saying it twice reads
              as a bug rather than as emphasis. */}
          <span className="t-chrome dj-chip-label">Now on aux</span>
          <span className="dj-chip-name">{play.dj.name}</span>
        </span>
      </span>
    );
  }

  if (play.device_unclaimed && play.device) {
    // The same full-width, left-aligned row as a claimed DJ, with the claim
    // action at its end rather than a centred stub and a button underneath -
    // which also hands the artwork back a whole row.
    return (
      <span className="dj-chip is-unclaimed">
        <span className="jersey is-sm" aria-hidden="true">?</span>
        <span className="stack dj-chip-who">
          <span className="t-chrome dj-chip-label">Now on aux</span>
          <span className="dj-chip-name">{play.device.alias ?? "Unknown phone"}</span>
          {/* The hint is what lets someone recognise their own phone in a
              room where four are connected. Worth the third line here. */}
          <span className="dj-chip-sub">Unclaimed · {play.device.mac_hint}</span>
        </span>
        <button className="btn-quiet dj-chip-action" onClick={onClaim}>
          Whose phone is this?
        </button>
      </span>
    );
  }

  return (
    <span className="dj-chip is-unclaimed">
      <span className="jersey is-sm" aria-hidden="true">?</span>
      <span className="stack">
        <span className="t-chrome dj-chip-label">Now on aux</span>
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
        aria-label="Song progress"
        aria-valuetext={`${formatClock(shown)} of ${formatClock(duration)}`}
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
