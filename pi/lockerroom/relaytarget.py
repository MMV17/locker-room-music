"""Which speaker the box relays to, and where that answer survives a reboot.

Three sources can have an opinion, and they are consulted in this order:

    the server (on the beacon response) -> a local cache -> config.toml

**The three-state convention is the load-bearing detail.** Every value in this
module is one of:

    None  - no opinion. Ask the next source down.
    ""    - explicitly OFF. The operator pressed "Use wired output". Stop here.
    a MAC - relay to this speaker. Stop here.

Collapsing None and "" into a falsy check is the specific bug this module
exists to prevent: it would make "Use wired output" silently do nothing on any
box that has a [relay] speaker_mac in config.toml, because the file would keep
answering after the operator said no.

The cache is on /var/lib rather than /run on purpose. It must survive a power
cut, because the box has to come back up relaying to the right speaker in a
locker room where nobody is present and the network may not return first. That
is the opposite of /run/lockerroom/relay-target, whose entire meaning is "a
relay is live right now" and which MUST NOT survive a reboot.

Dependency-free for the same reason macaddr.py is: config.py imports tomllib
(3.11+) and the laptop's test venv is 3.9, so anything that needs testing has
to stay out of its import graph.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from .macaddr import normalise as _normalise_mac

log = logging.getLogger("lockerroom.relaytarget")

CACHE_PATH = Path("/var/lib/lockerroom/relay-target-mac")


def from_server(value: object) -> str | None:
    """Normalise what arrived on the beacon response into the convention.

    The server is NOT trusted to be the only gate — the same stance control.py
    takes on the command allowlist, and for the same reason: if it were ever
    compromised or misdeployed, this function is what stops a hostile string
    reaching a subprocess. Anything that is not a well-formed MAC or an
    explicit empty string is treated as "no opinion" and logged.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        log.warning("relay_speaker from server was %s, not a string", type(value).__name__)
        return None
    if value == "":
        return ""
    try:
        return _normalise_mac(value, field="relay_speaker from server")
    except ValueError as exc:
        log.warning("refusing relay speaker from server: %s", exc)
        return None


def read_cache(path: Path = CACHE_PATH) -> str | None:
    """The last thing the server told us, or None if it never has.

    A corrupt cache reads as "no opinion" rather than raising. The MAC is cheap
    to re-learn from the next beacon; a listener that crash-loops at startup in
    a room nobody can reach is not.
    """
    try:
        raw = Path(path).read_text()
    except OSError:
        return None
    text = raw.strip()
    if text == "":
        return ""
    try:
        return _normalise_mac(text, field="cached relay target")
    except ValueError:
        log.warning("ignoring unreadable relay target cache at %s", path)
        return None


def write_cache(path: Path, value: str | None) -> None:
    """Store the server's opinion, atomically.

    None removes the file, because the only honest way to store "no opinion" is
    to store nothing. Atomic because a power cut mid-write is exactly the event
    this file exists to survive — a half-written MAC would read as garbage and
    silently drop the box to wired output on the next boot.
    """
    path = Path(path)
    if value is None:
        try:
            path.unlink()
        except OSError:
            pass
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".relay-target-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(f"{value}\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def resolve(
    server: str | None, cached: str | None, configured: str | None
) -> str | None:
    """The speaker to relay to, or None for wired output.

    Returns None both for "nobody has an opinion" and for "somebody said off",
    because the caller does the same thing in either case. The distinction
    matters *between* the sources, not after them.
    """
    for source in (server, cached, configured):
        if source is None:
            continue
        return source or None
    return None
