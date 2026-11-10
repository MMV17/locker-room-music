"""Waiting on a child process without leaking it.

`asyncio.wait_for(proc.communicate(), timeout)` gives up on the WAIT, not on
the process. bluetoothctl blocks for as long as bluetoothd does not answer, so
every timed-out call left one behind - and the relay retries every 30 seconds.
A wedged Bluetooth daemon therefore grew a pile of stuck children until
something ran out of memory. This kills the child before reporting the timeout.
"""

from __future__ import annotations

import asyncio
import contextlib


async def communicate(proc: asyncio.subprocess.Process, timeout: float) -> tuple[bytes, bytes]:
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return out or b"", err or b""
    except BaseException:
        # Timeout or cancellation alike: the caller has stopped waiting, so
        # nothing will ever reap this child unless it is done here.
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5)
        raise
