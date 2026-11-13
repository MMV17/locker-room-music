"""The stale aux: the DJ's audio link vanishes while the phone stays
connected. See AUDIO_LOST_GRACE in lifecycle.py.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.lifecycle as lifecycle_mod  # noqa: E402
from lockerroom.lifecycle import SessionManager  # noqa: E402

from test_lifecycle import (  # noqa: E402
    DEV, MAC, OTHER, OTHER_MAC, FakeAux, FakeStore, connect, connect_other,
    settle, settle_aux, track,
)


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(lifecycle_mod, "MIN_PLAY_GRACE", timedelta(seconds=0.02))
    monkeypatch.setattr(lifecycle_mod, "TRANSPORT_IDLE_GRACE", timedelta(seconds=0.05))
    monkeypatch.setattr(lifecycle_mod, "AUX_SETTLE", timedelta(seconds=0.02))
    monkeypatch.setattr(lifecycle_mod, "AUDIO_LOST_GRACE", timedelta(seconds=0.05))
    monkeypatch.setattr(lifecycle_mod, "AUDIO_RECOVER_WAIT", timedelta(seconds=0.05))
    monkeypatch.setattr(lifecycle_mod, "AUDIO_RECOVER_COOLDOWN", timedelta(seconds=0.3))


class FakeConnect:
    def __init__(self, mgr=None, restores=False):
        self.calls: list[str] = []
        self.mgr = mgr
        self.restores = restores

    async def __call__(self, path: str) -> None:
        await asyncio.sleep(0)
        self.calls.append(path)
        if self.restores and self.mgr is not None:
            # BlueZ brings the transport back, as a real reconnect would.
            asyncio.get_running_loop().call_soon(
                lambda: asyncio.ensure_future(self.mgr.on_transport_state_changed(path, "active"))
            )


def manager(aux=None):
    return SessionManager(FakeStore(), aux=aux or FakeAux())


async def dj_with_audio(mgr, path=DEV):
    await connect(mgr)
    await mgr.on_transport_state_changed(DEV, "active")
    await mgr.on_status_changed(DEV, "playing")
    await mgr.on_track_changed(DEV, track("Freakin' Out", "Graveyard"), 0)
    await settle()


@pytest.mark.asyncio
async def test_a_dj_whose_audio_never_returns_loses_the_aux_to_the_waiting_phone():
    aux = FakeAux()
    mgr = manager(aux)
    connect_dev = FakeConnect()
    mgr.set_device_connect(connect_dev)
    await dj_with_audio(mgr)
    await connect_other(mgr)
    await mgr.on_transport_state_changed(OTHER, "idle")
    await settle_aux()

    await mgr.on_transport_removed(DEV)
    await asyncio.sleep(0.2)
    await settle_aux()

    assert connect_dev.calls == [DEV]              # recovery was tried first
    assert mgr._aux_path == OTHER                  # then the aux moved on
    assert mgr._sessions[DEV].audio_lost
    assert mgr._sessions[DEV].current_play is None # its play was closed
    assert aux.hears(OTHER_MAC)


@pytest.mark.asyncio
async def test_audio_that_comes_back_by_itself_changes_nothing():
    mgr = manager()
    connect_dev = FakeConnect()
    mgr.set_device_connect(connect_dev)
    await dj_with_audio(mgr)

    await mgr.on_transport_removed(DEV)
    await mgr.on_transport_state_changed(DEV, "active")
    await asyncio.sleep(0.2)

    assert connect_dev.calls == []
    assert mgr._aux_path == DEV
    assert not mgr._sessions[DEV].audio_lost


@pytest.mark.asyncio
async def test_a_successful_recovery_keeps_the_dj():
    mgr = manager()
    connect_dev = FakeConnect(mgr, restores=True)
    mgr.set_device_connect(connect_dev)
    await dj_with_audio(mgr)

    await mgr.on_transport_removed(DEV)
    await asyncio.sleep(0.2)

    assert connect_dev.calls == [DEV]
    assert mgr._aux_path == DEV
    assert not mgr._sessions[DEV].audio_lost


@pytest.mark.asyncio
async def test_an_audio_lost_phone_records_nothing_and_is_not_paused():
    """The 12 identical rows of 2026-11-13: plays for a song nobody heard."""
    from test_lifecycle import FakeBluez
    bluez = FakeBluez()
    mgr = manager()
    mgr.set_pause(bluez.pause)
    mgr.set_device_connect(FakeConnect())
    await dj_with_audio(mgr)
    await mgr.on_transport_removed(DEV)
    await asyncio.sleep(0.2)
    before = len(mgr._store.opened())

    for _ in range(3):
        await mgr.on_status_changed(DEV, "playing")
        await mgr.on_track_changed(DEV, track("Freakin' Out", "Graveyard"), 0)
    await settle()

    assert len(mgr._store.opened()) == before
    assert bluez.paused == []
    assert mgr._aux_path is None


@pytest.mark.asyncio
async def test_pressing_play_while_audio_lost_retries_recovery_with_a_cooldown():
    mgr = manager()
    connect_dev = FakeConnect()
    mgr.set_device_connect(connect_dev)
    await dj_with_audio(mgr)
    await mgr.on_transport_removed(DEV)
    await asyncio.sleep(0.2)
    assert connect_dev.calls == [DEV]

    await asyncio.sleep(0.35)
    await mgr.on_status_changed(DEV, "playing")
    await mgr.on_status_changed(DEV, "playing")
    await asyncio.sleep(0.02)

    assert connect_dev.calls == [DEV, DEV]


@pytest.mark.asyncio
async def test_audio_returning_mid_song_with_the_aux_free_regrants_and_records():
    aux = FakeAux()
    mgr = manager(aux)
    mgr.set_device_connect(FakeConnect())
    await dj_with_audio(mgr)
    await mgr.on_transport_removed(DEV)
    await asyncio.sleep(0.2)
    assert mgr._aux_path is None
    await mgr.on_status_changed(DEV, "playing")
    before = len(mgr._store.opened())

    await mgr.on_transport_state_changed(DEV, "active")
    await settle()
    await settle_aux()

    assert mgr._aux_path == DEV
    assert not mgr._sessions[DEV].audio_lost
    assert len(mgr._store.opened()) == before + 1
    assert aux.hears(MAC)


@pytest.mark.asyncio
async def test_a_waiting_phone_losing_its_transport_is_left_alone():
    mgr = manager()
    connect_dev = FakeConnect()
    mgr.set_device_connect(connect_dev)
    await dj_with_audio(mgr)
    await connect_other(mgr)
    await mgr.on_transport_state_changed(OTHER, "idle")

    await mgr.on_transport_removed(OTHER)
    await asyncio.sleep(0.2)

    assert connect_dev.calls == []
    assert mgr._aux_path == DEV
    assert not mgr._sessions[OTHER].audio_lost


@pytest.mark.asyncio
async def test_disconnecting_during_the_wait_cancels_it_cleanly():
    mgr = manager()
    connect_dev = FakeConnect()
    mgr.set_device_connect(connect_dev)
    await dj_with_audio(mgr)

    await mgr.on_transport_removed(DEV)
    await mgr.on_device_disconnected(DEV)
    await asyncio.sleep(0.2)

    assert connect_dev.calls == []
    assert DEV not in mgr._sessions


@pytest.mark.asyncio
async def test_without_device_connect_the_aux_is_still_released():
    mgr = manager()
    await dj_with_audio(mgr)

    await mgr.on_transport_removed(DEV)
    await asyncio.sleep(0.2)

    assert mgr._aux_path is None
    assert mgr._sessions[DEV].audio_lost
