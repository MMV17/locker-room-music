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
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from . import btscan, forgettarget, relaytarget

if TYPE_CHECKING:  # pragma: no cover
    # Import for typing only. config.py needs tomllib (3.11+), and importing
    # it eagerly would make this module - and its allowlist tests - unloadable
    # on the older Python in the laptop's test venv. Annotations are strings
    # here thanks to `from __future__ import annotations`.
    from .config import Config

log = logging.getLogger("lockerroom.control")

# Fixed allowlist. Adding "run arbitrary command" here would turn a locker room
# speaker into remote code execution - do not.
#
# Each entry is (argv, timeout_seconds). The timeout is per command because a
# Bluetooth sweep plus a per-device info call does not fit in the 25 seconds
# that was plenty for `uptime`, and raising the limit for everything would mean
# a hung restart tying up the channel for a minute.
#
# NOTHING HERE TAKES A PARAMETER, and that is the property to preserve. If a
# feature seems to need one, it is state rather than an action: send it on the
# beacon response and validate it on arrival, the way the relay speaker does.
# See docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md.
ALLOWED: dict[str, tuple[list[str], float]] = {
    "restart-listener": (["sudo", "systemctl", "restart", "lockerroom-listener"], 25),
    "reboot": (["sudo", "systemctl", "reboot"], 25),
    "report-status": (
        ["/bin/sh", "-c", "uptime; systemctl is-active lockerroom-listener bluetooth bluealsa"],
        25,
    ),
    # 15s of discovery, then one `bluetoothctl info` per device found.
    "scan-speakers": (["sudo", "/usr/local/bin/bt-scan.sh"], 45),
    # Read-only diagnostic dump. Built after 2026-09-20, when the box stopped
    # accepting pairings and report-status could not see a single one of the
    # units that were actually broken. Bounded generously because it shells out
    # to audio-check.sh and reads a journal per unit; on a healthy box it takes
    # a few seconds, and the ceiling is for a box with something wedged.
    "report-full": (["sudo", "/usr/local/bin/report-full.sh"], 150),
    # Pull the repo and run the COMMITTED repair script. Still no parameter:
    # what varies is the commit you pushed. The script it runs must never touch
    # the listener package - run-repair.sh snapshots it and puts it back if the
    # repair modified it anyway.
    "run-repair": (["sudo", "/usr/local/bin/run-repair.sh"], 240),
    # Forget ONE paired device, so a phone that forgot us can pair again.
    # Bluetooth has no unpair message, so a one-sided forget leaves us holding
    # a bond the phone no longer has, and BlueZ then refuses the re-pair.
    # WHICH device is state on the beacon, not an argument here - see
    # forgettarget.py. A disconnect plus a remove plus verification; 30s is
    # generous for all three.
    "forget-selected-phone": (["sudo", "/usr/local/bin/bt-forget.sh"], 30),
}

SCAN_COMMAND = "scan-speakers"
REPORT_COMMAND = "report-full"
REPAIR_COMMAND = "run-repair"

# Commands whose real output is a document, not a line. Their body rides its own
# beacon payload into `pi_reports` rather than `pi_commands.result`, which the
# server cuts to 2000 characters - and a cut diagnostic hides the exact line
# somebody went looking for. Same move the scan makes, same reason.
REPORT_COMMANDS = frozenset({REPORT_COMMAND, REPAIR_COMMAND})

# Refused while a song is playing. Scanning occupies the one antenna the phone's
# audio and the outbound relay are already sharing; a repair restarts bluetooth
# and every lockerroom unit, which cuts the music outright. report-full is NOT
# here on purpose - it is strictly read-only, so there is no reason a DJ should
# have to stop playing before anyone is allowed to look at the box.
MID_SONG_REFUSED = frozenset({SCAN_COMMAND, REPAIR_COMMAND})

# What one report may send. The server caps at 64 KiB too; this is the first
# gate, so a wedged journal does not put a megabyte on the wire every time.
# A cut is ANNOUNCED, never silent - see TRUNCATION_NOTICE.
MAX_REPORT_CHARS = 64 * 1024
TRUNCATION_NOTICE = (
    "\n\n--- CUT HERE: the report hit the Pi's size limit and the REST IS MISSING ---"
)

# Where audio-route.sh records what it selected: "<kind>:<card>".
OUTPUT_STATE_PATH = Path("/run/lockerroom/audio-out")

# Beacon cadence. Idle is the resting rate; active is while a song is playing;
# attentive is for the few minutes after a command, when somebody is standing
# at the admin screen waiting for something to happen.
IDLE_INTERVAL_S = 60.0
ACTIVE_INTERVAL_S = 10.0
ATTENTIVE_INTERVAL_S = 5.0
ATTENTIVE_WINDOW_S = 180.0


def _run(name: str) -> tuple[bool, str]:
    entry = ALLOWED.get(name)
    if entry is None:
        # Reached only if the server sent something not on this list.
        return False, f"refused: {name!r} is not an allowed command"
    argv, timeout = entry
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        output = (proc.stdout + proc.stderr).strip()
        return proc.returncode == 0, output or f"exit {proc.returncode}"
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    except Exception as exc:  # never let a command kill the beacon loop
        return False, f"{type(exc).__name__}: {exc}"


def run_command(name: str) -> tuple[bool, str, list[dict] | None]:
    """Run a command and, for a scan, turn its output into structured devices.

    A scan's device list does NOT travel in the command result: that field is
    truncated to 2000 characters server-side, and a locker room with thirty
    phones in it overflows that. A truncated list is worse than none, because
    the speaker you want goes missing for no visible reason. So the list goes
    up as its own beacon payload, and the result keeps a one-line summary that
    reads sensibly in the command history.
    """
    ok, output = _run(name)
    if name != SCAN_COMMAND or not ok:
        return ok, output, None

    devices = btscan.parse(output)
    n = len(devices)
    return True, f"found {n} device{'' if n == 1 else 's'}", devices


def report_payload(
    name: str, ok: bool, output: str
) -> tuple[str, dict | None]:
    """Split a long command's output into a one-line summary and its own payload.

    Same move `run_command` makes for a scan, and for the same reason: the
    server cuts `pi_commands.result` to 2000 characters, a diagnostic dump is
    many times that, and a cut dump is worse than no dump because the line
    somebody went looking for disappears with nothing on screen admitting it.
    So the body rides its own beacon payload into `pi_reports`, and the result
    keeps a summary that reads sensibly in the command history.

    A FAILED command still produces a payload. A repair that reported a problem
    is precisely the log worth reading, and the 2026-09-20 fault would have been
    diagnosed from a dump whose script exited non-zero.

    Returns (summary, payload) - and (output, None) untouched for every command
    whose output is already a line rather than a document.
    """
    if name not in REPORT_COMMANDS:
        return output, None

    body = output or "(the command produced no output at all)"
    if len(body) > MAX_REPORT_CHARS:
        body = body[: MAX_REPORT_CHARS - len(TRUNCATION_NOTICE)] + TRUNCATION_NOTICE

    kb = len(body) / 1024
    if name == REPAIR_COMMAND:
        headline = "repair finished" if ok else "repair reported a problem"
    else:
        headline = "full report" if ok else "full report (the script exited non-zero)"
    summary = f"{headline} - {kb:.1f} KB, open it below"

    return summary, {
        "kind": name,
        "at": datetime.now(timezone.utc).isoformat(),
        "body": body,
        "ok": ok,
    }


def may_run(name: str, sessions) -> tuple[bool, str]:
    """Whether now is a reasonable moment to run `name`.

    Generalises the mid-song refusal that scanning already had. A repair
    restarts bluetooth and every lockerroom unit, so running one under a live
    song cuts the music outright - a worse outcome than the stutter a scan
    causes, and the same answer applies.

    report-full is deliberately NOT refused. It is strictly read-only, so
    nobody should have to wait for a song to end before they are allowed to
    look at the box - and the moment you most want to look is usually the
    moment something is playing badly.
    """
    if name not in MID_SONG_REFUSED:
        return True, ""
    allowed, why = may_scan(sessions)
    if allowed:
        return True, ""
    if name == REPAIR_COMMAND:
        return False, "refused: a song is playing - a repair restarts bluetooth and would cut it off"
    return False, why


def may_scan(sessions) -> tuple[bool, str]:
    """Whether now is a reasonable moment to occupy the radio.

    Discovery shares the one antenna with both the phone's A2DP sink and the
    outbound relay, so scanning mid-song stutters the room. Refused HERE rather
    than on the server, because the play state lives here.

    Fails OPEN when the state cannot be read: the cost of scanning during a
    song is a stutter, and the cost of never scanning is a feature that does
    not work. A broken read should not be the thing that decides.
    """
    if sessions is None:
        return True, ""
    try:
        state = sessions.open_play_state()
    except Exception:
        log.exception("could not read play state before scanning; allowing the scan")
        return True, ""
    if state:
        return False, "refused: a song is playing — scanning would stutter it"
    return True, ""


def read_output(path: Path = OUTPUT_STATE_PATH) -> dict | None:
    """What audio-route.sh last selected, for the admin screen.

    None means unknown, which is normal: the listener can beacon before the
    arbiter has ever run. A relay card is a MAC and therefore full of colons,
    so the split is on the FIRST one only.
    """
    try:
        text = Path(path).read_text().strip()
    except OSError:
        return None
    kind, sep, card = text.partition(":")
    if not sep or not kind:
        return None
    return {"kind": kind, "card": card}


def attentive_until(now: float | None = None) -> float:
    """Open the attentive window. Called when a command is picked up."""
    return (time.monotonic() if now is None else now) + ATTENTIVE_WINDOW_S


def next_interval(
    attentive_deadline: float | None, playing: bool, now: float | None = None
) -> float:
    """How long to wait before the next beacon.

    Attentive outranks active: somebody standing at the admin screen holding a
    speaker in pairing mode is waiting on a round trip, and a speaker's pairing
    window is shorter than this beacon's idle interval.
    """
    now = time.monotonic() if now is None else now
    if attentive_deadline is not None and now < attentive_deadline:
        return ATTENTIVE_INTERVAL_S
    return ACTIVE_INTERVAL_S if playing else IDLE_INTERVAL_S


def should_report_now(pending: bool, beacon_ok: bool) -> bool:
    """Whether to skip the wait and beacon straight away.

    Only when the last beacon actually got through. A pending result on a FAILED
    beacon means the network is down, and skipping the wait there would retry
    with no delay at all — a tight loop against a dead link, on a box whose
    entire job is to sit quietly through outages and come back.
    """
    return pending and beacon_ok


async def apply_relay_speaker(
    relay,
    server_value: object,
    cache_path: Path = relaytarget.CACHE_PATH,
    configured: str | None = None,
) -> None:
    """Point the relay at whatever the server says, if it says anything.

    The server is not trusted to be the only gate — the same stance the command
    allowlist takes, and for the same reason: this value becomes an argv
    element. Anything malformed is refused and the live target is left alone.

    The decision is cached locally because the box has to come back up relaying
    to the right speaker after a power cut, in a room where nobody is present
    and the network may not return first.
    """
    if relay is None:
        return

    server = relaytarget.from_server(server_value)
    if server is None:
        return  # no opinion, including a value we refused

    wanted = relaytarget.resolve(server, None, configured)
    if wanted == relay.target:
        # Still cache it: the server's opinion may be new even when the
        # resulting target is not, and an uncached "off" would be undone by
        # config.toml on the next boot.
        relaytarget.write_cache(cache_path, server)
        return

    try:
        await relay.set_target(wanted)
    except Exception:
        log.exception("could not point the relay at %s", wanted)
        return
    relaytarget.write_cache(cache_path, server)


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
    relay=None,
    interval_s: float = IDLE_INTERVAL_S,
    active_interval_s: float = ACTIVE_INTERVAL_S,
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

    ATTENTIVE MODE. After a command is picked up the loop polls every few
    seconds for a few minutes, because somebody is standing at the admin screen
    waiting on a round trip. Without it, choosing a speaker costs up to a full
    idle interval before the Pi even hears about it and another before the
    answer comes back — longer than a speaker stays in pairing mode.

    The first press still waits out one idle interval, and nothing here can fix
    that: no message can reach the Pi until it next checks in. The admin screen
    solves it by ordering the instructions so the wait happens BEFORE the
    speaker is put into pairing mode, not during it.
    """
    pending_result: dict | None = None
    pending_scan: dict | None = None
    pending_report: dict | None = None
    attentive_deadline: float | None = None

    async with httpx.AsyncClient(
        base_url=config.api_base_url,
        headers={"X-Device-Key": config.device_key},
        timeout=15.0,
    ) as client:
        while True:
            beacon_ok = False
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
                if pending_scan is not None:
                    payload["scan"] = pending_scan
                if pending_report is not None:
                    payload["report"] = pending_report
                # What the audio arbiter actually selected, so the admin screen
                # can show USB / jack / relay rather than guessing from config.
                output = read_output()
                if output is not None:
                    payload["output"] = output
                if relay is not None:
                    # Whether the chosen speaker is actually playing, and why
                    # not when it is not. A selection that stores fine and then
                    # fails to connect is the likeliest thing to happen in a
                    # locker room, and the screen has to be able to say so.
                    payload["relay"] = {
                        "mac": relay.target,
                        "connected": relay.connected,
                        "last_error": relay.last_error,
                    }

                resp = await client.post("/api/pi/beacon", json=payload)

                if resp.status_code == 200:
                    beacon_ok = True
                    # Only clear these once the server has actually taken them,
                    # so a failed beacon does not lose the outcome.
                    pending_result = None
                    pending_scan = None
                    pending_report = None
                    body = resp.json() or {}

                    # The chosen speaker rides the response as state, not as a
                    # parameterised command. See the module docstring and the
                    # speaker selection design for why that distinction is
                    # load-bearing.
                    await apply_relay_speaker(
                        relay,
                        body.get("relay_speaker"),
                        configured=config.relay_speaker_mac,
                    )

                    # Which device the operator asked to forget. State, like
                    # the relay speaker, and validated here for the same
                    # reason: it becomes an argv element. Written to /run for
                    # bt-forget.sh to pick up when the command fires - the
                    # command is the trigger, this is only the target.
                    forgettarget.write(forgettarget.from_server(body.get("forget_device")))

                    command = body.get("command")
                    if command:
                        name = command.get("name", "")
                        log.info("command received: %s (%s)", name, command.get("id"))
                        # Somebody is at the admin screen. Pay attention for a
                        # while, so the next round trip is seconds not minutes.
                        attentive_deadline = attentive_until()

                        allowed, why = may_run(name, sessions)
                        if not allowed:
                            ok, out, devices, report = False, why, None, None
                        else:
                            # reboot never gets to report back.
                            ok, out, devices = await asyncio.to_thread(run_command, name)
                            # A dump or a repair log is a document, not a line.
                            # Split it: the body travels as its own payload, the
                            # summary stays in the command history. See
                            # report_payload() and migration 007.
                            out, report = report_payload(name, ok, out)
                        log.info("command %s -> ok=%s %s", name, ok, out[:200])
                        pending_result = {
                            "id": command.get("id"),
                            "ok": ok,
                            "output": out[:2000],
                        }
                        if devices is not None:
                            pending_scan = {
                                "at": datetime.now(timezone.utc).isoformat(),
                                "devices": devices,
                            }
                        if report is not None:
                            pending_report = report
                else:
                    log.warning("beacon rejected: http %d", resp.status_code)

            except httpx.HTTPError as exc:
                # Expected whenever the network is down. Not an error worth a
                # stack trace every minute - the next beacon is the retry.
                log.debug("beacon failed: %s", exc)
            except Exception:
                log.exception("beacon loop failed unexpectedly")

            # Something to say, so say it now rather than sleeping on it. This
            # is half the latency of a command: the result used to wait out a
            # full cycle before being reported.
            if should_report_now(
                pending=pending_result is not None
                or pending_scan is not None
                or pending_report is not None,
                beacon_ok=beacon_ok,
            ):
                continue

            # Wait, but wake early if what the site shows has changed.
            before = play_signature(sessions)
            if attentive_deadline is not None and time.monotonic() < attentive_deadline:
                delay = ATTENTIVE_INTERVAL_S
            else:
                attentive_deadline = None
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
