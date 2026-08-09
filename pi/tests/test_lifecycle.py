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
    """Shrink the graces so tests don't sleep out the real timers."""
    from datetime import timedelta
    monkeypatch.setattr(lifecycle_mod, "MIN_PLAY_GRACE", timedelta(seconds=0.02))
    monkeypatch.setattr(lifecycle_mod, "TRANSPORT_IDLE_GRACE", timedelta(seconds=0.05))
    # PAUSE_GRACE is deliberately NOT shrunk here: several tests pause and then
    # assert the play is still open, and a 50ms pause timeout would close it
    # out from under them. The one test that needs it short patches it itself.


async def settle():
    """Let the deferred create-enqueue fire."""
    await asyncio.sleep(0.06)


async def settle_watchdogs():
    """Let a transport-idle or pause watchdog run to its decision."""
    await asyncio.sleep(0.12)

DEV = "/org/bluez/hci0/dev_5C_AD_BA_F0_B2_61"


class FakeStore:
    """Captures outbox writes instead of touching SQLite."""

    def __init__(self):
        self.rows: list[dict] = []

    async def enqueue(self, outbox_id, method, endpoint, payload):
        # The real Store hands the write to asyncio.to_thread, so an enqueue
        # always yields to the event loop. Without this sleep the fake never
        # suspends, every handler runs start-to-finish uninterrupted, and no
        # test here can see an interleaving — which is how the duplicate-play
        # race lived in production while these tests stayed green.
        await asyncio.sleep(0)
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

    assert store.closed() == [], "must wait for AVRCP to contradict it"
    await settle_watchdogs()
    assert len(store.closed()) == 1


@pytest.mark.asyncio
async def test_transport_idle_arriving_before_the_pause_status_is_not_a_stop():
    """Regression from production, 2026-08-05. BlueZ delivers the transport's
    State and the player's Status as two independent signals, and the watcher
    fires each into its own task, so on a pause the idle can land first. The
    old code checked play.status at that instant, saw "playing", and closed
    the play — "It's Up" was ended at played=60987ms, the exact second it was
    paused, and the site jumped from playing straight to ended."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("It's Up", "Drake"), 0)
    await settle()

    await mgr.on_transport_state_changed(DEV, "idle")  # arrives first
    await mgr.on_status_changed(DEV, "paused")  # ...and is corrected
    await settle_watchdogs()

    assert store.closed() == [], "a pause must not end the play"

    await mgr.on_status_changed(DEV, "playing")
    await settle_watchdogs()
    assert len(store.opened()) == 1, "resume must continue the same play"
    assert store.closed() == []


@pytest.mark.asyncio
async def test_transport_going_active_again_cancels_the_pending_close():
    """Audio flowing again is proof the idle was not a stop."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await mgr.on_transport_state_changed(DEV, "idle")
    await mgr.on_transport_state_changed(DEV, "active")
    await settle_watchdogs()

    assert store.closed() == []


@pytest.mark.asyncio
async def test_transport_idle_close_is_dated_to_the_idle_not_the_decision(monkeypatch):
    """The grace is deliberation time, not playback. Banking it would push
    plays over the 30s counted threshold that never earned it."""
    from datetime import timedelta
    monkeypatch.setattr(lifecycle_mod, "TRANSPORT_IDLE_GRACE", timedelta(seconds=0.4))

    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()  # ~60ms of actual playback
    await mgr.on_transport_state_changed(DEV, "idle")
    await asyncio.sleep(0.5)

    played = store.closed()[0]["payload"]["played_ms"]
    assert played < 400, f"the 400ms grace was counted as playback: {played}ms"


@pytest.mark.asyncio
async def test_pause_timeout_close_actually_reaches_the_outbox(monkeypatch):
    """Regression from production, 2026-08-05. _close_play cancels the play's
    timers — including, when called from inside _pause_watchdog, the task it is
    running on. The CancelledError landed on the very next await, the outbox
    enqueue, so the play closed on the Pi and stayed open forever in D1: the
    log said "play closed (pause_timeout)" and no PATCH was ever written. Two
    rows in production ended up that way, both watchdog closes."""
    from datetime import timedelta
    monkeypatch.setattr(lifecycle_mod, "PAUSE_GRACE", timedelta(seconds=0.05))

    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Circadian Rhythm", "Drake"), 0)
    await settle()
    await mgr.on_status_changed(DEV, "paused")
    await settle_watchdogs()

    assert len(store.closed()) == 1, "the pause timeout must be written, not just logged"


@pytest.mark.asyncio
async def test_duration_watchdog_close_actually_reaches_the_outbox():
    """Same self-cancellation bug, via the other watchdog. This one fires on
    every song the phone lets run out without queueing another."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore", duration=10), 0)
    await settle()
    await asyncio.sleep(lifecycle_mod.DURATION_BUFFER.total_seconds() + 0.1)

    assert len(store.closed()) == 1, "the duration timeout must be written, not just logged"


@pytest.mark.asyncio
async def test_concurrent_track_changes_open_only_one_play():
    """Regression from production, 2026-08-05. BluezWatcher fires every
    PropertiesChanged into its own task. on_track_changed read current_play,
    awaited the close of the outgoing play, and only then wrote the new one
    back — so two Track signals in the same tick both opened a play. The loser
    was orphaned: never closed, never keepalived, and carrying the later
    started_at, which is the row /api/now selects. Four such pairs landed in
    production in eleven minutes."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Come and See Me", "PARTYNEXTDOOR"), 0)
    await settle()

    # Two signals for the same new track, dispatched together the way the
    # watcher dispatches them.
    await asyncio.gather(
        mgr.on_track_changed(DEV, track("No Face", "Drake"), 0),
        mgr.on_track_changed(DEV, track("No Face", "Drake"), 0),
    )
    await settle()

    titles = [r["payload"]["title"] for r in store.opened()]
    assert titles.count("No Face") == 1, f"one play per track change, got {titles}"


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



# -- one phone on the aux ----------------------------------------------------
#
# A2DP is not exclusive. Two phones can be connected and streaming at once and
# the speaker mixes them, so "one song at a time" has to be enforced rather
# than hoped for.
#
# It is NOT enforced by refusing the connection. A newcomer connects normally
# and simply is not routed to the speaker: a phone that connects and waits its
# turn is a far kinder failure than one whose connection dies with no reason
# given, and being connected is what lets the site say whose turn it is.


class FakeAux:
    """Records who the speaker is routed to, in order."""

    def __init__(self):
        self.routed: list[str | None] = []

    async def route(self, mac: str | None) -> None:
        await asyncio.sleep(0)
        if not self.routed or self.routed[-1] != mac:
            self.routed.append(mac)

    @property
    def current(self) -> str | None:
        return self.routed[-1] if self.routed else None


class FakeBluez:
    """Records the AVRCP pauses sent to phones that are not on the aux."""

    def __init__(self):
        self.paused: list[str] = []

    async def pause(self, device_path: str) -> None:
        await asyncio.sleep(0)
        self.paused.append(device_path)


MAC = "5C:AD:BA:F0:B2:61"
OTHER = "/org/bluez/hci0/dev_A1_B2_C3_D4_E5_F6"
OTHER_MAC = "A1:B2:C3:D4:E5:F6"


def manager(store, aux=None, bluez=None):
    mgr = SessionManager(store, aux=aux or FakeAux())
    if bluez is not None:
        mgr.set_pause(bluez.pause)
    return mgr


async def connect_other(mgr):
    await mgr.on_device_connected(OTHER, OTHER_MAC, "Ty's Pixel")


@pytest.mark.asyncio
async def test_the_first_phone_gets_the_aux_when_it_connects():
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)

    await connect(mgr)

    assert aux.current == MAC


@pytest.mark.asyncio
async def test_a_newcomer_connects_fine_but_is_not_routed():
    """The whole point of the redesign: they get in, they just get no audio."""
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()

    await connect_other(mgr)

    assert OTHER in mgr._sessions       # connected, not turned away
    assert aux.current == MAC           # and still not the one being heard


@pytest.mark.asyncio
async def test_a_newcomer_playing_records_no_play():
    """A phone nobody can hear did not play a song to the room. Recording it
    would put a song on the leaderboard that was never audible."""
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    store = mgr._store
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()

    await connect_other(mgr)
    await mgr.on_track_changed(OTHER, track("Chun-Li", "Nicki Minaj"), 0)
    await settle()

    assert [r["payload"]["title"] for r in store.opened()] == ["Decode"]


@pytest.mark.asyncio
async def test_a_newcomer_who_presses_play_is_paused_on_their_own_phone():
    """Otherwise their phone streams a whole playlist into a void and they get
    no signal at all that it is not coming out."""
    bluez = FakeBluez()
    mgr = manager(FakeStore(), bluez=bluez)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()

    await connect_other(mgr)
    await mgr.on_status_changed(OTHER, "playing")

    assert bluez.paused == [OTHER]


@pytest.mark.asyncio
async def test_the_phone_on_the_aux_is_never_paused():
    bluez = FakeBluez()
    mgr = manager(FakeStore(), bluez=bluez)
    await connect(mgr)

    await mgr.on_status_changed(DEV, "playing")
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()

    assert bluez.paused == []


@pytest.mark.asyncio
async def test_the_holder_keeps_the_aux_between_songs():
    """The gap after a song ends is exactly when a waiting phone would grab
    it. AUX_GRACE outlives the song for that reason."""
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await connect_other(mgr)
    await mgr.on_status_changed(DEV, "stopped")  # song over, nothing open

    await mgr.on_track_changed(OTHER, track("Chun-Li", "Nicki Minaj"), 0)
    await settle()

    assert aux.current == MAC


@pytest.mark.asyncio
async def test_a_paused_song_still_holds_the_aux():
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await connect_other(mgr)
    await mgr.on_status_changed(DEV, "paused")

    await mgr.on_status_changed(OTHER, "playing")

    assert aux.current == MAC


@pytest.mark.asyncio
async def test_a_waiting_phone_takes_the_aux_by_playing_once_the_grace_passes(monkeypatch):
    """The handoff. Nobody has to disconnect, and the waiting phone does not
    need to do anything except press play."""
    from datetime import timedelta
    monkeypatch.setattr(lifecycle_mod, "AUX_GRACE", timedelta(seconds=0.05))
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    store = mgr._store
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await connect_other(mgr)
    await mgr.on_status_changed(DEV, "stopped")
    await asyncio.sleep(0.06)

    await mgr.on_track_changed(OTHER, track("Chun-Li", "Nicki Minaj"), 0)
    await settle()

    assert aux.current == OTHER_MAC
    assert [r["payload"]["title"] for r in store.opened()] == ["Decode", "Chun-Li"]


@pytest.mark.asyncio
async def test_the_aux_passes_to_a_waiting_phone_when_the_holder_disconnects():
    """Handed straight over rather than left unrouted, so the next song starts
    at its first note instead of losing a second while the player restarts."""
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)
    await connect_other(mgr)

    await mgr.on_device_disconnected(DEV)

    assert aux.current == OTHER_MAC


@pytest.mark.asyncio
async def test_the_last_phone_leaving_routes_nobody():
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)

    await mgr.on_device_disconnected(DEV)

    assert aux.current is None


@pytest.mark.asyncio
async def test_a_waiting_phone_is_not_routed_just_for_connecting_first():
    """Two phones connect before anyone plays. The one that connected first
    holds it, so the second pressing play must not steal it."""
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)
    await connect_other(mgr)

    await mgr.on_status_changed(OTHER, "playing")

    assert aux.current == MAC


@pytest.mark.asyncio
async def test_the_holder_reconnecting_keeps_the_aux():
    aux = FakeAux()
    mgr = manager(FakeStore(), aux)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()

    await connect(mgr)  # BlueZ re-announcing the same device

    assert aux.current == MAC


@pytest.mark.asyncio
async def test_only_the_routed_phone_appears_as_the_open_play():
    """/api/now reads this. With two phones connected it must never be a coin
    toss which one the room is told it is hearing."""
    mgr = manager(FakeStore())
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()
    await connect_other(mgr)
    await mgr.on_track_changed(OTHER, track("Chun-Li", "Nicki Minaj"), 0)
    await settle()

    state = mgr.open_play_state()
    assert state is not None
    assert state["id"] == mgr._sessions[DEV].current_play.id


@pytest.mark.asyncio
async def test_the_lifecycle_runs_without_any_aux_wiring_at_all():
    """Every test above this block constructs SessionManager(store) bare. If
    the aux router ever becomes required, they all break at once — and so does
    anything that constructs one without it."""
    store = FakeStore()
    mgr = SessionManager(store)
    await connect(mgr)

    await mgr.on_track_changed(DEV, track("Decode", "Paramore"), 0)
    await settle()

    assert len(store.opened()) == 1
