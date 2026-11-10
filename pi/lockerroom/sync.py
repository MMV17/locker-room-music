from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timedelta, timezone

import httpx

from . import endpoints
from .config import Config
from .storage import Store

log = logging.getLogger("lockerroom.sync")

BACKOFF_BASE_S = 5
BACKOFF_CAP_S = 300
# How many drain passes in a row may fail inside SQLite before the database is
# declared damaged. See FatalStoreError.
DB_ERRORS_BEFORE_GIVING_UP = 3

# Statuses our Worker uses to say "this row will never be accepted as it is".
NOT_RETRYABLE = (400, 401, 403, 404, 409, 422)


class FatalStoreError(Exception):
    """The outbox database is damaged and this process cannot fix it in place.

    Raised so the listener EXITS. On the way out the database is flagged, and
    the next start moves it aside (never deletes it) and begins a fresh one -
    see storage.open_store. Without this the drain logged the same sqlite
    error every five seconds for ever and no play was ever sent again.
    """


def _next_attempt_delay(attempts: int) -> float:
    return min(BACKOFF_BASE_S * (2 ** min(attempts, 16)), BACKOFF_CAP_S)


def _at(delay: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()


async def drain_loop(
    config: Config,
    store: Store,
    pool: endpoints.HostPool | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    if pool is None:
        pool = endpoints.HostPool(
            endpoints.build_urls(config.api_base_url, getattr(config, "api_fallback_urls", ()))
        )
    db_errors = 0
    async with httpx.AsyncClient(
        headers={"X-Device-Key": config.device_key},
        timeout=10.0,
        transport=transport,
    ) as client:
        while True:
            try:
                await _drain_once(client, store, pool)
                db_errors = 0
            except sqlite3.OperationalError:
                # Locked, disk full, read-only: the file is not damaged, and
                # moving it aside would throw away plays for nothing.
                log.exception("outbox drain pass could not use the database")
            except sqlite3.DatabaseError as exc:
                db_errors += 1
                log.exception("outbox database error (%d in a row)", db_errors)
                if db_errors >= DB_ERRORS_BEFORE_GIVING_UP:
                    store.flag_suspect()
                    raise FatalStoreError(str(exc)) from exc
            except Exception:
                log.exception("outbox drain pass failed unexpectedly")
            await asyncio.sleep(config.sync_interval_s)


async def _drain_once(client: httpx.AsyncClient, store: Store, pool: endpoints.HostPool) -> None:
    rows = await store.due_rows()
    for row in rows:
        url = pool.pick()
        try:
            resp = await client.request(row.method, url + row.endpoint, json=row.payload)
        except httpx.HTTPError as exc:
            pool.failure(url, type(exc).__name__)
            await _host_down(store, row.id, row.attempts, reason=str(exc) or type(exc).__name__)
            return

        body = endpoints.json_object(resp)
        if body is None and endpoints.not_our_worker(resp):
            # A filter page or a captive portal answering for our hostname.
            # A 200 from one of those used to mark the play as synced, and the
            # play was gone for good.
            pool.failure(url, f"http {resp.status_code}, not our Worker")
            await _host_down(
                store, row.id, row.attempts,
                reason=f"http {resp.status_code} from something that is not our Worker",
            )
            return
        if body is not None:
            pool.success(url)

        if 200 <= resp.status_code < 300 and body is not None and body.get("ok") is True:
            await store.mark_synced(row.id)
        elif body is not None and resp.status_code in NOT_RETRYABLE:
            # Not retryable as-is; still keep the row (never drop an entry)
            # but back off hard so it doesn't spin every cycle.
            log.error(
                "outbox row %s rejected by server (%d): %s", row.id, resp.status_code, resp.text[:300]
            )
            await _reschedule(store, row.id, row.attempts, reason=f"http {resp.status_code}", hard=True)
        else:
            # Including a 5xx with a non-JSON body: that is the Worker failing
            # on THIS row, so it backs off alone and the rows behind it go on.
            await _reschedule(store, row.id, row.attempts, reason=f"http {resp.status_code}")


async def _reschedule(store: Store, outbox_id: str, attempts: int, reason: str, hard: bool = False) -> None:
    new_attempts = attempts + 1
    delay = BACKOFF_CAP_S if hard else _next_attempt_delay(new_attempts)
    log.warning("outbox row %s retry %d in %.0fs (%s)", outbox_id, new_attempts, delay, reason)
    await store.mark_failed(outbox_id, new_attempts, _at(delay))


async def _host_down(store: Store, outbox_id: str, attempts: int, reason: str) -> None:
    """The HOST failed, not the row. Stop the pass and push everything back.

    Two things changed here in 2026-11, both from the same observation: with
    the network down, a pass used to walk all fifty due rows at a ten-second
    timeout each, and each row backed off separately. So a song's close could
    come due before its own create and be answered 404, which costs it five
    minutes.

    Now the first transport failure ends the pass, and EVERY due row is pushed
    back to the same moment. They come due together and are sent oldest first,
    which is the order they were written in.
    """
    new_attempts = attempts + 1
    delay = _next_attempt_delay(new_attempts)
    log.warning("outbox paused %.0fs: the api host did not answer (%s)", delay, reason)
    when = _at(delay)   # ONE moment for all of them, or the order can shuffle
    await store.mark_failed(outbox_id, new_attempts, when)
    await store.defer_due(when)
