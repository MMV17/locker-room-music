"""A MAC that is nearly right must be refused, not repaired.

These values become argv elements for bluetoothctl and for the audio player.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.macaddr import normalise  # noqa: E402


def test_none_and_empty_are_both_unconfigured():
    assert normalise(None) is None
    assert normalise("") is None
    assert normalise("   ") is None


def test_valid_mac_is_uppercased():
    assert normalise("78:66:f3:1c:9d:b6") == "78:66:F3:1C:9D:B6"


def test_surrounding_whitespace_is_tolerated():
    assert normalise("  78:66:F3:1C:9D:B6\n") == "78:66:F3:1C:9D:B6"


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-mac",
        "78:66:F3:1C:9D",              # too short
        "78:66:F3:1C:9D:B6:AA",        # too long
        "78-66-F3-1C-9D-B6",           # wrong separator
        "78:66:F3:1C:9D:GG",           # not hex
        "78:66:F3:1C:9D:B6 extra",     # would become a second argv element
        "78:66:F3:1C:9D:B6; rm -rf /", # would matter if this ever hit a shell
        "$(id)",
    ],
)
def test_malformed_is_rejected(bad):
    with pytest.raises(ValueError, match="not a MAC address"):
        normalise(bad)


def test_the_field_name_reaches_the_error():
    """So the operator is told WHICH setting is wrong, not just that one is."""
    with pytest.raises(ValueError, match="speaker_mac"):
        normalise("nope", field="[relay] speaker_mac")
