"""Owns the Pi's OUTBOUND Bluetooth connection to the speaker.

Why the Pi connects outward at all: speakers disagree about wired inputs. Some
take only 3.5mm, the JBL Charge 6 takes only USB-C digital audio (and then
draws charging current the Pi cannot always supply — see docs/STATE.md), and
some take neither. Bluetooth is the one input nearly every speaker has.

This module deliberately knows NOTHING about phones, sessions, the aux or play
data. On 2026-08-23 the relay was abandoned because the listener treated the
far speaker as a DJ — granting it the aux and writing it into the play data.
Keeping the outbound link in its own module, with the exclusion enforced
separately in lifecycle.py, is what makes that structurally impossible rather
than merely fixed.

It writes exactly one file: /run/lockerroom/relay-target. Its PRESENCE means
"a relay output is available"; audio-route.sh reads it and arbitrates. Its
ABSENCE means the wired fallback applies, which is why it is removed on
disconnect rather than left stale — a stale target points the player at a link
that is gone, which is silence with every unit green.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Awaitable, Callable

from .macaddr import normalise as _normalise_mac

log = logging.getLogger("lockerroom.relay")

TARGET_PATH = Path("/run/lockerroom/relay-target")
CONNECT_TIMEOUT_S = 20.0
RECONNECT_INTERVAL_S = 30.0
ROUTE_ARGV = ["sudo", "/usr/local/bin/audio-route.sh"]
ROUTE_TIMEOUT_S = 30.0


async def _bluetoothctl_connect(mac: str) -> bool:
    """argv list, never a shell string — the same rule aux.py and control.py
    follow. The MAC is validated before it reaches here and is passed as its
    own element, so it cannot become extra arguments however odd it looks."""
    proc = await asyncio.create_subprocess_exec(
        "bluetoothctl", "connect", mac,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=CONNECT_TIMEOUT_S)
    text = (out or b"").decode(errors="replace")
    # bluetoothctl exits 0 even when a connection fails, so the exit code alone
    # is not an answer. Measured on the box: success prints exactly this.
    return "Connection successful" in text


async def _run_audio_route() -> None:
    """Hand the routing decision back to the one script that owns it, rather
    than writing /etc/asound.conf or output.env from here. Two writers of the
    audio path is how they drift."""
    proc = await asyncio.create_subprocess_exec(
        *ROUTE_ARGV,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=ROUTE_TIMEOUT_S)
    if proc.returncode != 0:
        raise RuntimeError(
            f"audio-route.sh exited {proc.returncode}: "
            f"{(out or b'').decode(errors='replace').strip()[:200]}"
        )


class RelayManager:
    def __init__(
        self,
        mac: str,
        target_path: Path = TARGET_PATH,
        connect: Callable[[str], Awaitable[bool]] = _bluetoothctl_connect,
        route: Callable[[], Awaitable[None]] = _run_audio_route,
    ):
        normalised = _normalise_mac(mac, field="relay speaker mac")
        if normalised is None:
            raise ValueError("relay speaker mac is empty")
        self._mac = normalised
        self._target_path = target_path
        self._connect = connect
        self._route = route
        self._live = False

    @property
    def mac(self) -> str:
        return self._mac

    async def ensure_connected(self) -> bool:
        if self._live:
            return True
        try:
            ok = await self._connect(self._mac)
        except Exception:
            log.exception("could not connect to the relay speaker %s", self._mac)
            return False
        if not ok:
            log.warning("relay speaker %s did not connect", self._mac)
            return False

        try:
            self._target_path.parent.mkdir(parents=True, exist_ok=True)
            self._target_path.write_text(f"{self._mac}\n")
        except OSError:
            log.exception("connected to %s but could not write %s",
                          self._mac, self._target_path)
            return False

        # Set BEFORE rerouting, and the reroute failure below is swallowed on
        # purpose. Forgetting that we are connected would re-issue connect
        # forever against an already-connected speaker; a failed reroute just
        # means the audio is still on the wired output, which is audible and
        # recoverable. The wrong one to optimise for is the silent one.
        self._live = True
        log.info("relay speaker connected: %s", self._mac)
        try:
            await self._route()
        except Exception:
            log.exception("connected to %s but audio-route.sh failed", self._mac)
        return True

    async def on_disconnected(self) -> None:
        """The speaker went away. Remove the target FIRST, then reroute.

        Order matters: audio-route.sh reads the file, so clearing it before
        rerouting is what makes the fallback to a wired output immediate rather
        than one cycle late.
        """
        if not self._live:
            return
        self._live = False
        try:
            self._target_path.unlink()
        except OSError:
            pass
        log.warning("relay speaker %s disconnected — falling back to wired", self._mac)
        try:
            await self._route()
        except Exception:
            log.exception("could not reroute after %s disconnected", self._mac)

    async def run(self, interval_s: float = RECONNECT_INTERVAL_S) -> None:
        """Keep trying, forever.

        A speaker that was switched off overnight has to rejoin without anyone
        visiting the locker room — the whole point of a box nobody can reach.
        """
        while True:
            await self.ensure_connected()
            await asyncio.sleep(interval_s)
