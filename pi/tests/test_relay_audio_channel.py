"""The silent relay: connected to the speaker, but the player cannot open it.
Seen 2026-11-13 - "Couldn't open ALSA playback PCM" every 5s while the relay
reported connected. Keyed on the player's own failure; the first version used
bluealsa-cli's PCM list, which was empty while music played, and reconnected a
working speaker every 30s."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.relay as relay_mod  # noqa: E402
from lockerroom.relay import RelayManager  # noqa: E402

MAC = "78:66:F3:1C:9D:B6"


@pytest.fixture(autouse=True)
def kick_on(monkeypatch):
    monkeypatch.setattr(relay_mod, "RELAY_AUDIO_KICK", True)


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


# Verbatim from the 2026-11-13 22:40 report, the real failure.
FAILING = """\
aplay.c:732: Opening ALSA playback PCM: name=bluealsa:DEV=78:66:F3:1C:9D:B6,PROFILE=a2dp channels=2 rate=44100
[22333] D: bluealsa-pcm.c:1538: Getting BlueALSA PCM: PLAYBACK 78:66:F3:1C:9D:B6 a2dp
ALSA lib bluealsa-pcm.c:1542:(_snd_pcm_bluealsa_open) Couldn't get BlueALSA PCM: PCM not found
aplay.c:736: Couldn't open ALSA playback PCM: Open PCM: No such device
aplay.c:732: Opening ALSA playback PCM: name=bluealsa:DEV=78:66:F3:1C:9D:B6,PROFILE=a2dp channels=2 rate=44100
aplay.c:736: Couldn't open ALSA playback PCM: Open PCM: No such device
aplay.c:732: Opening ALSA playback PCM: name=bluealsa:DEV=78:66:F3:1C:9D:B6,PROFILE=a2dp channels=2 rate=44100
aplay.c:736: Couldn't open ALSA playback PCM: Open PCM: No such device
"""
# Verbatim from the 23:03 report: music playing, the player quiet.
HEALTHY = """\
aplay.c:1320: Starting main loop
aplay.c:904: Creating IO worker 5C:AD:BA:F0:B2:61
aplay.c:577: Opening BlueALSA source PCM: /org/bluealsa/hci0/dev_5C_AD_BA_F0_B2_61/a2dpsnk/source
aplay.c:603: Starting IO loop
"""


def test_the_real_failure_is_recognised():
    assert relay_mod.player_failing(MAC, FAILING)


def test_a_playing_box_is_not_a_failure():
    """The case the first version got wrong: music playing, nothing failing."""
    assert not relay_mod.player_failing(MAC, HEALTHY)
    assert not relay_mod.player_failing(MAC, "")


def test_one_or_two_failures_while_settling_are_not_enough():
    two = "\n".join(FAILING.splitlines()[:6])
    assert not relay_mod.player_failing(MAC, two)


def test_a_busy_speaker_during_a_handover_does_not_count():
    """A handover restarts the player; the new one can find the speaker still
    held by the old one. That is not the speaker being gone."""
    busy = FAILING.replace("Open PCM: No such device", "Open PCM: Device or resource busy")
    busy = "\n".join(l for l in busy.splitlines() if "PCM not found" not in l)
    assert not relay_mod.player_failing(MAC, busy)


def test_failures_aimed_at_another_device_do_not_count():
    other = FAILING.replace("78:66:F3:1C:9D:B6", "AA:BB:CC:DD:EE:FF")
    assert not relay_mod.player_failing(MAC, other)


@pytest.mark.asyncio
async def test_the_real_check_reads_the_players_journal(monkeypatch):
    seen = {}

    class Proc:
        returncode = 0

    async def fake_exec(*argv, **kw):
        seen["argv"] = argv
        return Proc()

    async def fake_comm(proc, timeout):
        return (fake_comm.out.encode(), b"")

    monkeypatch.setattr(relay_mod.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(relay_mod, "_communicate", fake_comm)

    fake_comm.out = FAILING
    assert not await relay_mod._player_reaches_speaker(MAC)
    assert seen["argv"][:3] == ("journalctl", "-u", "bluealsa-aplay")
    fake_comm.out = HEALTHY
    assert await relay_mod._player_reaches_speaker(MAC)


@pytest.mark.asyncio
async def test_the_real_check_says_fine_when_it_cannot_run(monkeypatch):
    async def missing(*a, **k):
        raise FileNotFoundError("journalctl")
    monkeypatch.setattr(relay_mod.asyncio, "create_subprocess_exec", missing)
    assert await relay_mod._player_reaches_speaker(MAC)


@pytest.mark.asyncio
async def test_off_in_production_it_never_disconnects(tmp_path, monkeypatch):
    monkeypatch.setattr(relay_mod, "RELAY_AUDIO_KICK", False)
    mgr, connect, _, disconnect = mk(tmp_path, AudioOk([False, False, False]))
    await mgr.ensure_connected()
    assert await mgr.ensure_connected()
    assert await mgr.ensure_connected()
    assert disconnect.calls == [] and len(connect.calls) == 1


def test_the_switch_is_on_in_the_source():
    src = Path(relay_mod.__file__).read_text()
    assert "\nRELAY_AUDIO_KICK = True\n" in src


@pytest.mark.asyncio
async def test_a_speaker_that_reconnects_by_itself_is_adopted_at_once(tmp_path):
    """2026-11-13 14:09:06: the JBL reconnected on its own while the relay's
    connect failed 'already in progress'; output stayed on the jack ~30s."""
    mgr, connect, route, _ = mk(tmp_path, AudioOk([]))
    assert not mgr.connected
    await mgr.on_connected()
    assert mgr.connected and len(connect.calls) == 1 and len(route.calls) == 1
    await mgr.on_connected()                     # already live: nothing more
    assert len(connect.calls) == 1
