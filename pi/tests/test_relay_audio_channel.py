"""The silent relay: connected to the speaker, but its A2DP channel is gone.
Seen 2026-11-13 - "Couldn't get BlueALSA PCM: PCM not found" every 5s while
the relay reported connected."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.relay as relay_mod  # noqa: E402
from lockerroom.relay import RelayManager  # noqa: E402

MAC = "78:66:F3:1C:9D:B6"


class Rec:
    def __init__(self, result=True):
        self.calls: list = []
        self.result = result

    async def __call__(self, *a):
        self.calls.append(a)
        return self.result


class AudioOk:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = 0

    async def __call__(self, mac):
        self.calls += 1
        return self.answers.pop(0) if self.answers else True


def mk(tmp_path, audio_ok):
    connect, route, disconnect = Rec(True), Rec(None), Rec(None)
    mgr = RelayManager(
        MAC, target_path=tmp_path / "relay-target", connect=connect, route=route,
        pair=Rec(True), disconnect=disconnect, audio_ok=audio_ok, recheck_s=0.01,
    )
    return mgr, connect, route, disconnect


@pytest.mark.asyncio
async def test_a_live_relay_with_its_audio_channel_is_left_alone(tmp_path):
    mgr, connect, _, disconnect = mk(tmp_path, AudioOk([True]))
    await mgr.ensure_connected()
    assert len(connect.calls) == 1

    assert await mgr.ensure_connected()
    assert len(connect.calls) == 1 and disconnect.calls == []


@pytest.mark.asyncio
async def test_a_missing_channel_is_reconnected_fresh(tmp_path):
    mgr, connect, route, disconnect = mk(tmp_path, AudioOk([False, False]))
    await mgr.ensure_connected()                 # first connect

    assert await mgr.ensure_connected()

    assert disconnect.calls == [(MAC,)]
    assert len(connect.calls) == 2               # reconnected straight away
    assert mgr.connected
    assert (tmp_path / "relay-target").read_text().strip() == MAC
    # wired in between, relay again after: two reroutes beyond the first
    assert len(route.calls) == 3


@pytest.mark.asyncio
async def test_a_channel_missing_for_one_look_only_is_not_kicked(tmp_path):
    """Renegotiating at the moment of the check is not 'gone'."""
    mgr, connect, _, disconnect = mk(tmp_path, AudioOk([False, True]))
    await mgr.ensure_connected()

    assert await mgr.ensure_connected()
    assert disconnect.calls == [] and len(connect.calls) == 1


@pytest.mark.asyncio
async def test_a_check_that_blows_up_never_disconnects(tmp_path):
    async def boom(mac):
        raise RuntimeError("bluealsa-cli exploded")
    mgr, connect, _, disconnect = mk(tmp_path, boom)
    await mgr.ensure_connected()

    assert await mgr.ensure_connected()
    assert disconnect.calls == []


@pytest.mark.asyncio
async def test_a_failed_reconnect_lands_on_wired(tmp_path):
    mgr, connect, _, disconnect = mk(tmp_path, AudioOk([False, False]))
    await mgr.ensure_connected()
    connect.result = False

    assert not await mgr.ensure_connected()
    assert not mgr.connected
    assert not (tmp_path / "relay-target").exists()


@pytest.mark.asyncio
async def test_the_real_check_reads_bluealsa_cli(tmp_path, monkeypatch):
    out = (
        "/org/bluealsa/hci0/dev_5C_AD_BA_F0_B2_61/a2dpsnk/source\n"
        "/org/bluealsa/hci0/dev_78_66_F3_1C_9D_B6/a2dpsrc/sink\n"
    )

    class Proc:
        returncode = 0

    async def fake_exec(*argv, **kw):
        assert argv[:2] == ("bluealsa-cli", "list-pcms")
        return Proc()

    async def fake_comm(proc, timeout):
        return (fake_comm.out.encode(), b"")

    monkeypatch.setattr(relay_mod.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(relay_mod, "_communicate", fake_comm)

    fake_comm.out = out
    assert await relay_mod._audio_channel_ok(MAC)
    fake_comm.out = "/org/bluealsa/hci0/dev_5C_AD_BA_F0_B2_61/a2dpsnk/source\n"
    assert not await relay_mod._audio_channel_ok(MAC)   # the 2026-11-13 state


@pytest.mark.asyncio
async def test_the_real_check_says_fine_when_it_cannot_run(monkeypatch):
    async def missing(*a, **k):
        raise FileNotFoundError("bluealsa-cli")
    monkeypatch.setattr(relay_mod.asyncio, "create_subprocess_exec", missing)
    assert await relay_mod._audio_channel_ok(MAC)
