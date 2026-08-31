"""Config exposes the relay speaker, and refuses a malformed one.

SKIPPED on the laptop's 3.9 venv: config.py needs tomllib (3.11+), the same
constraint that makes control.py import config only under TYPE_CHECKING. The
validation itself is covered on every interpreter by test_macaddr.py; this file
covers the wiring, and runs on the Pi and on python3.14.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

pytest.importorskip("tomllib", reason="config.py needs Python 3.11+")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import config as cfg  # noqa: E402

BASE = 'api_base_url = "https://x.example.com"\ndevice_key = "k"\n'


def write(tmp_path: Path, extra: str = "") -> Path:
    p = tmp_path / "config.toml"
    p.write_text(BASE + extra)
    return p


def test_absent_relay_section_means_disabled(tmp_path):
    assert cfg.load(write(tmp_path)).relay_speaker_mac is None


def test_relay_mac_is_read_and_uppercased(tmp_path):
    c = cfg.load(write(tmp_path, '\n[relay]\nspeaker_mac = "78:66:f3:1c:9d:b6"\n'))
    assert c.relay_speaker_mac == "78:66:F3:1C:9D:B6"


def test_empty_mac_means_disabled(tmp_path):
    assert cfg.load(write(tmp_path, '\n[relay]\nspeaker_mac = ""\n')).relay_speaker_mac is None


def test_malformed_mac_stops_the_listener_with_a_clear_message(tmp_path):
    with pytest.raises(ValueError, match=r"\[relay\] speaker_mac"):
        cfg.load(write(tmp_path, '\n[relay]\nspeaker_mac = "not-a-mac"\n'))
