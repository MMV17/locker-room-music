"""The thing that decides whose audio actually reaches the speaker.

`bluealsa-aplay` plays every connected A2DP source unless it is given a MAC
allowlist, which is why two phones used to mix. This routes exactly one.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.aux import NOBODY, AuxRouter  # noqa: E402


class FakeRestart:
    def __init__(self, fails: bool = False):
        self.calls = 0
        self.fails = fails

    async def __call__(self) -> None:
        self.calls += 1
        if self.fails:
            raise RuntimeError("systemctl went missing")


def router(tmp_path, restart):
    return AuxRouter(env_path=tmp_path / "aux.env", restart=restart)


@pytest.mark.asyncio
async def test_routing_a_phone_writes_its_mac_and_restarts_the_player(tmp_path):
    restart = FakeRestart()
    r = router(tmp_path, restart)

    await r.route("5C:AD:BA:F0:B2:61")

    assert (tmp_path / "aux.env").read_text().strip() == "AUX_MAC=5C:AD:BA:F0:B2:61"
    assert restart.calls == 1


@pytest.mark.asyncio
async def test_routing_nobody_writes_an_address_no_phone_can_have(tmp_path):
    """Not 00:00:00:00:00:00 — bluealsa-aplay reads that as 'any device', which
    is the exact opposite of what routing nobody means, and would have turned
    silence into everybody-at-once."""
    restart = FakeRestart()
    r = router(tmp_path, restart)

    await r.route(None)

    assert (tmp_path / "aux.env").read_text().strip() == f"AUX_MAC={NOBODY}"
    # Locally-administered bit set: no manufacturer-assigned phone address can
    # collide with it.
    assert int(NOBODY.split(":")[0], 16) & 0b10 == 0b10


@pytest.mark.asyncio
async def test_routing_the_same_phone_twice_does_not_restart_again(tmp_path):
    """A restart is cheap but not free, and a phone that flaps its connection
    would otherwise cycle the audio player every few seconds."""
    restart = FakeRestart()
    r = router(tmp_path, restart)

    await r.route("5C:AD:BA:F0:B2:61")
    await r.route("5C:AD:BA:F0:B2:61")
    await r.route("5c:ad:ba:f0:b2:61")  # same phone, different casing

    assert restart.calls == 1


@pytest.mark.asyncio
async def test_a_failed_restart_does_not_propagate(tmp_path):
    """Losing the audio player is bad; taking the whole listener down with it,
    so no play is recorded either, is worse."""
    restart = FakeRestart(fails=True)
    r = router(tmp_path, restart)

    await r.route("5C:AD:BA:F0:B2:61")  # must not raise


@pytest.mark.asyncio
async def test_a_failed_restart_is_retried_by_the_next_route(tmp_path):
    """Without this the router would believe the failed MAC was live and skip
    the restart forever, leaving the speaker permanently on the wrong phone."""
    restart = FakeRestart(fails=True)
    r = router(tmp_path, restart)

    await r.route("5C:AD:BA:F0:B2:61")
    restart.fails = False
    await r.route("5C:AD:BA:F0:B2:61")

    assert restart.calls == 2


@pytest.mark.asyncio
async def test_the_env_file_directory_is_created(tmp_path):
    restart = FakeRestart()
    r = AuxRouter(env_path=tmp_path / "nested" / "aux.env", restart=restart)

    await r.route("5C:AD:BA:F0:B2:61")

    assert (tmp_path / "nested" / "aux.env").exists()
