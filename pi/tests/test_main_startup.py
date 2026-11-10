"""The beacon must come up whatever else is broken.

The listener is the only way to reach the box, and it used to open the outbox
and attach to BlueZ BEFORE it started beaconing - so a corrupt database page or
a bluetoothd that was not on the bus meant a three-second crash loop and a
speaker nobody could reach, with the wifi perfectly healthy.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from lockerroom import main as main_mod
from lockerroom.storage import open_store
from lockerroom.sync import FatalStoreError


class NullAux:
    async def route(self, mac):
        return None


class Relay:
    def __init__(self, mac=None):
        if mac == "boom":
            raise ValueError("bad cached target")
        self.target = mac
        self.runs = 0

    def on_target_changed(self, fn):
        pass

    async def on_disconnected(self):
        pass

    async def run(self):
        self.runs += 1
        await asyncio.sleep(3600)


def cfg(tmp_path):
    return SimpleNamespace(
        api_base_url="https://primary.example", api_fallback_urls=(), device_key="k",
        speaker_name="AuxGoat", relay_speaker_mac=None, db_path=tmp_path / "lockerroom.db",
        sync_interval_s=0.01,
    )


async def run_until(tmp_path, beaconed: asyncio.Event, **parts):
    async def beacon(cfg_, sessions, relay=None, pool=None):
        beaconed.set()
        await asyncio.sleep(3600)

    async def drain(cfg_, store, pool=None):
        await asyncio.sleep(3600)

    defaults = dict(aux_factory=NullAux, relay_factory=Relay, beacon=beacon, drain=drain,
                    retry_s=0.01)
    defaults.update(parts)
    task = asyncio.create_task(main_mod.run_listener(cfg(tmp_path), **defaults))
    await asyncio.wait_for(beaconed.wait(), 5)
    return task


async def stop(task):
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.fixture(autouse=True)
def no_real_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(main_mod.relaytarget, "read_cache", lambda *a, **k: None)
    from lockerroom.endpoints import HostPool

    monkeypatch.setattr(
        main_mod, "HostPool", lambda urls: HostPool(urls, state_path=tmp_path / "api-host")
    )


class TestTheBeaconComesUpAnyway:
    @pytest.mark.asyncio
    async def test_when_bluez_is_not_there(self, tmp_path):
        attempts = []

        class DeadWatcher:
            closed = 0

            def __init__(self, sink):
                attempts.append(self)

            async def pause(self, path):
                pass

            def close(self):
                DeadWatcher.closed += 1

            async def start(self):
                raise RuntimeError("org.bluez was not provided by any .service files")

        beaconed = asyncio.Event()
        task = await run_until(tmp_path, beaconed, watcher_factory=DeadWatcher)
        await asyncio.sleep(0.1)
        await stop(task)
        assert beaconed.is_set()
        assert len(attempts) >= 2, "the watcher was not retried"
        # A half-started watcher left connected would deliver signals twice.
        assert DeadWatcher.closed == len(attempts)

    @pytest.mark.asyncio
    async def test_and_the_watcher_attaches_once_bluez_returns(self, tmp_path):
        state = {"calls": 0, "started": 0}

        class FlakyWatcher:
            def __init__(self, sink):
                pass

            async def pause(self, path):
                pass

            def close(self):
                pass

            async def start(self):
                state["calls"] += 1
                if state["calls"] < 3:
                    raise RuntimeError("not yet")
                state["started"] += 1

        task = await run_until(tmp_path, asyncio.Event(), watcher_factory=FlakyWatcher)
        await asyncio.sleep(0.2)
        await stop(task)
        assert state == {"calls": 3, "started": 1}, "it must start exactly once"

    @pytest.mark.asyncio
    async def test_when_the_outbox_database_is_garbage(self, tmp_path):
        db = tmp_path / "lockerroom.db"
        db.write_bytes(b"not a database" * 500)

        class Watcher:
            def __init__(self, sink):
                pass

            async def pause(self, path):
                pass

            async def start(self):
                pass

        beaconed = asyncio.Event()
        task = await run_until(tmp_path, beaconed, watcher_factory=Watcher,
                               store_opener=open_store)
        await stop(task)
        assert beaconed.is_set()
        assert (tmp_path / "lockerroom.db.corrupt-0").exists()

    @pytest.mark.asyncio
    async def test_when_the_relay_cannot_be_built(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main_mod.relaytarget, "read_cache", lambda *a, **k: "boom")
        monkeypatch.setattr(main_mod.relaytarget, "resolve", lambda *a, **k: "boom")

        class Watcher:
            def __init__(self, sink):
                pass

            async def pause(self, path):
                pass

            async def start(self):
                pass

        beaconed = asyncio.Event()
        task = await run_until(tmp_path, beaconed, watcher_factory=Watcher)
        await stop(task)
        assert beaconed.is_set()

    @pytest.mark.asyncio
    async def test_when_the_drain_keeps_crashing(self, tmp_path):
        crashes = []

        async def drain(cfg_, store, pool=None):
            crashes.append(1)
            raise RuntimeError("drain bug")

        class Watcher:
            def __init__(self, sink):
                pass

            async def pause(self, path):
                pass

            async def start(self):
                pass

        beaconed = asyncio.Event()
        task = await run_until(tmp_path, beaconed, watcher_factory=Watcher, drain=drain)
        await asyncio.sleep(0.1)
        assert not task.done(), "a crashing drain took the listener down"
        await stop(task)
        assert len(crashes) >= 2


class TestTheDeliberateExits:
    @pytest.mark.asyncio
    async def test_a_dead_beacon_loop_ends_the_process(self, tmp_path):
        """Limping on unreachable is the one outcome worse than a restart."""
        async def beacon(cfg_, sessions, relay=None, pool=None):
            raise RuntimeError("beacon loop bug")

        class Watcher:
            def __init__(self, sink):
                pass

            async def pause(self, path):
                pass

            async def start(self):
                pass

        with pytest.raises(RuntimeError, match="beacon loop bug"):
            await asyncio.wait_for(main_mod.run_listener(
                cfg(tmp_path), aux_factory=NullAux, relay_factory=Relay,
                watcher_factory=Watcher, beacon=beacon, retry_s=0.01,
                drain=lambda *a, **k: asyncio.sleep(3600)), 5)

    @pytest.mark.asyncio
    async def test_a_damaged_database_found_later_ends_the_process(self, tmp_path):
        async def drain(cfg_, store, pool=None):
            raise FatalStoreError("malformed")

        class Watcher:
            def __init__(self, sink):
                pass

            async def pause(self, path):
                pass

            async def start(self):
                pass

        with pytest.raises(FatalStoreError):
            await asyncio.wait_for(main_mod.run_listener(
                cfg(tmp_path), aux_factory=NullAux, relay_factory=Relay,
                watcher_factory=Watcher, drain=drain, retry_s=0.01,
                beacon=lambda *a, **k: asyncio.sleep(3600)), 5)


def test_httpx_request_logging_is_quietened(tmp_path):
    """At a 10s beacon it would write 8,600 lines a day into listener.log."""
    import logging

    root = logging.getLogger()
    before = list(root.handlers)
    try:
        main_mod.setup_logging(tmp_path / "log" / "listener.log")
        assert logging.getLogger("httpx").level == logging.WARNING
    finally:
        for h in list(root.handlers):
            if h not in before:
                root.removeHandler(h)
                h.close()


def test_an_unwritable_log_path_does_not_stop_startup(tmp_path):
    import logging

    blocker = tmp_path / "file"
    blocker.write_text("x")
    root = logging.getLogger()
    before = list(root.handlers)
    try:
        main_mod.setup_logging(blocker / "listener.log")   # must not raise
    finally:
        for h in list(root.handlers):
            if h not in before:
                root.removeHandler(h)
                h.close()
