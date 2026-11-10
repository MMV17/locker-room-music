from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox (
    id              TEXT PRIMARY KEY,
    method          TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    synced_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox (next_attempt_at) WHERE synced_at IS NULL;
"""


log = logging.getLogger("lockerroom.storage")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class OutboxRow:
    id: str
    method: str
    endpoint: str
    payload: dict[str, Any]
    attempts: int


class Store:
    """Thin synchronous SQLite wrapper. Called via asyncio.to_thread from
    async code — sqlite3 connections are cheap and this stays a single
    writer, so no pooling is needed."""

    def __init__(self, db_path: Path):
        db_path = Path(db_path)
        self.db_path = db_path
        # Set by open_store when the real database could not be used and this
        # is a stand-in that will not survive a restart. None = healthy.
        self.degraded: str | None = None
        if str(db_path) != ":memory:":
            db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        self._lock = asyncio.Lock()

    def quick_check(self) -> None:
        """Raise sqlite3.DatabaseError unless SQLite calls the file sound."""
        row = self._conn.execute("PRAGMA quick_check").fetchone()
        if not row or row[0] != "ok":
            raise sqlite3.DatabaseError(f"quick_check: {row[0] if row else 'no answer'}")

    def flag_suspect(self) -> None:
        """Ask the NEXT start to move this database aside. See open_store."""
        try:
            suspect_path(self.db_path).write_text("flagged after repeated query failures\n")
        except OSError:
            log.warning("could not flag %s as suspect", self.db_path)

    async def defer_due(self, next_attempt_at: str) -> None:
        """Push every row that is due back to one shared moment."""
        async with self._lock:
            await asyncio.to_thread(self._defer_due_sync, next_attempt_at)

    def _defer_due_sync(self, next_attempt_at: str) -> None:
        self._conn.execute(
            "UPDATE outbox SET next_attempt_at = ? "
            "WHERE synced_at IS NULL AND next_attempt_at <= ?",
            (next_attempt_at, now_iso()),
        )
        self._conn.commit()

    async def enqueue(self, outbox_id: str, method: str, endpoint: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            await asyncio.to_thread(self._enqueue_sync, outbox_id, method, endpoint, payload)

    def _enqueue_sync(self, outbox_id: str, method: str, endpoint: str, payload: dict[str, Any]) -> None:
        ts = now_iso()
        self._conn.execute(
            "INSERT INTO outbox (id, method, endpoint, payload_json, created_at, attempts, next_attempt_at) "
            "VALUES (?, ?, ?, ?, ?, 0, ?)",
            (outbox_id, method, endpoint, json.dumps(payload), ts, ts),
        )
        self._conn.commit()

    async def due_rows(self, limit: int = 50) -> list[OutboxRow]:
        async with self._lock:
            return await asyncio.to_thread(self._due_rows_sync, limit)

    def _due_rows_sync(self, limit: int) -> list[OutboxRow]:
        ts = now_iso()
        cur = self._conn.execute(
            "SELECT id, method, endpoint, payload_json, attempts FROM outbox "
            "WHERE synced_at IS NULL AND next_attempt_at <= ? "
            "ORDER BY created_at ASC LIMIT ?",
            (ts, limit),
        )
        return [
            OutboxRow(id=r[0], method=r[1], endpoint=r[2], payload=json.loads(r[3]), attempts=r[4])
            for r in cur.fetchall()
        ]

    async def mark_synced(self, outbox_id: str) -> None:
        async with self._lock:
            await asyncio.to_thread(self._mark_synced_sync, outbox_id)

    def _mark_synced_sync(self, outbox_id: str) -> None:
        self._conn.execute(
            "UPDATE outbox SET synced_at = ? WHERE id = ?", (now_iso(), outbox_id)
        )
        self._conn.commit()

    async def mark_failed(self, outbox_id: str, attempts: int, next_attempt_at: str) -> None:
        async with self._lock:
            await asyncio.to_thread(self._mark_failed_sync, outbox_id, attempts, next_attempt_at)

    def _mark_failed_sync(self, outbox_id: str, attempts: int, next_attempt_at: str) -> None:
        self._conn.execute(
            "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?",
            (attempts, next_attempt_at, outbox_id),
        )
        self._conn.commit()


def suspect_path(db_path: Path) -> Path:
    return Path(db_path).with_name(Path(db_path).name + ".suspect")


def _move_aside(db_path: Path, why: str) -> None:
    """Rename a damaged database out of the way. NEVER deletes it.

    The plays inside it that had not synced are not recoverable by this
    process, but they are not gone either: the file stays on the card as
    lockerroom.db.corrupt-N for somebody with a cable.
    """
    n = 0
    while db_path.with_name(f"{db_path.name}.corrupt-{n}").exists():
        n += 1
    target = db_path.with_name(f"{db_path.name}.corrupt-{n}")
    for suffix in ("", "-journal", "-wal", "-shm"):
        src = db_path.with_name(db_path.name + suffix)
        if src.exists():
            os.replace(src, target.with_name(target.name + suffix))
    log.error("outbox database %s was damaged (%s) - moved aside to %s", db_path, why, target)


def open_store(db_path: Path) -> Store:
    """Open the outbox, whatever state the file is in. Never raises.

    The listener is the box's only remote control, and it used to open this
    database before it started beaconing - so a single corrupt page on the SD
    card was a listener that crash-looped every three seconds and a speaker
    nobody could reach. Three outcomes now, in order of preference:

      1. the file opens and SQLite calls it sound: use it
      2. it is damaged: move it aside (never delete) and start a fresh one
      3. no file can be used at all - disk full, read-only card, permissions:
         run on an in-memory outbox. Plays recorded before the next restart
         are sent as usual; ones still unsent at a restart are lost. That is
         strictly better than no beacon, and `degraded` says so in the log.
    """
    db_path = Path(db_path)
    try:
        flag = suspect_path(db_path)
        if flag.exists():
            if db_path.exists():
                _move_aside(db_path, "flagged by the previous run")
            flag.unlink()
        store: Store | None = None
        try:
            store = Store(db_path)
            store.quick_check()
            return store
        except sqlite3.OperationalError:
            raise
        except sqlite3.DatabaseError as exc:
            if store is not None:
                store._conn.close()
            _move_aside(db_path, str(exc))
            return Store(db_path)
    except Exception as exc:  # noqa: BLE001 - see the docstring: never raises
        log.exception("could not open the outbox at %s - using memory only", db_path)
        store = Store(Path(":memory:"))
        store.degraded = f"{type(exc).__name__}: {exc}"
        return store
