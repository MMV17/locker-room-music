from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

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
    current_play: Play | None = None
    # Last track seen on this session, so playback resuming after a stop can
    # be recorded without waiting for the phone to re-send metadata (it will
    # not, if the track has not changed).
    last_track: dict[str, Any] | None = None


class SessionManager:
    def __init__(self, store: Store):
        self._store = store
        self._sessions: dict[str, Session] = {}

    # -- BluezWatcher.LifecycleSink protocol --------------------------------

    async def on_device_connected(self, device_path: str, mac: str, alias: str) -> None:
        if device_path in self._sessions:
            return
        self._sessions[device_path] = Session(
            device_path=device_path, mac=mac, alias=alias, connected_at=now()
        )
        log.info("session open: %s (%s)", alias, mac)

    async def on_device_disconnected(self, device_path: str) -> None:
        session = self._sessions.pop(device_path, None)
        if session is None:
            return
        if session.current_play is not None:
            await self._close_play(session, session.current_play, reason="disconnect")
        log.info("session closed: %s (%s)", session.alias, session.mac)

    async def on_track_changed(
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
        session = self._sessions.get(device_path)
        if session is None:
            return

        if session.current_play is None:
            # Playback restarting after a stop. The phone will not re-send
            # metadata for an unchanged track, so without this the song
            # would play to the room and never be recorded at all.
            if status == "playing" and session.last_track is not None:
                log.info("playback resumed with no open play, reopening from last track")
                await self.on_track_changed(device_path, session.last_track, 0, _force=True)
            return

        play = session.current_play
        moment = now()

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
        # Secondary signal only: some phones don't reliably emit
        # Status=stopped. It must never override pause semantics — the
        # A2DP transport goes idle a beat after every pause, and closing
        # here would defeat the 60s resume grace entirely.
        if state != "idle":
            return
        session = self._sessions.get(device_path)
        if session is None or session.current_play is None:
            return
        play = session.current_play
        if play.status == "paused":
            log.debug("transport idle while paused; leaving play open for resume")
            return
        await self._close_play(session, play, reason="transport_idle")

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
        if session.current_play is play and not play.closed:
            await self._close_play(session, play, reason="duration_elapsed")

    async def _pause_watchdog(self, session: Session, play: Play) -> None:
        try:
            await asyncio.sleep(PAUSE_GRACE.total_seconds())
        except asyncio.CancelledError:
            return
        if session.current_play is play and not play.closed and play.status == "paused":
            await self._close_play(session, play, reason="pause_timeout", end_at=play.paused_at)

    async def _close_play(
        self, session: Session, play: Play, reason: str, end_at: datetime | None = None
    ) -> None:
        if play.closed:
            return
        play.closed = True
        moment = end_at or now()

        if play.duration_timer is not None:
            play.duration_timer.cancel()
        if play.pause_timer is not None:
            play.pause_timer.cancel()
        if play.create_timer is not None:
            play.create_timer.cancel()

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
