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

The target can be changed at runtime, because on campus there is no way to SSH
in and edit config.toml. It arrives on the beacon response, is validated here
before it is used, and is passed to bluetoothctl as its own argv element.

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
# Pairing waits on a human holding a speaker, so it gets longer than a connect.
PAIR_TIMEOUT_S = 40.0
RECONNECT_INTERVAL_S = 30.0
ROUTE_ARGV = ["sudo", "/usr/local/bin/audio-route.sh"]
ROUTE_TIMEOUT_S = 30.0


async def _bluetoothctl(*args: str, timeout: float = CONNECT_TIMEOUT_S) -> str:
    """argv list, never a shell string — the same rule aux.py and control.py
    follow. The MAC is validated before it reaches here and is passed as its
    own element, so it cannot become extra arguments however odd it looks."""
    proc = await asyncio.create_subprocess_exec(
        "bluetoothctl", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    return (out or b"").decode(errors="replace")


async def _bluetoothctl_connect(mac: str) -> bool:
    text = await _bluetoothctl("connect", mac)
    # bluetoothctl exits 0 even when a connection fails, so the exit code alone
    # is not an answer. Measured on the box: success prints exactly this.
    return "Connection successful" in text


async def _bluetoothctl_pair(mac: str) -> bool:
    """Pair, then trust. Both, because they answer different questions.

    `pair` is what a speaker in pairing mode is waiting for. `trust` is what
    lets it reconnect later without anyone present — which is the whole point
    of a box in a locker room nobody can reach.

    A speaker that is already paired fails with org.bluez.Error.AlreadyExists.
    That is success: it means the state we wanted is the state we have.
    """
    text = await _bluetoothctl("pair", mac, timeout=PAIR_TIMEOUT_S)
    ok = "Pairing successful" in text or "AlreadyExists" in text
    if ok:
        # Best effort. A speaker that paired but would not trust still plays
        # today; it just may not come back on its own after a power cut, and
        # failing the whole selection over that would be worse.
        try:
            await _bluetoothctl("trust", mac)
        except Exception:
            log.exception("paired %s but could not trust it", mac)
    return ok


async def _bluetoothctl_disconnect(mac: str) -> None:
    """Best effort. A speaker that is already gone is the normal case here."""
    try:
        await _bluetoothctl("disconnect", mac)
    except Exception:
        log.debug("disconnect of %s failed, continuing", mac, exc_info=True)


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
        mac: str | None = None,
        target_path: Path = TARGET_PATH,
        connect: Callable[[str], Awaitable[bool]] = _bluetoothctl_connect,
        route: Callable[[], Awaitable[None]] = _run_audio_route,
        pair: Callable[[str], Awaitable[bool]] = _bluetoothctl_pair,
        disconnect: Callable[[str], Awaitable[None]] = _bluetoothctl_disconnect,
    ):
        # None is a real state, not an error: a box that has never been given a
        # speaker still has a manager, so one can be chosen from the Admin
        # screen without restarting the listener. Before runtime selection this
        # object was only constructed when config.toml already had a MAC.
        self._mac = _normalise_mac(mac, field="relay speaker mac") if mac else None
        self._target_path = target_path
        self._connect = connect
        self._route = route
        self._pair = pair
        self._disconnect = disconnect
        self._live = False
        self._paired: set[str] = set()
        self._last_error: str | None = None

    @property
    def mac(self) -> str | None:
        return self._mac

    @property
    def target(self) -> str | None:
        return self._mac

    @property
    def connected(self) -> bool:
        return self._live

    @property
    def last_error(self) -> str | None:
        """Why the speaker is not playing, for the Admin screen.

        Cleared on a successful connect. A selection that stores fine and then
        fails to connect is the single most likely thing to happen in a locker
        room — the speaker was not in pairing mode — and a screen that cannot
        say so shows a selection that silently does nothing.
        """
        return self._last_error

    async def set_target(self, mac: str | None) -> bool:
        """Point the relay at a different speaker, or at none.

        Raises ValueError on a malformed MAC WITHOUT disturbing the current
        target: this value arrives from the server, and a compromised or
        misdeployed server must not be able to change what is playing.
        """
        wanted = _normalise_mac(mac, field="relay speaker mac") if mac else None
        if wanted == self._mac:
            return self._live

        # Tear the old one down FIRST — see on_disconnected() for why the file
        # goes before the reroute. A failed connection below then leaves the
        # box on a wired output, which is audible, instead of pointing at a
        # speaker that never answered, which is silence with every unit green.
        old = self._mac
        if old is not None:
            await self._teardown(old)

        self._mac = wanted
        self._last_error = None
        if wanted is None:
            log.info("relay target cleared — wired output")
            return True

        log.info("relay target set to %s", wanted)
        return await self.ensure_connected()

    async def _teardown(self, mac: str) -> None:
        was_live = self._live
        self._live = False
        try:
            await self._disconnect(mac)
        except Exception:
            log.exception("could not disconnect %s", mac)
        try:
            self._target_path.unlink()
        except OSError:
            pass
        if was_live:
            try:
                await self._route()
            except Exception:
                log.exception("could not reroute after dropping %s", mac)

    async def ensure_connected(self) -> bool:
        if self._mac is None:
            return False
        if self._live:
            return True

        if self._mac not in self._paired:
            # Only on a target we have not paired before. Re-pairing a speaker
            # every reconnect is noise, and some speakers drop the existing
            # link to do it.
            try:
                paired = await self._pair(self._mac)
            except Exception:
                log.exception("could not pair the relay speaker %s", self._mac)
                self._last_error = "pairing failed"
                return False
            if not paired:
                log.warning("relay speaker %s would not pair", self._mac)
                self._last_error = (
                    "could not pair — is the speaker in pairing mode?"
                )
                return False
            self._paired.add(self._mac)

        try:
            ok = await self._connect(self._mac)
        except Exception:
            log.exception("could not connect to the relay speaker %s", self._mac)
            self._last_error = "connect failed"
            return False
        if not ok:
            log.warning("relay speaker %s did not connect", self._mac)
            self._last_error = "the speaker did not answer — is it switched on?"
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
        self._last_error = None
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
            # No target is a normal resting state now, not a misconfiguration:
            # the box may simply be on a wired output. Keep the loop alive so a
            # speaker chosen from the Admin screen is picked up without a
            # listener restart.
            if self._mac is not None:
                await self.ensure_connected()
            await asyncio.sleep(interval_s)
