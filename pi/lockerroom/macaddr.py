"""One place that decides what a MAC address is.

Its own module, and deliberately free of every dependency, for two reasons:

  - `config.py` needs `tomllib` (3.11+) and is therefore UNIMPORTABLE in the
    laptop's 3.9 test venv — the same constraint that made control.py import
    config only under TYPE_CHECKING. Validation living here is testable
    everywhere; validation living in config.py would be testable nowhere.
  - config.py and relay.py both need it, and two copies of a security-relevant
    regex is how they drift.

Values that reach here become argv elements for `bluetoothctl` and for the
audio player. They are REJECTED rather than sanitised: there is no partial
credit for something that is nearly a MAC address.
"""
from __future__ import annotations

import re

MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")


def normalise(value: str | None, *, field: str = "mac") -> str | None:
    """Uppercase MAC, or None if empty/absent. Raises ValueError if malformed.

    Empty and absent are the same answer — None — because "the relay is not
    configured" and "the relay is configured to nothing" must behave
    identically, and the whole safety property of this feature is that an
    unconfigured box behaves exactly as it did before.
    """
    text = (value or "").strip()
    if not text:
        return None
    if not MAC_RE.match(text):
        raise ValueError(
            f"{field} is not a MAC address: {text!r}. Expected AA:BB:CC:DD:EE:FF."
        )
    return text.upper()
