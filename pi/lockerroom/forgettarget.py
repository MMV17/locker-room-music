"""Which device the operator asked us to forget, arriving on the beacon.

WHY THIS IS STATE AND NOT A COMMAND ARGUMENT. `forget-selected-phone` is on
the command allowlist, and nothing on that list takes a parameter — that is
the property the whole control channel is built to protect. So the two halves
travel differently, exactly as they do for the relay speaker:

    forgetting        an ACTION with no parameters -> an allowlisted name
    WHICH device      a FACT about what the operator picked -> a settings row,
                      carried down on the beacon response and validated here

See docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md, which
wrote the rule down for the speaker picker, and the module docstring in
control.py.

WHY /run AND NOT /var/lib, which is the opposite of relaytarget: this file
means "an operator asked for this, and it has not happened yet". That is
pending work, not configuration. It MUST NOT survive a reboot — a forget
request that outlived a power cut would fire days later against a phone
somebody had since re-paired, which is the exact lockout this feature exists
to end.

Dependency-free for the same reason macaddr.py and relaytarget.py are:
config.py imports tomllib (3.11+) and the laptop's test venv is 3.9, so
anything that needs testing stays out of its import graph.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from .macaddr import normalise as _normalise_mac

log = logging.getLogger("lockerroom.forgettarget")

# /run is tmpfs. See the docstring: that is deliberate, not an oversight.
TARGET_PATH = Path("/run/lockerroom/forget-target")


def from_server(value: object) -> str | None:
    """Normalise what arrived on the beacon into a MAC, or None.

    The server is NOT trusted to be the only gate — the same stance the
    command allowlist takes, and for the same reason: this value ends up as an
    argv element handed to bluetoothctl. Anything that is not a well-formed
    MAC is refused and logged.

    There is no empty-string case here, unlike relaytarget. "" is meaningful
    for a relay speaker because "explicitly off" is a real state; there is no
    such thing as explicitly forgetting nothing.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        log.warning("forget_device from server was %s, not a string", type(value).__name__)
        return None
    if value == "":
        return None
    try:
        return _normalise_mac(value, field="forget_device from server")
    except ValueError as exc:
        log.warning("refusing forget target from server: %s", exc)
        return None


def write(value: str | None, path: Path = TARGET_PATH) -> None:
    """Record the pending request, atomically.

    Atomic because bt-forget.sh reads this file as an argv source: a
    half-written MAC is a string that passes a naive length check and names
    the wrong device. None removes the file, which is the only honest way to
    store "nothing pending".
    """
    path = Path(path)
    if value is None:
        try:
            path.unlink()
        except OSError:
            pass
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".forget-target-")
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


def read(path: Path = TARGET_PATH) -> str | None:
    """The pending request, or None. A corrupt file reads as nothing pending."""
    try:
        text = Path(path).read_text().strip()
    except OSError:
        return None
    if not text:
        return None
    try:
        return _normalise_mac(text, field="pending forget target")
    except ValueError:
        log.warning("ignoring unreadable forget target at %s", path)
        return None
