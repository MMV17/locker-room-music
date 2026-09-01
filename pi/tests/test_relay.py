"""Owns the outbound connection to the speaker. Nothing else.

It must never touch aux arbitration, sessions or play data — that separation is
what makes the 2026-08-23 failure structurally impossible to repeat, rather
than merely fixed.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.relay import RelayManager  # noqa: E402

MAC = "78:66:F3:1C:9D:B6"


class FakeConnect:
    def __init__(self, results=()):
        self.results = list(results)
        self.calls: list[str] = []

    async def __call__(self, mac):
        self.calls.append(mac)
        return self.results.pop(0) if self.results else True


class FakeRoute:
    def __init__(self):
        self.calls = 0

    async def __call__(self):
        self.calls += 1


class FakePair:
    def __init__(self, results=()):
        self.results = list(results)
        self.calls: list[str] = []

    async def __call__(self, mac):
        self.calls.append(mac)
        return self.results.pop(0) if self.results else True


class FakeDisconnect:
    def __init__(self):
        self.calls: list[str] = []

    async def __call__(self, mac):
        self.calls.append(mac)


def mk(tmp_path, connect=None, route=None, mac=MAC):
    """Pairing joined the connect path when the target became settable at
    runtime, so every manager needs a fake pair — otherwise these tests reach
    the real bluetoothctl."""
    return RelayManager(
        mac,
        target_path=tmp_path / "relay-target",
        connect=connect or FakeConnect(),
        route=route or FakeRoute(),
        pair=FakePair(),
        disconnect=FakeDisconnect(),
    )


def test_a_malformed_mac_is_refused_at_construction(tmp_path):
    """It becomes an argv element for bluetoothctl."""
    with pytest.raises(ValueError, match="not a MAC address"):
        mk(tmp_path, mac="not-a-mac; rm -rf /")


@pytest.mark.asyncio
async def test_writes_the_target_and_reroutes_on_connect(tmp_path):
    c, r = FakeConnect([True]), FakeRoute()
    m = mk(tmp_path, c, r)
    assert await m.ensure_connected() is True
    assert (tmp_path / "relay-target").read_text().strip() == MAC
    assert r.calls == 1
    assert c.calls == [MAC]


@pytest.mark.asyncio
async def test_failed_connect_leaves_no_target(tmp_path):
    """No target file is what makes audio-route fall back to a wired output."""
    c, r = FakeConnect([False]), FakeRoute()
    m = mk(tmp_path, c, r)
    assert await m.ensure_connected() is False
    assert not (tmp_path / "relay-target").exists()
    assert r.calls == 0, "nothing changed, so nothing should have been rerouted"


@pytest.mark.asyncio
async def test_a_connect_that_raises_is_survived(tmp_path):
    class Boom:
        async def __call__(self, mac):
            raise RuntimeError("bluetoothctl went missing")

    m = mk(tmp_path, Boom(), FakeRoute())
    assert await m.ensure_connected() is False
    assert not (tmp_path / "relay-target").exists()


@pytest.mark.asyncio
async def test_already_connected_does_not_reroute_again(tmp_path):
    """A needless reroute restarts the player and cuts the music."""
    c, r = FakeConnect([True, True]), FakeRoute()
    m = mk(tmp_path, c, r)
    await m.ensure_connected()
    await m.ensure_connected()
    assert r.calls == 1
    assert len(c.calls) == 1, "must not re-issue connect when already live"


@pytest.mark.asyncio
async def test_disconnect_removes_the_target_and_reroutes(tmp_path):
    c, r = FakeConnect([True]), FakeRoute()
    m = mk(tmp_path, c, r)
    await m.ensure_connected()
    await m.on_disconnected()
    assert not (tmp_path / "relay-target").exists(), \
        "a stale target routes audio into a dead link — silence, all units green"
    assert r.calls == 2


@pytest.mark.asyncio
async def test_disconnect_when_never_connected_is_a_no_op(tmp_path):
    r = FakeRoute()
    m = mk(tmp_path, FakeConnect(), r)
    await m.on_disconnected()
    assert r.calls == 0


@pytest.mark.asyncio
async def test_reconnects_after_a_disconnect(tmp_path):
    """A speaker switched off and back on must rejoin with nobody present."""
    c, r = FakeConnect([True, True]), FakeRoute()
    m = mk(tmp_path, c, r)
    await m.ensure_connected()
    await m.on_disconnected()
    assert await m.ensure_connected() is True
    assert (tmp_path / "relay-target").read_text().strip() == MAC
    assert len(c.calls) == 2


@pytest.mark.asyncio
async def test_target_is_uppercased(tmp_path):
    """audio-route.sh compares this against what it wrote; case must not drift."""
    m = mk(tmp_path, FakeConnect([True]), FakeRoute(), mac=MAC.lower())
    await m.ensure_connected()
    assert (tmp_path / "relay-target").read_text().strip() == MAC


@pytest.mark.asyncio
async def test_a_reroute_that_raises_does_not_lose_the_connection(tmp_path):
    """audio-route.sh failing is bad, but forgetting we are connected is worse:
    it would re-issue connect forever against an already-connected speaker."""
    class BadRoute:
        async def __call__(self):
            raise RuntimeError("audio-route.sh missing")

    c = FakeConnect([True])
    m = mk(tmp_path, c, BadRoute())
    assert await m.ensure_connected() is True
    assert (tmp_path / "relay-target").read_text().strip() == MAC
    await m.ensure_connected()
    assert len(c.calls) == 1


# --------------------------------------------------------------------------- #
# Changing the target at runtime, which is what the Admin screen does.
# --------------------------------------------------------------------------- #

MAC2 = "AA:BB:CC:DD:EE:FF"



def mk2(tmp_path, connect=None, route=None, pair=None, disconnect=None, mac=None):
    return RelayManager(
        mac,
        target_path=tmp_path / "relay-target",
        connect=connect or FakeConnect(),
        route=route or FakeRoute(),
        pair=pair or FakePair(),
        disconnect=disconnect or FakeDisconnect(),
    )


def test_can_be_built_with_no_target_at_all(tmp_path):
    """A box that has never been given a speaker still has a relay manager, so
    that one can be chosen later without restarting the listener."""
    m = mk2(tmp_path)
    assert m.target is None
    assert m.connected is False


@pytest.mark.asyncio
async def test_no_target_means_nothing_is_attempted(tmp_path):
    c = FakeConnect()
    m = mk2(tmp_path, connect=c)
    assert await m.ensure_connected() is False
    assert c.calls == []


@pytest.mark.asyncio
async def test_setting_a_target_pairs_trusts_and_connects(tmp_path):
    c, p = FakeConnect([True]), FakePair([True])
    m = mk2(tmp_path, connect=c, pair=p)
    assert await m.set_target(MAC) is True
    assert p.calls == [MAC], "a speaker chosen from the UI has never been paired"
    assert c.calls == [MAC]
    assert (tmp_path / "relay-target").read_text().strip() == MAC


@pytest.mark.asyncio
async def test_setting_the_same_target_is_a_no_op(tmp_path):
    """Otherwise every beacon would tear down and rebuild a working link, which
    is a gap in the music once a minute."""
    c, p, r = FakeConnect([True]), FakePair([True]), FakeRoute()
    m = mk2(tmp_path, connect=c, pair=p, route=r)
    await m.set_target(MAC)
    before = (len(c.calls), len(p.calls), r.calls)
    assert await m.set_target(MAC) is True
    assert (len(c.calls), len(p.calls), r.calls) == before


@pytest.mark.asyncio
async def test_switching_speakers_drops_the_old_one_before_trying_the_new(tmp_path):
    """Order is the whole safety property. Clearing the target and rerouting
    FIRST means a failed connection leaves the box on the jack - audible and
    recoverable - rather than pointing at a speaker that never answered, which
    is silence with every unit green."""
    order: list[str] = []

    class Disc(FakeDisconnect):
        async def __call__(self, mac):
            order.append(f"disconnect:{mac}")
            await super().__call__(mac)

    class Route(FakeRoute):
        async def __call__(self):
            order.append("route:" + ("target" if (tmp_path / "relay-target").exists() else "no-target"))
            await super().__call__()

    class Conn(FakeConnect):
        async def __call__(self, mac):
            order.append(f"connect:{mac}")
            return await super().__call__(mac)

    m = mk2(tmp_path, connect=Conn(), route=Route(), disconnect=Disc())
    await m.set_target(MAC)
    order.clear()
    await m.set_target(MAC2)

    assert order[0] == f"disconnect:{MAC}"
    assert order[1] == "route:no-target", "target must be gone before the reroute"
    assert order.index(f"connect:{MAC2}") > 1


@pytest.mark.asyncio
async def test_clearing_the_target_falls_back_to_wired(tmp_path):
    m = mk2(tmp_path)
    await m.set_target(MAC)
    assert await m.set_target(None) is True
    assert m.target is None
    assert m.connected is False
    assert not (tmp_path / "relay-target").exists()


@pytest.mark.asyncio
async def test_a_malformed_target_is_refused_without_disturbing_the_live_one(tmp_path):
    """The MAC becomes an argv element. A compromised server must not be able
    to change what is playing, let alone what is executed."""
    m = mk2(tmp_path)
    await m.set_target(MAC)
    with pytest.raises(ValueError, match="not a MAC address"):
        await m.set_target("$(reboot)")
    assert m.target == MAC
    assert m.connected is True
    assert (tmp_path / "relay-target").read_text().strip() == MAC


@pytest.mark.asyncio
async def test_a_failed_pair_is_reported_and_leaves_wired_output(tmp_path):
    """The speaker was not in pairing mode. The screen has to be able to say
    that rather than showing a selection that silently does nothing."""
    m = mk2(tmp_path, pair=FakePair([False]))
    assert await m.set_target(MAC) is False
    assert m.target == MAC, "the intent is kept - it is retried on the run loop"
    assert m.connected is False
    assert not (tmp_path / "relay-target").exists()
    assert m.last_error and "pair" in m.last_error.lower()


@pytest.mark.asyncio
async def test_a_failed_connect_after_a_good_pair_is_reported(tmp_path):
    m = mk2(tmp_path, connect=FakeConnect([False]), pair=FakePair([True]))
    assert await m.set_target(MAC) is False
    assert m.last_error is not None


@pytest.mark.asyncio
async def test_a_successful_connect_clears_a_previous_error(tmp_path):
    m = mk2(tmp_path, connect=FakeConnect([False, True]), pair=FakePair([True, True]))
    await m.set_target(MAC)
    assert m.last_error is not None
    assert await m.ensure_connected() is True
    assert m.last_error is None


@pytest.mark.asyncio
async def test_reconnecting_does_not_pair_again(tmp_path):
    """Re-pairing a speaker we already paired is noise, and on some speakers it
    drops the existing link to do it."""
    p = FakePair([True])
    m = mk2(tmp_path, connect=FakeConnect([True, True]), pair=p)
    await m.set_target(MAC)
    await m.on_disconnected()
    await m.ensure_connected()
    assert p.calls == [MAC]


@pytest.mark.asyncio
async def test_state_survives_a_disconnect_so_the_screen_can_explain_it(tmp_path):
    m = mk2(tmp_path)
    await m.set_target(MAC)
    await m.on_disconnected()
    assert m.target == MAC
    assert m.connected is False
