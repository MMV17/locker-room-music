from __future__ import annotations

import asyncio
import json
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
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        self._lock = asyncio.Lock()

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
