"""Replays event sequences captured from a real iPhone against the
SessionManager, asserting the play records that come out the other side.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.lifecycle as lifecycle_mod  # noqa: E402
from lockerroom.lifecycle import SessionManager  # noqa: E402


@pytest.fixture(autouse=True)
def fast_grace(monkeypatch):
    """Shrink the create-grace so tests don't sleep 2s each."""
    from datetime import timedelta
    monkeypatch.setattr(lifecycle_mod, "MIN_PLAY_GRACE", timedelta(seconds=0.02))


async def settle():
    """Let the deferred create-enqueue fire."""
    await asyncio.sleep(0.06)

DEV = "/org/bluez/hci0/dev_5C_AD_BA_F0_B2_61"


class FakeStore:
    """Captures outbox writes instead of touching SQLite."""

    def __init__(self):
        self.rows: list[dict] = []

    async def enqueue(self, outbox_id, method, endpoint, payload):
        self.rows.append(
            {"id": outbox_id, "method": method, "endpoint": endpoint, "payload": payload}
        )

    def opened(self):
        return [r for r in self.rows if r["method"] == "POST" and r["endpoint"] == "/api/plays"]

    def closed(self):
        return [r for r in self.rows if r["method"] == "PATCH"]


def track(title, artist, duration=200_000):
    return {"Title": title, "Artist": artist, "Album": "", "Duration": duration}


async def connect(mgr):
    await mgr.on_device_connected(DEV, "5C:AD:BA:F0:B2:61", "Mack's iPhone")


@pytest.mark.asyncio
async def test_empty_track_on_connect_creates_no_play():
    """The iPhone emits an empty Track dict at connect; that handshake
    artifact must not become a play row."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, {"Title": "", "Artist": "", "Album": ""}, None)
    await settle()

    assert store.opened() == []


@pytest.mark.asyncio
async def test_reemit_of_open_track_does_not_split_the_play():
    """Observed on iOS: identical metadata is re-emitted mid-playback (and
    again for the outgoing track at every change). Position is well into
    the track, so it must be ignored rather than opening a second play."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    # same track re-emitted 35s in, position continuing forward
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 35_000)
    await settle()

    assert len(store.opened()) == 1
    assert store.closed() == []


@pytest.mark.asyncio
async def test_genuine_replay_at_position_zero_opens_a_new_play():
    """Same song deliberately played again: position resets to ~0, so this
    is a real second play (spec test checklist: two plays, one track)."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    play = mgr._sessions[DEV]
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()  # first play survives the grace and is written
    # backdate so the restart is outside the debounce window
    from datetime import timedelta
    play.current_play.started_at -= timedelta(seconds=30)
    play.current_play.playing_since -= timedelta(seconds=30)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 500)
    await settle()

    assert len(store.opened()) == 2
    assert len(store.closed()) == 1


@pytest.mark.asyncio
async def test_missing_position_assumes_reemit_not_replay():
    """Players may not expose Position. Guessing 'replay' there would
    manufacture a phantom play on every track change, so we assume re-emit."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), None)
    await settle()
    from datetime import timedelta
    mgr._sessions[DEV].current_play.started_at -= timedelta(seconds=30)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), None)
    await settle()

    assert len(store.opened()) == 1


@pytest.mark.asyncio
async def test_distinct_tracks_close_and_open():
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_track_changed(DEV, track("Just A Girl", "No Doubt"), 0)
    await settle()

    assert len(store.opened()) == 2
    assert len(store.closed()) == 1


@pytest.mark.asyncio
async def test_partial_metadata_still_records_and_flags_incomplete():
    """Spec: log the play with whatever fields exist, mark it incomplete."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Some Bootleg", ""), 0)
    await settle()

    opened = store.opened()
    assert len(opened) == 1
    assert opened[0]["payload"]["incomplete"] is True


@pytest.mark.asyncio
async def test_short_play_is_recorded_but_not_counted():
    """Skip rule: under 30s still recorded, counted = false."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_track_changed(DEV, track("Just A Girl", "No Doubt"), 0)
    await settle()

    closed = store.closed()[0]
    assert closed["payload"]["counted"] is False


@pytest.mark.asyncio
async def test_pause_and_resume_stays_one_play():
    """Pause is not an end; resuming continues the same play."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_status_changed(DEV, "paused")
    await mgr.on_status_changed(DEV, "playing")

    assert len(store.opened()) == 1
    assert store.closed() == []


@pytest.mark.asyncio
async def test_transport_idle_while_paused_does_not_end_the_play():
    """Regression, caught on a real iPhone: the A2DP transport goes idle a
    beat after every pause. Closing on that defeats the 60s resume grace and
    left resumed playback recorded as nothing at all."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("What You Waiting For?", "Gwen Stefani"), 0)
    await settle()
    await mgr.on_status_changed(DEV, "paused")
    await mgr.on_transport_state_changed(DEV, "idle")

    assert store.closed() == [], "pause must not end the play"

    await mgr.on_status_changed(DEV, "playing")
    assert len(store.opened()) == 1, "resume must continue the same play"


@pytest.mark.asyncio
async def test_transport_idle_while_playing_still_ends_the_play():
    """The secondary stop signal must keep working when not paused."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_transport_state_changed(DEV, "idle")

    assert len(store.closed()) == 1


@pytest.mark.asyncio
async def test_playback_resuming_after_stop_reopens_a_play():
    """After a stop the phone will not re-send metadata for an unchanged
    track, so the song would otherwise play to the room unrecorded."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_status_changed(DEV, "stopped")
    assert len(store.closed()) == 1

    await mgr.on_status_changed(DEV, "playing")
    await settle()

    assert len(store.opened()) == 2, "resumed playback must be recorded"


@pytest.mark.asyncio
async def test_subsecond_artifact_play_is_never_written():
    """iOS re-emits the outgoing track at each change, creating sub-second
    plays. Those are artifacts, not skips, and must not reach the database
    or they pollute the most-skipped stat forever."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    # opened and replaced well inside the grace window
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await mgr.on_track_changed(DEV, track("What You Waiting For?", "Gwen Stefani"), 0)
    await settle()

    opened = store.opened()
    assert len(opened) == 1, "the artifact play must never be written"
    assert opened[0]["payload"]["artist"] == "Gwen Stefani"
    assert store.closed() == [], "nothing to close for a play never written"


@pytest.mark.asyncio
async def test_real_skip_past_the_grace_is_still_recorded():
    """The grace must not swallow genuine skips - spec keeps those."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()  # survives the grace, so it is a real play
    await mgr.on_track_changed(DEV, track("Just A Girl", "No Doubt"), 0)
    await settle()

    assert len(store.opened()) == 2
    assert len(store.closed()) == 1
    assert store.closed()[0]["payload"]["counted"] is False


@pytest.mark.asyncio
async def test_disconnect_closes_open_play():
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_device_disconnected(DEV)

    assert len(store.closed()) == 1
