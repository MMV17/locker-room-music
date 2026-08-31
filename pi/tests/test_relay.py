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


def mk(tmp_path, connect=None, route=None, mac=MAC):
    return RelayManager(
        mac,
        target_path=tmp_path / "relay-target",
        connect=connect or FakeConnect(),
        route=route or FakeRoute(),
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
