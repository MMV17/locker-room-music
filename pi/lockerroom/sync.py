from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx

from .config import Config
from .storage import Store

log = logging.getLogger("lockerroom.sync")

BACKOFF_BASE_S = 5
BACKOFF_CAP_S = 300


def _next_attempt_delay(attempts: int) -> float:
    return min(BACKOFF_BASE_S * (2 ** attempts), BACKOFF_CAP_S)


async def drain_loop(config: Config, store: Store) -> None:
    async with httpx.AsyncClient(
        base_url=config.api_base_url,
        headers={"X-Device-Key": config.device_key},
        timeout=10.0,
    ) as client:
        while True:
            try:
                await _drain_once(client, store)
            except Exception:
                log.exception("outbox drain pass failed unexpectedly")
            await asyncio.sleep(config.sync_interval_s)


async def _drain_once(client: httpx.AsyncClient, store: Store) -> None:
    rows = await store.due_rows()
    for row in rows:
        try:
            resp = await client.request(row.method, row.endpoint, json=row.payload)
        except httpx.HTTPError as exc:
            await _reschedule(store, row.id, row.attempts, reason=str(exc))
            continue

        if 200 <= resp.status_code < 300:
            await store.mark_synced(row.id)
        elif resp.status_code in (400, 401, 403, 404, 409, 422):
            # Not retryable as-is; still keep the row (never drop an entry)
            # but back off hard so it doesn't spin every cycle.
            log.error(
                "outbox row %s rejected by server (%d): %s", row.id, resp.status_code, resp.text[:300]
            )
            await _reschedule(store, row.id, row.attempts, reason=f"http {resp.status_code}", hard=True)
        else:
            await _reschedule(store, row.id, row.attempts, reason=f"http {resp.status_code}")


async def _reschedule(store: Store, outbox_id: str, attempts: int, reason: str, hard: bool = False) -> None:
    new_attempts = attempts + 1
    delay = BACKOFF_CAP_S if hard else _next_attempt_delay(new_attempts)
    next_at = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()
    log.warning("outbox row %s retry %d in %.0fs (%s)", outbox_id, new_attempts, delay, reason)
    await store.mark_failed(outbox_id, new_attempts, next_at)


async def heartbeat_loop(config: Config, store: Store, interval_s: float = 60.0) -> None:
    """Deprecated: superseded by control.beacon_loop.

    Kept only so an older deployment that still imports it does not crash on
    start. Queuing liveness in a durable outbox is what made that table 98.5%
    heartbeats, and a replayed heartbeat asserts something that is no longer
    true. Do not wire this back up.
    """
    raise RuntimeError("heartbeat_loop is superseded by control.beacon_loop")
