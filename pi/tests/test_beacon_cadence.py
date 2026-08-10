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
    def __init__(self, state, aux=None):
        self.state = state
        self.aux = aux or {"holder": None, "waiting": []}

    def open_play_state(self):
        return self.state

    def aux_state(self):
        return self.aux


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


class TestAuxInTheSignature:
    """A phone that connects and is told to wait must not sit there for up to
    a minute before the site can say so. The beacon wakes early on what the
    site RENDERS, and whose turn it is is now part of that."""

    HOLDER = {"holder": {"mac": "AA", "alias": "Mack's iPhone"}, "waiting": []}

    def test_a_phone_starting_to_wait_is_a_change(self):
        alone = FakeSessions(None, self.HOLDER)
        joined = FakeSessions(None, {
            "holder": {"mac": "AA", "alias": "Mack's iPhone"},
            "waiting": [{"mac": "BB", "alias": "Ty's Pixel"}],
        })
        assert play_signature(alone) != play_signature(joined)

    def test_the_aux_changing_hands_is_a_change(self):
        a = FakeSessions(None, self.HOLDER)
        b = FakeSessions(None, {"holder": {"mac": "BB", "alias": "Ty's Pixel"}, "waiting": []})
        assert play_signature(a) != play_signature(b)

    def test_an_idle_speaker_with_nobody_connected_is_still_nothing(self):
        # Otherwise the loop would settle to the ACTIVE interval forever and
        # beacon every 10s at an empty locker room.
        assert play_signature(FakeSessions(None)) is None

    def test_survives_an_aux_read_that_raises(self):
        class Broken:
            def open_play_state(self):
                return None

            def aux_state(self):
                raise RuntimeError("d-bus went away")

        assert play_signature(Broken()) is None
