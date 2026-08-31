"""Liveness beacon and remote control.

Why this exists: the locker room network allows outbound 443 and essentially
nothing else. Port 7844 is blocked (both TCP and UDP, while 443 to the same
Cloudflare edge IPs is open), so Cloudflare Tunnel cannot run. Tailscale is
blocked by SNI. Guest clients cannot reach each other on TCP/22. Nothing can
open a connection *to* this Pi, so the Pi opens one outward and asks whether
there is anything to do.

Why this is NOT in the outbox: the outbox exists so a play or a vote survives
an outage (spec 5.3, "never drop an entry"). A heartbeat is the opposite kind
of thing - it asserts "alive right now", and replaying a four-hour-old one
tells the server nothing true. Queuing them was also what made the outbox
98.5% heartbeats (1,621 of 1,646 rows), so after an outage the Pi spent its
first minutes back online replaying stale pings ahead of real plays. A missed
beacon is simply skipped; the next one is 60 seconds away.

Commands are checked against ALLOWED here as well as on the server. The server
is not trusted to be the only gate: if it were ever compromised or misdeployed,
this list is what stops it turning a speaker into a shell. There is
deliberately no "run this string" command.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:  # pragma: no cover
    # Import for typing only. config.py needs tomllib (3.11+), and importing
    # it eagerly would make this module - and its allowlist tests - unloadable
    # on the older Python in the laptop's test venv. Annotations are strings
    # here thanks to `from __future__ import annotations`.
    from .config import Config

log = logging.getLogger("lockerroom.control")

# Fixed allowlist. Adding "run arbitrary command" here would turn a locker room
# speaker into remote code execution - do not.
ALLOWED: dict[str, list[str]] = {
    "restart-listener": ["sudo", "systemctl", "restart", "lockerroom-listener"],
    "reboot": ["sudo", "systemctl", "reboot"],
    "report-status": ["/bin/sh", "-c", "uptime; systemctl is-active lockerroom-listener bluetooth bluealsa"],
}

COMMAND_TIMEOUT_S = 25


def _run(name: str) -> tuple[bool, str]:
    argv = ALLOWED.get(name)
    if argv is None:
        # Reached only if the server sent something not on this list.
        return False, f"refused: {name!r} is not an allowed command"
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_S
        )
        output = (proc.stdout + proc.stderr).strip()
        return proc.returncode == 0, output or f"exit {proc.returncode}"
    except subprocess.TimeoutExpired:
        return False, f"timed out after {COMMAND_TIMEOUT_S}s"
    except Exception as exc:  # never let a command kill the beacon loop
        return False, f"{type(exc).__name__}: {exc}"


def play_signature(sessions) -> tuple | None:
    """
    The part of the speaker's state that the site *renders*: which song, whether
    it is playing, who has the aux, and who is waiting for it. Position is
    excluded on purpose — it changes every millisecond, and beaconing on that
    would be a busy loop.

    The aux belongs here for the same reason the pause did. A player whose
    phone connects and is told to wait would otherwise sit looking at a screen
    telling them to connect for up to a full beacon interval.

    Returns None when there is nothing to say at all — no song and nobody
    connected — so an empty locker room settles back to the slow interval
    instead of beaconing every ten seconds all night.
    """
    if sessions is None:
        return None
    try:
        state = sessions.open_play_state()
    except Exception:
        log.exception("could not read open play state")
        state = None

    try:
        aux = sessions.aux_state()
    except AttributeError:
        # Older SessionManager, or a fake in a test that predates this.
        aux = None
    except Exception:
        log.exception("could not read aux state")
        aux = None

    play_part = (state.get("id"), state.get("status")) if state else None

    aux_part = None
    if aux:
        holder = aux.get("holder")
        # Aliases are excluded: a phone renaming itself is not news the room
        # needs within a second, and MACs alone keep this cheap to compare.
        aux_part = (
            holder.get("mac") if holder else None,
            tuple(w.get("mac") for w in aux.get("waiting", [])),
            # Whether a deadline EXISTS, never the milliseconds left. The raw
            # number changes every second and would beacon at 1Hz, which is
            # the opposite of what this loop is for. The site does not need
            # the ticking pushed to it - it counts down locally from the one
            # beacon that the song ending already fires, because closing a
            # play changes play_part.
            holder.get("free_in_ms") is not None if holder else False,
        )
        if aux_part == (None, (), False):
            aux_part = None

    if play_part is None and aux_part is None:
        return None
    return (play_part, aux_part)


async def beacon_loop(
    config: Config,
    sessions=None,
    interval_s: float = 60.0,
    active_interval_s: float = 10.0,
    watch_interval_s: float = 1.0,
) -> None:
    """
    POST liveness, carry back the last result, pick up the next command.

    Cadence matters more than it looks. This beacon is the ONLY way the server
    learns that a song was paused, resumed, or changed, and at a flat 60s a
    pause took up to a minute to reach the server and another poll interval to
    reach a phone — well over a minute of the site disagreeing with the music
    in the room, with the progress bar ticking on past a paused track.

    So the wait is interruptible. `open_play_state()` is an in-memory read, so
    checking it every second costs nothing, and a real change beacons at once.
    Between changes the loop settles to `active_interval_s` while something is
    playing and `interval_s` when the speaker is idle.

    This does NOT touch spec 8's 10-second floor on the now-playing poll. That
    rule is about per-player cost and multiplies by everyone in the room; this
    is one device, so its cost is fixed no matter how many people are voting.
    """
    pending_result: dict | None = None

    async with httpx.AsyncClient(
        base_url=config.api_base_url,
        headers={"X-Device-Key": config.device_key},
        timeout=15.0,
    ) as client:
        while True:
            try:
                payload = {
                    "speaker_name": config.speaker_name,
                    "at": datetime.now(timezone.utc).isoformat(),
                }
                # Tell the server the song is still live so it does not close
                # the vote window on a paused track. See open_play_state().
                if sessions is not None:
                    try:
                        state = sessions.open_play_state()
                        if state is not None:
                            payload["current_play"] = state
                    except Exception:
                        log.exception("could not read open play state")
                    # Who has the aux and who is waiting for it, so the site can
                    # stop telling a blocked player to connect. Sent every
                    # beacon rather than only on change: the server stores the
                    # latest, so a dropped beacon self-heals on the next one.
                    try:
                        payload["aux"] = sessions.aux_state()
                    except Exception:
                        log.exception("could not read aux state")
                if pending_result is not None:
                    payload["result"] = pending_result

                resp = await client.post("/api/pi/beacon", json=payload)

                if resp.status_code == 200:
                    # Only clear the result once the server has actually taken
                    # it, so a failed beacon does not lose the outcome.
                    pending_result = None
                    command = (resp.json() or {}).get("command")
                    if command:
                        name = command.get("name", "")
                        log.info("command received: %s (%s)", name, command.get("id"))
                        # reboot never gets to report back; say so before acting.
                        ok, output = await asyncio.to_thread(_run, name)
                        log.info("command %s -> ok=%s %s", name, ok, output[:200])
                        pending_result = {
                            "id": command.get("id"),
                            "ok": ok,
                            "output": output[:2000],
                        }
                else:
                    log.warning("beacon rejected: http %d", resp.status_code)

            except httpx.HTTPError as exc:
                # Expected whenever the network is down. Not an error worth a
                # stack trace every minute - the next beacon is the retry.
                log.debug("beacon failed: %s", exc)
            except Exception:
                log.exception("beacon loop failed unexpectedly")

            # Wait, but wake early if what the site shows has changed.
            before = play_signature(sessions)
            delay = active_interval_s if before is not None else interval_s
            waited = 0.0
            while waited < delay:
                await asyncio.sleep(min(watch_interval_s, delay - waited))
                waited += watch_interval_s
                after = play_signature(sessions)
                if after != before:
                    # Paused, resumed, skipped, or a new song started. The room
                    # can see it; the site should not be the last to know.
                    log.debug("play state changed %s -> %s, beaconing", before, after)
                    break
