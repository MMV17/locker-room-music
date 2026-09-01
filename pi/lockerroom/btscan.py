"""Parses the output of bt-scan.sh into devices the Admin screen can offer.

This module treats its input as UNTRUSTED. Not because bt-scan.sh is suspect,
but because a device NAME is chosen by a stranger's phone and travels verbatim
from here into a JSON payload, a database and a web page. A MAC from here can
become an argv element for bluetoothctl if someone selects it. So anything that
does not parse cleanly is dropped rather than guessed at, names are truncated
and stripped of control characters, and the device count is capped so a scan in
a crowded room cannot produce an unbounded beacon payload.

Dependency-free, like macaddr.py and for the same reason: config.py imports
tomllib (3.11+) and the laptop's test venv is 3.9.
"""
from __future__ import annotations

from .macaddr import normalise as _normalise_mac

# Bluetooth Class of Device: the major device class is bits 8-12. 0x04 is
# Audio/Video, which is what a speaker should report.
_MAJOR_SHIFT = 8
_MAJOR_MASK = 0x1F
_MAJOR_AUDIO = 0x04

MAX_NAME = 64
# A locker room at full capacity is maybe forty devices. The cap is a bound on
# the payload, not a judgement about how many speakers exist.
MAX_DEVICES = 120


def is_audio(cod: int | None) -> bool:
    """Whether the device says it is audio gear.

    Self-reported, and some speakers report it wrongly or not at all — which is
    exactly why the UI SORTS on this rather than filtering on it. An unknown
    class is False, not a guess: it sorts with the rest instead of being
    promoted or hidden.
    """
    if cod is None:
        return False
    return (cod >> _MAJOR_SHIFT) & _MAJOR_MASK == _MAJOR_AUDIO


def _int_or_none(text: str) -> int | None:
    """Accepts decimal and the 0x form bluetoothctl prints for Class."""
    text = text.strip()
    if not text:
        return None
    try:
        return int(text, 16) if text.lower().startswith("0x") else int(text, 10)
    except ValueError:
        return None


def _clean_name(text: str) -> str | None:
    """None means the device advertises no name, which the UI renders as the
    MAC. An empty string would render as a blank row, which is worse: it looks
    like a bug rather than like a nameless device.

    Control characters go because this string reaches a log line, where an
    embedded newline would forge a second entry. Whitespace ones become a
    space rather than vanishing, so a speaker that separates its words with a
    tab reads as "My Speaker" and not "MySpeaker". Column injection is already
    impossible — parse() splits the name off last, with maxsplit.
    """
    cleaned = "".join(
        " " if c.isspace() else c for c in text if c.isprintable() or c.isspace()
    )
    return " ".join(cleaned.split())[:MAX_NAME].strip() or None


def parse(text: str) -> list[dict]:
    """One dict per device, in the order found, first sighting winning.

    bt-scan.sh emits MAC<TAB>COD<TAB>RSSI<TAB>name. Name is last and is split
    off with maxsplit, so a device that names itself with a tab cannot inject
    extra columns.
    """
    devices: list[dict] = []
    seen: set[str] = set()

    for line in (text or "").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 3)
        if len(parts) < 4:
            continue

        raw_mac, raw_cod, raw_rssi, raw_name = parts
        try:
            mac = _normalise_mac(raw_mac.strip(), field="scanned device")
        except ValueError:
            # Not a MAC. This value would become an argv element if selected,
            # so it does not get the benefit of the doubt.
            continue
        if mac is None or mac in seen:
            continue

        seen.add(mac)
        devices.append(
            {
                "mac": mac,
                "name": _clean_name(raw_name),
                "cod": _int_or_none(raw_cod),
                "rssi": _int_or_none(raw_rssi),
            }
        )
        if len(devices) >= MAX_DEVICES:
            break

    return devices
