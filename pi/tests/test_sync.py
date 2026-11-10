"""The outbox drain: never lose a play, never block behind one, and follow the
host pool when a hostname dies."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace

import httpx
import pytest

from lockerroom import sync
from lockerroom.endpoints import HostPool
from lockerroom.storage import Store, open_store

PRIMARY = "https://old-primary.example"
FALLBACK = "https://fallback.example"


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "outbox.db")


def pool(tmp_path, urls=(PRIMARY, FALLBACK)):
    return HostPool(urls, state_path=tmp_path / "api-host")


async def fill(store, n=3):
    for i in range(n):
        await store.enqueue(f"row-{i}", "POST", "/api/plays", {"play_id": f"p{i}"})
        await asyncio.sleep(0.002)   # distinct created_at, so order is defined


def pending(store) -> list[str]:
    cur = store._conn.execute(
        "SELECT id FROM outbox WHERE synced_at IS NULL ORDER BY created_at")
    return [r[0] for r in cur.fetchall()]


def due(store) -> list[str]:
    return [r.id for r in asyncio.get_event_loop().run_until_complete(store.due_rows())]


def client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=5.0)


class TestWhatCountsAsSynced:
    @pytest.mark.asyncio
    async def test_ok_true_from_our_worker_marks_the_row_synced(self, store, tmp_path):
        await fill(store)
        seen = []

        def handler(request):
            seen.append(json.loads(request.content)["play_id"])
            return httpx.Response(200, json={"ok": True})

        async with client(handler) as c:
            await sync._drain_once(c, store, pool(tmp_path))
        assert seen == ["p0", "p1", "p2"], "rows were not sent oldest first"
        assert pending(store) == []

    @pytest.mark.asyncio
    async def test_a_200_from_a_filter_page_does_not_lose_the_play(self, store, tmp_path):
        """This used to mark the row synced, and the play was gone for good."""
        await fill(store)
        async with client(lambda r: httpx.Response(200, text="<html>blocked</html>")) as c:
            await sync._drain_once(c, store, pool(tmp_path))
        assert pending(store) == ["row-0", "row-1", "row-2"]

    @pytest.mark.asyncio
    async def test_a_rejection_backs_off_hard_but_keeps_the_row(self, store, tmp_path):
        await fill(store, 2)

        def handler(request):
            if json.loads(request.content)["play_id"] == "p0":
                return httpx.Response(404, json={"error": "play not found"})
            return httpx.Response(200, json={"ok": True})

        p = pool(tmp_path)
        async with client(handler) as c:
            await sync._drain_once(c, store, p)
        # The poison row waits; the row behind it went through.
        assert pending(store) == ["row-0"]
        assert p.current == PRIMARY, "a 404 from our own Worker moved the host"

    @pytest.mark.asyncio
    async def test_a_worker_exception_on_one_row_does_not_block_the_rest(self, store, tmp_path):
        """A 500 with a text body is the Worker failing on THIS row."""
        await fill(store, 3)

        def handler(request):
            if json.loads(request.content)["play_id"] == "p0":
                return httpx.Response(500, text="Internal Server Error")
            return httpx.Response(200, json={"ok": True})

        p = pool(tmp_path)
        async with client(handler) as c:
            await sync._drain_once(c, store, p)
        assert pending(store) == ["row-0"]
        assert p.current == PRIMARY


class TestAHostThatIsDown:
    @pytest.mark.asyncio
    async def test_the_first_transport_error_ends_the_pass(self, store, tmp_path):
        """A18. It used to walk all fifty rows at ten seconds each."""
        await fill(store, 5)
        calls = []

        def handler(request):
            calls.append(1)
            raise httpx.ConnectError("down", request=request)

        async with client(handler) as c:
            await sync._drain_once(c, store, pool(tmp_path))
        assert len(calls) == 1
        assert pending(store) == [f"row-{i}" for i in range(5)]

    @pytest.mark.asyncio
    async def test_every_due_row_waits_together_so_order_survives(self, store, tmp_path):
        """A close must never come due ahead of its own create."""
        await fill(store, 3)

        def down(request):
            raise httpx.ConnectError("down", request=request)

        async with client(down) as c:
            await sync._drain_once(c, store, pool(tmp_path))
        rows = store._conn.execute(
            "SELECT id, next_attempt_at, attempts FROM outbox ORDER BY created_at").fetchall()
        assert len({r[1] for r in rows}) == 1, "rows were pushed back to different moments"
        assert [r[2] for r in rows] == [1, 0, 0], "only the row that was tried counts a retry"
        assert await store.due_rows() == []

    @pytest.mark.asyncio
    async def test_the_drain_follows_the_pool_to_the_fallback(self, store, tmp_path, monkeypatch):
        """The dead-primary path, end to end, for the outbox."""
        monkeypatch.setattr(sync, "BACKOFF_BASE_S", 0)
        await fill(store, 2)
        hosts = []

        def handler(request):
            host = f"https://{request.url.host}"
            if host == PRIMARY:
                raise httpx.ConnectError("retired", request=request)
            hosts.append(host)
            return httpx.Response(200, json={"ok": True})

        p = pool(tmp_path)
        async with client(handler) as c:
            for _ in range(4):
                await sync._drain_once(c, store, p)
        assert pending(store) == []
        assert set(hosts) == {FALLBACK}
        assert (tmp_path / "api-host").read_text().strip() == FALLBACK

    @pytest.mark.asyncio
    async def test_the_beacons_failures_move_the_drain_too(self, store, tmp_path):
        """One pool, shared: neither loop has to find out alone."""
        await fill(store, 1)
        p = pool(tmp_path)
        for _ in range(3):
            p.failure(PRIMARY)          # what three failed beacons do
        hosts = []

        def handler(request):
            hosts.append(f"https://{request.url.host}")
            return httpx.Response(200, json={"ok": True})

        async with client(handler) as c:
            await sync._drain_once(c, store, p)
        assert hosts == [FALLBACK]


class TestADamagedDatabase:
    def test_garbage_is_moved_aside_never_deleted(self, tmp_path):
        db = tmp_path / "lockerroom.db"
        db.write_bytes(b"this is not a sqlite database" * 100)
        store = open_store(db)
        assert store.degraded is None
        asyncio.run(store.enqueue("a", "POST", "/x", {}))
        aside = tmp_path / "lockerroom.db.corrupt-0"
        assert aside.read_bytes().startswith(b"this is not a sqlite")

    def test_a_damaged_body_is_caught_at_startup(self, tmp_path):
        db = tmp_path / "lockerroom.db"
        first = Store(db)

        async def fill_big():
            for i in range(300):
                await first.enqueue(f"id{i}", "POST", "/x", {"a": "b" * 200})

        asyncio.run(fill_big())
        first._conn.close()
        raw = db.read_bytes()
        db.write_bytes(raw[:4096] + b"\xff" * (len(raw) - 4096))

        store = open_store(db)
        assert (tmp_path / "lockerroom.db.corrupt-0").exists()
        assert asyncio.run(store.due_rows()) == []

    def test_a_second_corruption_does_not_overwrite_the_first(self, tmp_path):
        db = tmp_path / "lockerroom.db"
        for n in range(2):
            db.write_bytes(b"garbage %d" % n * 50)
            open_store(db)._conn.close()
            db.unlink()
        assert (tmp_path / "lockerroom.db.corrupt-0").exists()
        assert (tmp_path / "lockerroom.db.corrupt-1").exists()

    def test_an_unusable_path_falls_back_to_memory_and_says_so(self, tmp_path):
        blocker = tmp_path / "not-a-dir"
        blocker.write_text("a file where the directory should be")
        store = open_store(blocker / "lockerroom.db")
        assert store.degraded
        asyncio.run(store.enqueue("a", "POST", "/x", {}))   # and it still works

    def test_a_healthy_database_is_left_exactly_alone(self, tmp_path):
        db = tmp_path / "lockerroom.db"
        first = Store(db)
        asyncio.run(first.enqueue("keep-me", "POST", "/x", {}))
        first._conn.close()
        store = open_store(db)
        assert [r.id for r in asyncio.run(store.due_rows())] == ["keep-me"]
        assert not list(tmp_path.glob("*.corrupt-*"))

    @pytest.mark.asyncio
    async def test_repeated_query_failures_flag_the_file_and_stop_the_listener(
        self, tmp_path, monkeypatch
    ):
        db = tmp_path / "lockerroom.db"
        store = Store(db)

        async def malformed(*a, **k):
            raise sqlite3.DatabaseError("database disk image is malformed")

        monkeypatch.setattr(store, "due_rows", malformed)
        cfg = SimpleNamespace(api_base_url=PRIMARY, device_key="k", sync_interval_s=0,
                              api_fallback_urls=())
        with pytest.raises(sync.FatalStoreError):
            await sync.drain_loop(cfg, store, pool=pool(tmp_path),
                                  transport=httpx.MockTransport(lambda r: httpx.Response(200)))
        # The next start moves it aside without having to rediscover the damage.
        assert (tmp_path / "lockerroom.db.suspect").exists()
        store._conn.close()
        open_store(db)
        assert (tmp_path / "lockerroom.db.corrupt-0").exists()
        assert not (tmp_path / "lockerroom.db.suspect").exists()

    @pytest.mark.asyncio
    async def test_a_full_disk_is_not_treated_as_corruption(self, tmp_path, monkeypatch):
        store = Store(tmp_path / "lockerroom.db")
        calls = []

        async def full(*a, **k):
            calls.append(1)
            if len(calls) > 5:
                raise asyncio.CancelledError
            raise sqlite3.OperationalError("database or disk is full")

        monkeypatch.setattr(store, "due_rows", full)
        cfg = SimpleNamespace(api_base_url=PRIMARY, device_key="k", sync_interval_s=0,
                              api_fallback_urls=())
        with pytest.raises(asyncio.CancelledError):
            await sync.drain_loop(cfg, store, pool=pool(tmp_path),
                                  transport=httpx.MockTransport(lambda r: httpx.Response(200)))
        assert not (tmp_path / "lockerroom.db.suspect").exists()


def test_the_dead_heartbeat_stub_is_gone():
    assert not hasattr(sync, "heartbeat_loop")
