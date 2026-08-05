"""
The beacon is the only way the server learns a song was paused, resumed or
skipped. At a flat 60s that news arrived up to a minute late, and the site
kept ticking a progress bar through a paused track.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.control import play_signature  # noqa: E402


class FakeSessions:
    def __init__(self, state):
        self.state = state

    def open_play_state(self):
        return self.state


class TestPlaySignature:
    def test_none_when_nothing_is_playing(self):
        assert play_signature(FakeSessions(None)) is None

    def test_none_without_a_session_manager(self):
        assert play_signature(None) is None

    def test_changes_when_playback_pauses(self):
        playing = FakeSessions({"id": "p1", "status": "playing", "played_ms": 1000})
        paused = FakeSessions({"id": "p1", "status": "paused", "played_ms": 1000})
        assert play_signature(playing) != play_signature(paused)

    def test_changes_when_the_song_changes(self):
        a = FakeSessions({"id": "p1", "status": "playing", "played_ms": 90000})
        b = FakeSessions({"id": "p2", "status": "playing", "played_ms": 10})
        assert play_signature(a) != play_signature(b)

    def test_position_alone_is_not_a_change(self):
        # Position moves every millisecond. Beaconing on it would be a busy
        # loop against the Worker, which is exactly what spec 8 guards against.
        a = FakeSessions({"id": "p1", "status": "playing", "played_ms": 1000})
        b = FakeSessions({"id": "p1", "status": "playing", "played_ms": 45000})
        assert play_signature(a) == play_signature(b)

    def test_survives_a_session_manager_that_raises(self):
        class Broken:
            def open_play_state(self):
                raise RuntimeError("d-bus went away")

        # A broken read must not kill the loop that also carries remote
        # commands — that is the only way back into an unreachable Pi.
        assert play_signature(Broken()) is None
