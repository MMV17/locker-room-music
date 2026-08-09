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

from lockerroom.aux import AuxRouter  # noqa: E402


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
async def test_routing_none_clears_the_filter_entirely(tmp_path):
    """None means "play whatever is connected", which is the right answer with
    fewer than two phones — one phone cannot mix with anything.

    An EMPTY value specifically: the drop-in passes `$AUX_MAC` unbracketed, and
    systemd drops an empty unbracketed variable rather than passing an empty
    argument, so this lands on plain `bluealsa-aplay -S`."""
    (tmp_path / "aux.env").write_text("AUX_MAC=5C:AD:BA:F0:B2:61\n")
    restart = FakeRestart()
    r = router(tmp_path, restart)

    await r.route(None)

    assert (tmp_path / "aux.env").read_text().strip() == "AUX_MAC="
    assert restart.calls == 1


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


@pytest.mark.asyncio
async def test_a_fresh_router_does_not_re_point_a_player_that_is_already_right(tmp_path):
    """A listener restart must not look like a change.

    Assuming the live filter was unknown meant the first route() after every
    restart re-pointed a player that was already correct — and a needless
    restart is not free: it destroys the A2DP transport of any phone connecting
    at that moment, which is what took the speaker down on 2026-08-09.
    """
    (tmp_path / "aux.env").write_text("AUX_MAC=5C:AD:BA:F0:B2:61\n")
    restart = FakeRestart()
    r = router(tmp_path, restart)

    await r.route("5C:AD:BA:F0:B2:61")

    assert restart.calls == 0


@pytest.mark.asyncio
async def test_no_env_file_reads_as_no_filter(tmp_path):
    """Which is what the systemd drop-in falls back to, so routing None on a
    fresh boot is already true and costs no restart."""
    restart = FakeRestart()
    r = router(tmp_path, restart)

    await r.route(None)

    assert restart.calls == 0
