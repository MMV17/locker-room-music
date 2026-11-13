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

from . import adapters as _adapters
from .macaddr import normalise as _normalise_mac
from .proc import communicate as _communicate

log = logging.getLogger("lockerroom.relay")

TARGET_PATH = Path("/run/lockerroom/relay-target")
CONNECT_TIMEOUT_S = 20.0
# Pairing waits on a human holding a speaker, so it gets longer than a connect.
PAIR_TIMEOUT_S = 40.0
RECONNECT_INTERVAL_S = 30.0
# How long to wait before looking again when the speaker's audio channel is
# missing, before concluding it is really gone. See _player_reaches_speaker.
AUDIO_RECHECK_S = 5.0
AUDIO_CHECK_TIMEOUT_S = 10.0
# ON again (2026-11-13), keyed on the PLAYER'S OWN FAILURE this time.
#
# The first version asked bluealsa-cli whether the speaker had a playback PCM,
# and on hardware that list came back EMPTY while music was playing - so it
# reconnected a working speaker every 30s (audible chime). The one signal that
# only ever appeared during the real failure is the player failing to open the
# speaker, which bluealsa-aplay retries and logs every 5 seconds:
#
#   aplay.c:732: Opening ALSA playback PCM: name=bluealsa:DEV=78:66:F3:1C:9D:B6,...
#   aplay.c:736: Couldn't open ALSA playback PCM: Open PCM: No such device
#
# So: PLAYER_FAIL_MIN or more of those in the last PLAYER_FAIL_WINDOW_S, for
# THIS speaker, on two looks AUDIO_RECHECK_S apart. A phone that is not playing
# produces no lines at all, so an idle box can never trip it.
RELAY_AUDIO_KICK = True
PLAYER_FAIL_WINDOW_S = 20
PLAYER_FAIL_MIN = 3
# At most one player-failure reconnect per this long. On 2026-11-13 14:10-14:13
# the JBL's audio slot was held by an iPad playing to it DIRECTLY (the Charge 6
# takes two sources), so the failure was real but a reconnect could not fix it -
# and the relay reconnected every ~40s, an audible chime each time.
RELAY_KICK_BACKOFF_S = 300.0
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
    # Kills the child on timeout: bluetoothctl waits for ever on a daemon that
    # is not answering, and this is retried every 30 seconds. See proc.py.
    out, _ = await _communicate(proc, timeout)
    return (out or b"").decode(errors="replace")


# --------------------------------------------------------------------------- #
# THE DONGLE (2026-11-13). With a USB dongle carrying the phones, the speaker
# must be reached through the BUILT-IN chip specifically - and bluetoothctl
# only ever talks to whichever adapter it considers the default, which follows
# probe order. So when split, the same three operations go over D-Bus to
# /org/bluez/<relay adapter>/dev_XX by path. Not split: bluetoothctl, exactly
# as before. See lockerroom/adapters.py.
# --------------------------------------------------------------------------- #

def _relay_device_path(mac: str) -> str | None:
    """The speaker's BlueZ object on the relay adapter, or None when not split."""
    roles = _adapters.roles()
    if not roles.split:
        return None
    return f"/org/bluez/{roles.relay}/dev_{mac.upper().replace(':', '_')}"


async def _busctl(*args: str, timeout: float = CONNECT_TIMEOUT_S) -> tuple[int, str]:
    """argv list, never a shell string; the path is built from a validated MAC."""
    proc = await asyncio.create_subprocess_exec(
        "busctl", f"--timeout={int(timeout)}", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await _communicate(proc, timeout + 5)
    return proc.returncode or 0, (out or b"").decode(errors="replace")


async def _device_call(path: str, method: str, timeout: float = CONNECT_TIMEOUT_S) -> tuple[bool, str]:
    rc, text = await _busctl("call", "org.bluez", path, "org.bluez.Device1", method, timeout=timeout)
    return rc == 0, text


async def _bluetoothctl_connect(mac: str) -> bool:
    path = _relay_device_path(mac)
    if path is not None:
        ok, text = await _device_call(path, "Connect")
        if not (ok or "AlreadyConnected" in text):
            log.info("connect to %s through the built-in adapter: %s",
                     mac, " ".join(text.split())[:200] or "(no reason given)")
            return False
        return True
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
    path = _relay_device_path(mac)
    if path is not None:
        # ALREADY PAIRED? Then do not ask again. Asking costs nothing when the
        # speaker is idle, but on hardware (2026-11-13 13:42:58) a Pair sent
        # while the JBL was busy failed, and the relay gave up on the whole
        # cycle for a speaker that had been paired all along.
        rc, prop = await _busctl("get-property", "org.bluez", path, "org.bluez.Device1",
                                 "Paired", timeout=10)
        if rc == 0 and prop.strip().endswith("true"):
            return True
        if "UnknownObject" in prop or "doesn't exist" in prop or "not exist" in prop:
            log.warning(
                "the built-in adapter has never seen %s - scan for it from the Admin "
                "screen with the speaker in pairing mode", mac,
            )
            return False
        # The speaker must have been SEEN by the built-in chip first, which is
        # what bt-scan.sh does when split.
        done, text = await _device_call(path, "Pair", timeout=PAIR_TIMEOUT_S)
        ok = done or "AlreadyExists" in text
        if not ok:
            log.warning("pairing %s through the built-in adapter failed: %s",
                        mac, " ".join(text.split())[:200] or "(no reason given)")
        if ok:
            try:
                await _busctl("set-property", "org.bluez", path, "org.bluez.Device1",
                              "Trusted", "b", "true")
            except Exception:
                log.exception("paired %s but could not trust it", mac)
        return ok
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
        path = _relay_device_path(mac)
        if path is not None:
            await _device_call(path, "Disconnect")
            return
        await _bluetoothctl("disconnect", mac)
    except Exception:
        log.debug("disconnect of %s failed, continuing", mac, exc_info=True)


async def _player_reaches_speaker(mac: str) -> bool:
    """False only when bluealsa-aplay has been failing to open THIS speaker.

    Reads the player's journal (the listener runs as root). Unknown counts as
    fine: a check that cannot run must never be the reason the speaker gets
    disconnected.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "journalctl", "-u", "bluealsa-aplay", f"--since=-{PLAYER_FAIL_WINDOW_S}s",
            "--no-pager", "-o", "cat",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await _communicate(proc, AUDIO_CHECK_TIMEOUT_S)
    except Exception:
        log.debug("could not read the player's journal", exc_info=True)
        return True
    if proc.returncode != 0:
        return True
    return not player_failing(mac, (out or b"").decode(errors="replace"))


def player_failing(mac: str, journal: str) -> bool:
    """The decision, separate from the I/O so it can be tested on real lines."""
    lines = journal.splitlines()
    aimed_here = any(
        "Opening ALSA playback PCM" in l and f"DEV={mac.upper()}" in l.upper()
        for l in lines
    )
    # ONLY the real failure's wording. On 2026-11-13 the silent JBL logged "PCM
    # not found" / "No such device". A handover restarts the player, and the new
    # one can briefly fail to open a speaker the old one still holds ("busy") -
    # that is not the speaker being gone, and counting it reconnected a working
    # JBL at the moment the aux changed hands.
    failures = sum(
        "Couldn't open ALSA playback PCM" in l
        and ("No such device" in l or "PCM not found" in l)
        for l in lines
    )
    return aimed_here and failures >= PLAYER_FAIL_MIN


async def _run_audio_route() -> None:
    """Hand the routing decision back to the one script that owns it, rather
    than writing /etc/asound.conf or output.env from here. Two writers of the
    audio path is how they drift."""
    proc = await asyncio.create_subprocess_exec(
        *ROUTE_ARGV,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await _communicate(proc, ROUTE_TIMEOUT_S)
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
        audio_ok: Callable[[str], Awaitable[bool]] = _player_reaches_speaker,
        recheck_s: float = AUDIO_RECHECK_S,
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
        self._audio_ok = audio_ok
        self._recheck_s = recheck_s
        self._live = False
        self._last_kick: float | None = None
        self._paired: set[str] = set()
        self._last_error: str | None = None
        self._target_listeners: list[Callable[[str | None], None]] = []

    def on_target_changed(self, listener: Callable[[str | None], None]) -> None:
        """Be told when the speaker changes.

        main.py wires this to SessionManager.set_relay_mac. The notification
        happens HERE, at the one place the target actually changes, rather than
        at each caller — because a caller that forgets leaves the far speaker
        competing with phones for the aux, which is silent, plausible and was
        expensive to find the first time.
        """
        self._target_listeners.append(listener)

    def _announce_target(self) -> None:
        for listener in self._target_listeners:
            try:
                listener(self._mac)
            except Exception:
                log.exception("a relay target listener failed")

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
        self._announce_target()
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
            if not RELAY_AUDIO_KICK:
                return True
            loop_now = asyncio.get_running_loop().time()
            if self._last_kick is not None and loop_now - self._last_kick < RELAY_KICK_BACKOFF_S:
                return True
            if await self._audio_alive():
                return True
            self._last_kick = loop_now
            # Connected, but with no audio channel: the silent relay. A fresh
            # connection brings a fresh A2DP stream; falling back to the wired
            # output in between is audible, which silence is not.
            log.warning(
                "relay speaker %s is connected but the player cannot open it - "
                "reconnecting it (next try no sooner than %ds; if it keeps happening, "
                "another phone or laptop may be playing to the speaker directly)",
                self._mac, int(RELAY_KICK_BACKOFF_S),
            )
            mac = self._mac
            try:
                await self._disconnect(mac)
            except Exception:
                log.exception("could not disconnect %s", mac)
            await self.on_disconnected()
            # Fall through and reconnect now, rather than a whole cycle later.

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

    async def _audio_alive(self) -> bool:
        """Two looks, AUDIO_RECHECK_S apart, so a channel being renegotiated at
        the moment of the check is not mistaken for one that is gone."""
        assert self._mac is not None
        try:
            if await self._audio_ok(self._mac):
                return True
            await asyncio.sleep(self._recheck_s)
            return await self._audio_ok(self._mac)
        except Exception:
            log.debug("audio channel check failed", exc_info=True)
            return True

    async def on_connected(self) -> None:
        """The speaker connected (often by itself, reconnecting to us). If the
        relay does not already count it as live, adopt it now: ensure_connected
        sees it paired, Connect returns success or AlreadyConnected, and the
        output is rerouted - instead of waiting for the next 30s cycle."""
        if self._mac is None or self._live:
            return
        try:
            await self.ensure_connected()
        except Exception:
            log.exception("could not adopt the relay speaker %s", self._mac)

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
