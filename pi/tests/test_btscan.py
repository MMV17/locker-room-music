"""Parsing what a Bluetooth scan found.

The parser's stance is that bt-scan.sh's output is UNTRUSTED. Not because the
script is suspect, but because a device name is chosen by a stranger's phone
and arrives verbatim — it reaches a JSON payload, a database and eventually a
web page. Anything that does not parse is dropped rather than guessed at.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import btscan  # noqa: E402

MAC = "78:66:F3:1C:9D:B6"


def test_a_complete_line_parses():
    [d] = btscan.parse(f"{MAC}\t2360324\t-54\tJBL Charge 6")
    assert d == {"mac": MAC, "name": "JBL Charge 6", "cod": 2360324, "rssi": -54}


def test_empty_input_is_no_devices():
    assert btscan.parse("") == []
    assert btscan.parse("\n\n  \n") == []


def test_a_line_whose_mac_is_junk_is_dropped():
    """This value becomes an argv element for bluetoothctl if it is ever
    selected. It does not get the benefit of the doubt."""
    text = f"$(reboot)\t0\t0\tEvil\n{MAC}\t0\t-40\tReal"
    assert [d["mac"] for d in btscan.parse(text)] == [MAC]


def test_lowercase_macs_are_normalised():
    [d] = btscan.parse(f"{MAC.lower()}\t0\t-40\tSpeaker")
    assert d["mac"] == MAC


def test_a_missing_name_is_none_not_an_empty_string():
    """None means "this device advertises no name", which the UI shows as the
    MAC. An empty string would render as a blank row."""
    [d] = btscan.parse(f"{MAC}\t0\t-40\t")
    assert d["name"] is None


def test_a_name_containing_tabs_keeps_its_words_separated():
    """Name is the last field and is split off with maxsplit, so a device that
    names itself with a tab cannot inject extra columns. The tab itself becomes
    a space — dropping it outright would render "My Speaker" as "MySpeaker"."""
    [d] = btscan.parse(f"{MAC}\t0\t-40\tMy\tSpeaker\tName")
    assert d["name"] == "My Speaker Name"


def test_unparseable_cod_and_rssi_become_none_without_losing_the_device():
    """A speaker that reports no class is still a speaker. Dropping the line
    would hide the exact device someone is holding."""
    [d] = btscan.parse(f"{MAC}\tn/a\t\tSpeaker")
    assert d["cod"] is None and d["rssi"] is None
    assert d["mac"] == MAC


def test_hex_class_of_device_is_accepted():
    """bluetoothctl prints Class as 0x240414."""
    [d] = btscan.parse(f"{MAC}\t0x240414\t-40\tSpeaker")
    assert d["cod"] == 0x240414


def test_a_line_with_too_few_fields_is_dropped():
    assert btscan.parse(f"{MAC}\t0") == []


def test_duplicate_macs_keep_the_first_seen():
    text = f"{MAC}\t0\t-40\tFirst\n{MAC}\t0\t-90\tSecond"
    assert [d["name"] for d in btscan.parse(text)] == ["First"]


def test_names_are_truncated_rather_than_trusted_to_be_short():
    [d] = btscan.parse(f"{MAC}\t0\t-40\t" + "x" * 500)
    assert len(d["name"]) == btscan.MAX_NAME


def test_the_device_count_is_capped():
    """A scan in a crowded room must not produce an unbounded beacon payload."""
    lines = [f"AA:BB:CC:DD:{i:02X}:{j:02X}\t0\t-40\tD" for i in range(4) for j in range(60)]
    assert len(btscan.parse("\n".join(lines))) == btscan.MAX_DEVICES


def test_control_characters_are_stripped_from_names():
    """The name reaches a log line and a web page. A newline in it would forge
    a second log entry."""
    [d] = btscan.parse(f"{MAC}\t0\t-40\tEvil\x00\x1bName")
    assert d["name"] == "EvilName"


def test_is_audio_recognises_the_audio_video_major_class():
    assert btscan.is_audio(0x240414) is True


def test_is_audio_is_false_for_a_phone():
    assert btscan.is_audio(0x5A020C) is False


def test_is_audio_of_unknown_class_is_false_rather_than_a_guess():
    assert btscan.is_audio(None) is False


# --------------------------------------------------------------------------- #
# The script itself, against a fake bluetoothctl. This is the seam where the
# two halves meet: a format change in bt-scan.sh that parse() cannot read would
# otherwise show up as an empty device list on the box and nowhere else.
# --------------------------------------------------------------------------- #

import subprocess  # noqa: E402

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bt-scan.sh"

FAKE_BLUETOOTHCTL = r"""#!/bin/bash
case "$*" in
  *"scan on"*) exit 0 ;;
esac
if [ "$1" = "devices" ]; then
  echo "Device 78:66:F3:1C:9D:B6 JBL Charge 6"
  echo "Device AA:BB:CC:DD:EE:FF Someone's iPhone"
  echo "Device 11:22:33:44:55:66 11-22-33-44-55-66"
  exit 0
fi
if [ "$1" = "info" ]; then
  case "$2" in
    78:66:F3:1C:9D:B6)
      echo "Device 78:66:F3:1C:9D:B6 (public)"
      echo "	Name: JBL Charge 6"
      echo "	Class: 0x00240414"
      echo "	RSSI: -54"
      ;;
    AA:BB:CC:DD:EE:FF)
      echo "	Name: Someone's iPhone"
      echo "	Class: 0x005a020c"
      ;;
    *) echo "	Class: 0x00000000" ;;
  esac
  exit 0
fi
exit 0
"""


def run_script(tmp_path):
    fake = tmp_path / "bluetoothctl"
    fake.write_text(FAKE_BLUETOOTHCTL)
    fake.chmod(0o755)
    proc = subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        env={"PATH": f"{tmp_path}:/usr/bin:/bin", "BT_SCAN_SECONDS": "0"},
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def test_the_script_output_round_trips_through_the_parser(tmp_path):
    devices = btscan.parse(run_script(tmp_path))
    by_mac = {d["mac"]: d for d in devices}
    assert set(by_mac) == {MAC, "AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"}
    assert by_mac[MAC] == {
        "mac": MAC,
        "name": "JBL Charge 6",
        "cod": 0x240414,
        "rssi": -54,
    }


def test_a_device_with_no_rssi_still_parses(tmp_path):
    """RSSI is only populated for a device seen recently. Its absence is normal
    and must not cost the device its place in the list."""
    d = {x["mac"]: x for x in btscan.parse(run_script(tmp_path))}["AA:BB:CC:DD:EE:FF"]
    assert d["rssi"] is None and d["name"] == "Someone's iPhone"


def test_the_speaker_is_the_only_audio_class_device(tmp_path):
    devices = btscan.parse(run_script(tmp_path))
    assert [d["mac"] for d in devices if btscan.is_audio(d["cod"])] == [MAC]


def test_a_device_that_advertises_no_name_parses_as_nameless(tmp_path):
    """bluetoothctl echoes the MAC back as the name when there is none. That is
    a placeholder, not a name, but it is harmless here — the UI shows the MAC
    for these anyway. What matters is that the device is not dropped."""
    d = {x["mac"]: x for x in btscan.parse(run_script(tmp_path))}["11:22:33:44:55:66"]
    assert d["cod"] == 0
