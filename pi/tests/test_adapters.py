"""Adapter roles by bus, never by number. See lockerroom/adapters.py."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import adapters  # noqa: E402

PI = Path(__file__).resolve().parents[1]


def fake_tree(tmp_path: Path, spec: dict[str, str]) -> Path:
    """spec: {"hci0": "uart", "hci1": "usb", "hci0:12": "uart"}"""
    sysfs = tmp_path / "class_bluetooth"
    devices = tmp_path / "devices"
    sysfs.mkdir(parents=True)
    for name, bus in spec.items():
        target = devices / ("platform/soc/serial0/serial0-0" if bus == "uart"
                            else "platform/scb/usb1/1-1/1-1.3/1-1.3:1.0") / name
        target.mkdir(parents=True)
        (sysfs / name).mkdir()
        os.symlink(target, sysfs / name / "device")
    return sysfs


def test_built_in_only_is_todays_single_adapter(tmp_path):
    r = adapters.roles(fake_tree(tmp_path, {"hci0": "uart"}))
    assert (r.phones, r.relay, r.uart, r.split) == ("hci0", "hci0", "hci0", False)


def test_a_dongle_takes_the_phones_and_the_built_in_keeps_the_relay(tmp_path):
    r = adapters.roles(fake_tree(tmp_path, {"hci0": "uart", "hci1": "usb"}))
    assert (r.phones, r.relay, r.uart, r.split) == ("hci1", "hci0", "hci0", True)


def test_numbers_swapped_after_a_rebind_still_give_the_same_roles(tmp_path):
    """btwatch's rebind re-creates the built-in adapter under the next number."""
    r = adapters.roles(fake_tree(tmp_path, {"hci0": "usb", "hci1": "uart"}))
    assert (r.phones, r.relay, r.uart) == ("hci0", "hci1", "hci1")


def test_dongle_alone_does_both_and_reports_no_built_in(tmp_path):
    r = adapters.roles(fake_tree(tmp_path, {"hci2": "usb"}))
    assert (r.phones, r.relay, r.uart, r.split) == ("hci2", "hci2", None, False)


def test_connection_entries_are_not_adapters(tmp_path):
    r = adapters.roles(fake_tree(tmp_path, {"hci0": "uart", "hci0:12": "uart"}))
    assert r.split is False and r.phones == "hci0"


def test_nothing_at_all(tmp_path):
    r = adapters.roles(tmp_path / "missing")
    assert (r.phones, r.relay, r.uart, r.split) == (None, None, None, False)


def test_only_split_mode_keeps_phones_off_the_relay_adapter(tmp_path):
    split = fake_tree(tmp_path / "a", {"hci0": "uart", "hci1": "usb"})
    single = fake_tree(tmp_path / "b", {"hci0": "uart"})
    path = "/org/bluez/hci0/dev_5C_AD_BA_F0_B2_61"
    assert adapters.on_relay_only_adapter(path, split)
    assert not adapters.on_relay_only_adapter("/org/bluez/hci1/dev_5C_AD_BA_F0_B2_61", split)
    assert not adapters.on_relay_only_adapter(path, single)


def test_the_cli_prints_shell_assignments(tmp_path):
    sysfs = fake_tree(tmp_path, {"hci0": "uart", "hci1": "usb"})
    env = dict(os.environ, AUXGOAT_BT_SYSFS=str(sysfs), PYTHONPATH=str(PI))
    out = subprocess.run([sys.executable, "-m", "lockerroom.adapters"], env=env,
                         capture_output=True, text=True, timeout=30).stdout
    assert out.splitlines() == ["PHONES=hci1", "RELAY=hci0", "UART=hci0", "SPLIT=1"]
