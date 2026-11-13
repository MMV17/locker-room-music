"""A waiting phone that starts streaming has its A2DP profile cut, and gets it
back when it is granted the aux. See DROP_WAITING_STREAMS in lifecycle.py and
docs/STATE.md, "Two phones: the second stream knocks out the first".
"""

from __future__ import annotations

import asyncio
import sys
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.lifecycle as lifecycle_mod  # noqa: E402
from lockerroom.lifecycle import A2DP_SOURCE_UUID, SessionManager  # noqa: E402

from test_lifecycle import (  # noqa: E402
    DEV, MAC, OTHER, OTHER_MAC, FakeAux, FakeStore, connect, connect_other,
    settle, settle_aux, track,
)


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(lifecycle_mod, "MIN_PLAY_GRACE", timedelta(seconds=0.02))
    monkeypatch.setattr(lifecycle_mod, "TRANSPORT_IDLE_GRACE", timedelta(seconds=0.05))
    monkeypatch.setattr(lifecycle_mod, "AUX_SETTLE", timedelta(seconds=0.02))
    monkeypatch.setattr(lifecycle_mod, "DROP_COOLDOWN", timedelta(seconds=0.2))
    # OFF in production since the 2026-11-13 hardware test (the restore does
    # not bring iOS's stream back). On here so the mechanism stays tested.
    monkeypatch.setattr(lifecycle_mod, "DROP_WAITING_STREAMS", True)


class FakeProfiles:
    def __init__(self, fail_drop: bool = False):
        self.dropped: list[tuple[str, str]] = []
        self.connected: list[tuple[str, str]] = []
        self.fail_drop = fail_drop

    async def disconnect(self, path: str, uuid: str) -> None:
        await asyncio.sleep(0)
        if self.fail_drop:
            raise RuntimeError("org.bluez.Error.Failed")
        self.dropped.append((path, uuid))

    async def connect(self, path: str, uuid: str) -> None:
        await asyncio.sleep(0)
        self.connected.append((path, uuid))


def manager(profiles: FakeProfiles | None):
    mgr = SessionManager(FakeStore(), aux=FakeAux())
    if profiles is not None:
        mgr.set_profiles(profiles.disconnect, profiles.connect)
    return mgr


async def dj_playing_and_other_waiting(mgr):
    """DEV holds the aux with a song open; OTHER is connected and past settle."""
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Everlong", "Foo Fighters"), 0)
    await settle()
    await connect_other(mgr)
    await settle_aux()


@pytest.mark.asyncio
async def test_a_waiting_phone_that_starts_streaming_has_its_a2dp_cut():
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")

    assert profiles.dropped == [(OTHER, A2DP_SOURCE_UUID)]
    assert mgr._sessions[OTHER].a2dp_dropped
    assert OTHER in mgr._sessions          # still connected, still waiting


@pytest.mark.asyncio
async def test_the_dj_is_never_cut():
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(DEV, "active")

    assert profiles.dropped == []


@pytest.mark.asyncio
async def test_nobody_is_cut_while_the_aux_is_free():
    """Streaming into a free speaker is how a phone claims it."""
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await connect(mgr)
    await settle_aux()

    await mgr.on_transport_state_changed(DEV, "active")

    assert profiles.dropped == []


@pytest.mark.asyncio
async def test_an_idle_transport_is_not_cut():
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(OTHER, "idle")

    assert profiles.dropped == []


@pytest.mark.asyncio
async def test_never_inside_the_setup_window_but_looked_at_again_after(monkeypatch):
    """Tearing A2DP down mid-negotiation is what made iOS say 'forget this
    device' on 2026-08-09. Wait the window out, then cut if still streaming."""
    monkeypatch.setattr(lifecycle_mod, "AUX_SETTLE", timedelta(seconds=0.15))
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Everlong", "Foo Fighters"), 0)
    await settle()
    await connect_other(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")
    assert profiles.dropped == []           # still settling

    await asyncio.sleep(0.25)
    assert profiles.dropped == [(OTHER, A2DP_SOURCE_UUID)]


@pytest.mark.asyncio
async def test_a_deferred_cut_is_skipped_if_the_stream_stopped(monkeypatch):
    monkeypatch.setattr(lifecycle_mod, "AUX_SETTLE", timedelta(seconds=0.15))
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await connect(mgr)
    await mgr.on_track_changed(DEV, track("Everlong", "Foo Fighters"), 0)
    await settle()
    await connect_other(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")
    await mgr.on_transport_state_changed(OTHER, "idle")
    await asyncio.sleep(0.25)

    assert profiles.dropped == []


@pytest.mark.asyncio
async def test_repeat_streams_inside_the_cooldown_are_cut_once():
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")
    await mgr.on_transport_state_changed(OTHER, "active")
    await mgr.on_transport_state_changed(OTHER, "pending")
    assert len(profiles.dropped) == 1

    await asyncio.sleep(0.25)
    await mgr.on_transport_state_changed(OTHER, "pending")
    assert len(profiles.dropped) == 2


@pytest.mark.asyncio
async def test_the_stream_comes_back_when_the_waiting_phone_gets_the_aux():
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)
    await mgr.on_transport_state_changed(OTHER, "pending")

    await mgr.on_device_disconnected(DEV)   # the DJ leaves; OTHER is next
    await asyncio.sleep(0.05)

    assert mgr._aux_path == OTHER
    assert profiles.connected == [(OTHER, A2DP_SOURCE_UUID)]
    assert not mgr._sessions[OTHER].a2dp_dropped


@pytest.mark.asyncio
async def test_a_phone_we_never_cut_is_not_reconnected_on_grant():
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_device_disconnected(DEV)
    await asyncio.sleep(0.05)

    assert mgr._aux_path == OTHER
    assert profiles.connected == []


@pytest.mark.asyncio
async def test_a_failed_drop_is_survived_and_not_marked(monkeypatch):
    profiles = FakeProfiles(fail_drop=True)
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")

    assert not mgr._sessions[OTHER].a2dp_dropped
    assert OTHER in mgr._sessions


@pytest.mark.asyncio
async def test_the_off_switch_restores_pause_only(monkeypatch):
    monkeypatch.setattr(lifecycle_mod, "DROP_WAITING_STREAMS", False)
    profiles = FakeProfiles()
    mgr = manager(profiles)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")

    assert profiles.dropped == []


@pytest.mark.asyncio
async def test_without_profile_control_nothing_changes():
    """Every older wiring (and every other test file) has no set_profiles."""
    mgr = manager(None)
    await dj_playing_and_other_waiting(mgr)

    await mgr.on_transport_state_changed(OTHER, "pending")

    assert OTHER in mgr._sessions


def test_off_in_production_until_the_restore_works():
    """Read from the source, not the module: the fixture above patches it."""
    src = Path(lifecycle_mod.__file__).read_text()
    assert "\nDROP_WAITING_STREAMS = False\n" in src
