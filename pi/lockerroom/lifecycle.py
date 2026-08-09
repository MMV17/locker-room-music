from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from .aux import AuxRouter  # noqa: F401  (re-exported for main.py)
from .storage import Store

log = logging.getLogger("lockerroom.lifecycle")

DEBOUNCE_WINDOW = timedelta(seconds=10)
# Position at or below this counts as "back at the start" for replay detection.
RESTART_POSITION_MS = 3_000
# A play shorter than this is a metadata artifact, not a human skip, and is
# never written. Kept well under the 30s skip threshold so real skips survive.
MIN_PLAY_GRACE = timedelta(seconds=2)
SKIP_THRESHOLD_MS = 30_000
PAUSE_GRACE = timedelta(seconds=60)
DURATION_BUFFER = timedelta(seconds=5)
# How long to wait after the A2DP transport goes idle before believing it
# means "stopped". BlueZ delivers the transport's State and the player's
# Status as two independent signals with no ordering guarantee, so on a pause
# the idle can land first. Closing on it immediately ended a play at the exact
# instant it was paused - see on_transport_state_changed.
TRANSPORT_IDLE_GRACE = timedelta(seconds=5)
# How long a phone keeps the aux after the music stops.
#
# A2DP is not exclusive. Two phones can be connected and streaming at the same
# time and the speaker mixes them, so "one song at a time" has to be enforced
# rather than assumed. It is enforced by routing (see aux.py), NOT by refusing
# the connection: a newcomer connects normally and simply is not audible until
# it is their turn.
#
# The hold lasts as long as there is an open play, which already covers a
# track change (the old play closes and the new one opens inside one locked
# handler) and a pause (PAUSE_GRACE keeps the play open for 60s). This grace
# covers the remaining gap: a phone that stops playback for a few seconds
# between songs, which is precisely the moment a waiting phone would take the
# aux out from under it.
#
# It is deliberately short. Every second here is a second the next DJ waits
# after the previous one is genuinely done, and a phone left connected in
# somebody's pocket must not hold the room hostage - past this, whoever
# presses play next gets it.
AUX_GRACE = timedelta(seconds=45)
# A hung D-Bus call must not hold the session lock, and therefore every
# lifecycle event, indefinitely.
PAUSE_COMMAND_TIMEOUT_S = 5.0
# How long to leave a waiting phone alone after pausing it.
#
# iOS resumes on its own after an external AVRCP pause, so pausing every time
# it does is a fight neither side wins. Measured on hardware 2026-08-09: a
# waiting iPhone took 12 pauses in 41 seconds, which on the phone reads as
# music stuttering on and off rather than as "you are not on the aux".
#
# Backing off is safe because the pause was never the enforcement - the audio
# is going nowhere regardless (see aux.py). All that is lost is that their
# playlist advances in ten-second bites instead of being held still.
PAUSE_COOLDOWN = timedelta(seconds=10)

_PUNCT_RE = re.compile(r"[^\w\s]")
_WS_RE = re.compile(r"\s+")


def normalize(s: Any) -> str:
    # Deliberately tolerant: AVRCP metadata is whatever the phone chose to
    # send, and a surprising type must never take down an in-flight play.
    if not s:
        return ""
    if not isinstance(s, str):
        s = str(s)
    s = _PUNCT_RE.sub("", s.lower())
    return _WS_RE.sub(" ", s).strip()


def track_key(title: Any, artist: Any) -> str:
    return f"{normalize(artist)}|{normalize(title)}"


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Play:
    id: str
    title: str
    artist: str
    album: str
    duration_ms: int | None
    started_at: datetime
    incomplete: bool
    status: str = "playing"  # playing | paused
    accumulated_played_ms: int = 0
    playing_since: datetime | None = None
    paused_at: datetime | None = None
    last_track_event_at: datetime = field(default_factory=now)
    duration_timer: asyncio.Task | None = None
    pause_timer: asyncio.Task | None = None
    create_timer: asyncio.Task | None = None
    transport_timer: asyncio.Task | None = None
    create_payload: dict[str, Any] | None = None
    created: bool = False
    closed: bool = False

    def __post_init__(self):
        if self.status == "playing":
            self.playing_since = self.started_at

    @property
    def key(self) -> str:
        return track_key(self.title, self.artist)

    def played_ms_at(self, at: datetime) -> int:
        extra = 0
        if self.playing_since is not None:
            extra = int((at - self.playing_since).total_seconds() * 1000)
        return self.accumulated_played_ms + max(extra, 0)


@dataclass
class Session:
    device_path: str
    mac: str
    alias: str
    connected_at: datetime
    # Last moment this phone did anything with the aux: connected, opened a
    # play, paused, resumed, or ended one. AUX_GRACE is measured from here.
    last_active_at: datetime = field(default_factory=now)
    current_play: Play | None = None
    # Last track seen on this session, so playback resuming after a stop can
    # be recorded without waiting for the phone to re-send metadata (it will
    # not, if the track has not changed).
    last_track: dict[str, Any] | None = None
    # When this phone was last paused for playing without the aux. See
    # PAUSE_COOLDOWN — None means "free to pause".
    last_paused_at: datetime | None = None


class NullAux:
    """Routes nothing anywhere.

    The default, so constructing a SessionManager can never reach out and
    restart a system service as a side effect. main.py passes the real
    AuxRouter deliberately; every test that does not care about routing gets
    this and stays on the plain lifecycle behaviour.
    """

    async def route(self, mac: str | None) -> None:
        return None


class SessionManager:
    def __init__(self, store: Store, aux: Any | None = None):
        self._store = store
        self._aux = aux if aux is not None else NullAux()
        self._sessions: dict[str, Session] = {}
        # device_path of the phone the speaker is routed to. Whoever this is
        # gets audio, and is the only session whose songs become plays.
        self._aux_path: str | None = None
        # BluezWatcher fires every D-Bus PropertiesChanged into its own task,
        # so nothing serialises these handlers. They are not safe to interleave:
        # on_track_changed reads session.current_play, awaits, and only then
        # writes it back, so two Track signals in the same tick both pass the
        # "is this the same track?" check and both open a play. The loser is
        # orphaned - never closed, never keepalived - and because it carries the
        # later started_at it is the row /api/now picks. That is exactly what
        # production shows: four duplicate pairs on 2026-08-05, opened 15ms
        # apart, each leaving a row that can never close.
        #
        # Every entry point below takes this lock and delegates to a `_`-prefixed
        # internal that assumes it is held. Internals must call each other, never
        # the public method, or they deadlock.
        self._lock = asyncio.Lock()
        # Set by main.py to BluezWatcher.pause. Optional so the whole lifecycle
        # stays testable without a D-Bus bus; see _pause_politely.
        self._pause: Callable[[str], Awaitable[None]] | None = None

    def set_pause(self, pause: Callable[[str], Awaitable[None]]) -> None:
        """Give the manager a way to pause a phone that is not on the aux.

        Injected rather than imported because BluezWatcher takes this object in
        its constructor - wiring it the other way round is a cycle - and
        because it keeps every test in test_lifecycle.py free of D-Bus.
        """
        self._pause = pause

    def open_play_state(self, at: datetime | None = None) -> dict[str, Any] | None:
        """The play currently on the speaker, for the beacon to report.

        The server needs this because the vote window would otherwise close on
        wall-clock time: `started_at + duration + 30s` keeps ticking while
        playback is paused, so pausing mid-song used to end voting on a song
        still sitting on the speaker. Reporting the open play lets the server
        hold the window open for as long as the Pi says the song is live.

        `played_ms_at` excludes paused time, so this is true playback position
        rather than elapsed wall clock.
        """
        moment = at or now()
        # The routed phone only. Several phones can be connected at once and
        # only one of them is audible, so scanning them all would make this a
        # coin toss between the song the room is hearing and one it is not.
        session = self._sessions.get(self._aux_path or "")
        if session is None:
            return None
        play = session.current_play
        if play is not None and play.created and not play.closed:
            return {
                "id": play.id,
                "status": play.status,
                "played_ms": play.played_ms_at(moment),
            }
        return None

    # -- BluezWatcher.LifecycleSink protocol --------------------------------

    async def on_device_connected(self, device_path: str, mac: str, alias: str) -> None:
        async with self._lock:
            if device_path in self._sessions:
                # BlueZ re-announces devices on a listener restart, and iOS
                # reconnects on its own after a lock screen. Neither is a
                # newcomer, and neither should disturb who holds the aux.
                return

            moment = now()
            self._sessions[device_path] = Session(
                device_path=device_path,
                mac=mac,
                alias=alias,
                connected_at=moment,
                last_active_at=moment,
            )
            log.info("session open: %s (%s)", alias, mac)

            # Connecting is always allowed - a connection that dies with no
            # reason given is the worst possible way to say "wait your turn".
            # It just does not necessarily come with the speaker attached.
            if self._holder(moment) is None:
                await self._grant(self._sessions[device_path])
            else:
                log.info("%s is waiting for the aux", alias)

    def _holder(self, at: datetime) -> Session | None:
        """The session entitled to the speaker right now, if any.

        A phone keeps it while a song is open and for AUX_GRACE after the last
        thing it did. The grace is what stops a waiting phone snatching the
        aux in the gap between two songs.
        """
        if self._aux_path is None:
            return None
        session = self._sessions.get(self._aux_path)
        if session is None:
            return None
        play = session.current_play
        if play is not None and not play.closed:
            return session
        if at - session.last_active_at < AUX_GRACE:
            return session
        return None

    async def _grant(self, session: Session) -> None:
        """Point the speaker at one phone."""
        self._aux_path = session.device_path
        # They are audible now, so nothing about the last time they were told
        # to wait should carry forward. Left set, a phone that hands the aux
        # back seconds later would sit inside a stale cooldown and get to play
        # into the void un-paused.
        session.last_paused_at = None
        log.info("aux granted to %s (%s)", session.alias, session.mac)
        await self._aux.route(session.mac)

    async def _may_use_aux(self, session: Session, at: datetime) -> bool:
        """Whether this phone's audio is reaching the room.

        Also the gate on recording: a song nobody could hear did not play to
        the room, and putting it on the leaderboard would be a lie.
        """
        holder = self._holder(at)
        if holder is session:
            return True
        if holder is None:
            # Free, so playing is how you claim it. Nobody has to disconnect
            # and the waiting phone does not have to do anything but press
            # play.
            await self._grant(session)
            return True
        return False

    async def _pause_politely(self, session: Session) -> None:
        """Pause a phone that is playing into a speaker it is not routed to.

        Without this their phone streams a whole playlist into nothing and the
        only feedback they get is silence. Best effort: some players do not
        implement AVRCP pause, and a phone we cannot pause is a minor
        annoyance rather than a reason to fail anything.
        """
        if self._pause is None:
            return

        moment = now()
        if (
            session.last_paused_at is not None
            and moment - session.last_paused_at < PAUSE_COOLDOWN
        ):
            return
        # Stamped BEFORE the call, not after: a pause that hangs until its
        # timeout must not leave the door open for a storm of retries behind
        # it.
        session.last_paused_at = moment

        try:
            await asyncio.wait_for(
                self._pause(session.device_path), timeout=PAUSE_COMMAND_TIMEOUT_S
            )
            log.info("paused %s, which is not on the aux", session.alias)
        except Exception:
            log.warning("could not pause %s", session.alias, exc_info=True)

    async def on_device_disconnected(self, device_path: str) -> None:
        async with self._lock:
            session = self._sessions.pop(device_path, None)
            if session is None:
                return
            if session.current_play is not None:
                await self._close_play(session, session.current_play, reason="disconnect")
            log.info("session closed: %s (%s)", session.alias, session.mac)

            if self._aux_path != device_path:
                return
            self._aux_path = None
            # Hand it straight to whoever has been waiting longest rather than
            # leaving the speaker unrouted. Re-pointing it costs a service
            # restart, and doing that lazily would eat the first second of
            # their first song.
            waiting = sorted(self._sessions.values(), key=lambda s: s.connected_at)
            if waiting:
                await self._grant(waiting[0])
            else:
                await self._aux.route(None)

    async def on_track_changed(
        self,
        device_path: str,
        track: dict[str, Any],
        position_ms: int | None = None,
        _force: bool = False,
    ) -> None:
        async with self._lock:
            await self._track_changed(device_path, track, position_ms, _force)

    async def _track_changed(
        self,
        device_path: str,
        track: dict[str, Any],
        position_ms: int | None = None,
        _force: bool = False,
    ) -> None:
        session = self._sessions.get(device_path)
        if session is None:
            log.warning("track change for unknown session %s", device_path)
            return

        title = _as_str(track.get("Title"))
        artist = _as_str(track.get("Artist"))
        album = _as_str(track.get("Album"))
        duration_ms = _as_int(track.get("Duration"))
        incomplete = not title or not artist

        # An entirely empty Track is the connection handshake, not a play.
        # Partial metadata is still recorded (and flagged incomplete) per
        # spec; nothing at all is an artifact and must not create a row.
        if not title and not artist:
            log.info("ignoring empty track metadata (no title or artist)")
            return

        session.last_track = dict(track)
        new_key = track_key(title, artist)
        current = session.current_play
        moment = now()

        # Somebody else is audible. Remember the metadata - it is what lets
        # this phone start recording the moment it does get the aux - but do
        # not open a play for a song the room cannot hear.
        if not await self._may_use_aux(session, moment):
            log.info(
                "not recording %s - %s: %s is not on the aux",
                artist or "?", title or "?", session.alias,
            )
            await self._pause_politely(session)
            return

        # Real metadata from this phone means it is using the aux, even if the
        # re-emit check below decides it is not a new play.
        session.last_active_at = moment

        if current is not None and new_key == current.key and not _force:
            if self._is_genuine_restart(current, position_ms, moment):
                log.info("same track restarted at position ~0, recording as a replay")
            else:
                # Phones re-emit identical metadata constantly: on volume
                # change, app foregrounding, and — observed on iOS — once
                # more for the outgoing track at every track change. None of
                # those are new plays.
                current.last_track_event_at = moment
                return

        if current is not None:
            await self._close_play(session, current, reason="track_changed")

        play = Play(
            id=str(uuid.uuid4()),
            title=title,
            artist=artist,
            album=album,
            duration_ms=duration_ms,
            started_at=moment,
            incomplete=incomplete,
        )
        session.current_play = play
        log.info(
            "play opened: %s - %s%s [%s]",
            artist or "?", title or "?", " (incomplete)" if incomplete else "", play.id,
        )

        # Held back briefly rather than written immediately: phones emit the
        # outgoing track once more at each change, producing sub-second plays
        # that are metadata artifacts, not skips. A real skip takes a human
        # at least a moment. If the play dies inside the grace it is never
        # written at all, so the artifacts never reach the database.
        play.create_payload = {
            "play_id": play.id,
            "device_mac": session.mac,
            "device_alias": session.alias,
            "title": title,
            "artist": artist,
            "album": album,
            "duration_ms": duration_ms,
            "started_at": play.started_at.isoformat(),
            "incomplete": incomplete,
        }
        play.create_timer = asyncio.create_task(self._enqueue_create_after_grace(play))

        if duration_ms:
            play.duration_timer = asyncio.create_task(
                self._duration_watchdog(session, play, duration_ms)
            )

    async def on_status_changed(self, device_path: str, status: str) -> None:
        async with self._lock:
            await self._status_changed(device_path, status)

    async def _status_changed(self, device_path: str, status: str) -> None:
        session = self._sessions.get(device_path)
        if session is None:
            return

        moment_now = now()
        if status == "playing" and not await self._may_use_aux(session, moment_now):
            # They pressed play on a speaker that is not listening to them.
            log.info("%s pressed play but is not on the aux", session.alias)
            await self._pause_politely(session)
            return

        # Any AVRCP status at all is this phone using the aux, including the
        # "stopped" that ends a song - that is what starts AUX_GRACE running.
        session.last_active_at = moment_now

        if session.current_play is None:
            # Playback restarting after a stop. The phone will not re-send
            # metadata for an unchanged track, so without this the song
            # would play to the room and never be recorded at all.
            if status == "playing" and session.last_track is not None:
                log.info("playback resumed with no open play, reopening from last track")
                await self._track_changed(device_path, session.last_track, 0, _force=True)
            return

        play = session.current_play
        moment = now()

        # AVRCP is authoritative about playback; the transport is a hint. Any
        # status at all supersedes a pending idle-close, including a "playing"
        # that merely re-asserts what we already believed.
        if status in ("playing", "paused") and play.transport_timer is not None:
            play.transport_timer.cancel()
            play.transport_timer = None

        if status == "playing":
            if play.status == "paused":
                play.status = "playing"
                play.playing_since = moment
                play.paused_at = None
                if play.pause_timer is not None:
                    play.pause_timer.cancel()
                    play.pause_timer = None
                log.info("play resumed: %s", play.id)
                return

        elif status == "paused":
            if play.status == "playing":
                play.accumulated_played_ms = play.played_ms_at(moment)
                play.playing_since = None
                play.status = "paused"
                play.paused_at = moment
                play.pause_timer = asyncio.create_task(self._pause_watchdog(session, play))
                log.info("play paused: %s", play.id)

        elif status == "stopped":
            await self._close_play(session, play, reason="stopped")

    async def on_transport_state_changed(self, device_path: str, state: str) -> None:
        async with self._lock:
            await self._transport_state_changed(device_path, state)

    async def _transport_state_changed(self, device_path: str, state: str) -> None:
        # Secondary signal only: some phones don't reliably emit
        # Status=stopped. It must never override pause semantics — the
        # A2DP transport goes idle a beat after every pause, and closing
        # here would defeat the 60s resume grace entirely.
        session = self._sessions.get(device_path)
        if session is None or session.current_play is None:
            return
        play = session.current_play

        if state != "idle":
            # Audio flowing again. Whatever the idle was, it was not a stop.
            if play.transport_timer is not None:
                play.transport_timer.cancel()
                play.transport_timer = None
            return

        if play.status == "paused":
            log.debug("transport idle while paused; leaving play open for resume")
            return
        if play.transport_timer is not None:
            return

        # Checking play.status here is not enough on its own: BlueZ delivers
        # the transport State and the player Status as separate signals in
        # either order, so on a pause this can run while status is still
        # "playing". Production caught it doing exactly that — "It's Up" was
        # closed (transport_idle) at played=60987ms, the instant it was paused,
        # and the site went straight from playing to ended with no pause in
        # between. Give AVRCP a few seconds to have its say, then decide.
        play.transport_timer = asyncio.create_task(
            self._transport_idle_watchdog(session, play, now())
        )

    @staticmethod
    def _is_genuine_restart(
        current: Play, position_ms: int | None, moment: datetime
    ) -> bool:
        """Distinguish a real replay of the open track from a spurious
        re-emit of its metadata.

        Position is the reliable signal: restarting a song resets it to ~0,
        while a re-emit during continuous playback reports a position well
        into the track. When the player does not expose Position we assume
        spurious, because re-emits are common and back-to-back replays are
        rare — guessing the other way manufactures phantom plays on every
        track change.
        """
        if position_ms is None:
            return False
        if position_ms > RESTART_POSITION_MS:
            return False
        # Position near zero right after the play opened is just the initial
        # metadata settling, not a restart.
        return moment - current.started_at >= DEBOUNCE_WINDOW

    # -- internals ------------------------------------------------------------

    async def _enqueue_create_after_grace(self, play: Play) -> None:
        try:
            await asyncio.sleep(MIN_PLAY_GRACE.total_seconds())
        except asyncio.CancelledError:
            return
        async with self._lock:
            if play.closed or play.create_payload is None:
                return
            play.created = True
            await self._store.enqueue(
                outbox_id=f"play-create-{play.id}",
                method="POST",
                endpoint="/api/plays",
                payload=play.create_payload,
            )

    async def _duration_watchdog(self, session: Session, play: Play, duration_ms: int) -> None:
        try:
            await asyncio.sleep(duration_ms / 1000 + DURATION_BUFFER.total_seconds())
        except asyncio.CancelledError:
            return
        async with self._lock:
            if session.current_play is play and not play.closed:
                await self._close_play(session, play, reason="duration_elapsed")

    async def _pause_watchdog(self, session: Session, play: Play) -> None:
        try:
            await asyncio.sleep(PAUSE_GRACE.total_seconds())
        except asyncio.CancelledError:
            return
        async with self._lock:
            if session.current_play is play and not play.closed and play.status == "paused":
                await self._close_play(
                    session, play, reason="pause_timeout", end_at=play.paused_at
                )

    async def _transport_idle_watchdog(
        self, session: Session, play: Play, idle_at: datetime
    ) -> None:
        try:
            await asyncio.sleep(TRANSPORT_IDLE_GRACE.total_seconds())
        except asyncio.CancelledError:
            return
        async with self._lock:
            play.transport_timer = None
            if session.current_play is not play or play.closed:
                return
            if play.status == "paused":
                log.debug("transport idle resolved to a pause; leaving play open")
                return
            # Nothing contradicted the idle, so it really was a stop. Close at
            # the moment the audio actually stopped, not five seconds later —
            # otherwise every such play banks the grace period as playback.
            await self._close_play(session, play, reason="transport_idle", end_at=idle_at)

    async def _close_play(
        self, session: Session, play: Play, reason: str, end_at: datetime | None = None
    ) -> None:
        if play.closed:
            return
        play.closed = True
        moment = end_at or now()
        # The aux stays this phone's for AUX_GRACE past the end of the song,
        # so nobody can take it in the gap before the next one starts.
        session.last_active_at = max(session.last_active_at, moment)

        # Never cancel the task we are running on. _close_play is called from
        # inside these watchdogs, and cancelling the caller means the very next
        # await — the outbox enqueue below — raises CancelledError and the close
        # is silently lost. The play ends on the Pi and stays open forever in
        # D1: no ended_at, no played_ms, no counted. Production had two such
        # rows (90210 and Circadian Rhythm), both closed by pause_timeout, both
        # logged as closed, neither ever written.
        running = asyncio.current_task()
        for timer in (
            play.duration_timer,
            play.pause_timer,
            play.create_timer,
            play.transport_timer,
        ):
            if timer is not None and timer is not running:
                timer.cancel()

        played_ms = play.played_ms_at(moment)
        counted = played_ms >= SKIP_THRESHOLD_MS

        if session.current_play is play:
            session.current_play = None

        if not play.created:
            # Died inside the grace window — a metadata artifact that was
            # never written, so there is nothing to close.
            log.info(
                "play discarded (%s): %s - %s lasted only %dms [%s]",
                reason, play.artist or "?", play.title or "?", played_ms, play.id,
            )
            return

        log.info(
            "play closed (%s): %s - %s played=%dms counted=%s [%s]",
            reason, play.artist or "?", play.title or "?", played_ms, counted, play.id,
        )

        await self._store.enqueue(
            outbox_id=f"play-close-{play.id}",
            method="PATCH",
            endpoint=f"/api/plays/{play.id}",
            payload={
                "ended_at": moment.isoformat(),
                "played_ms": played_ms,
                "counted": counted,
            },
        )
