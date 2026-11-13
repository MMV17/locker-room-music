"""The report's "who was routed" filter, run for real against fake logs.

Written after a dropped space glued the grep pattern to the first log file's
name (2026-11-13): the section silently read one file and matched nothing new.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPORT = Path(__file__).resolve().parents[1] / "scripts" / "report-full.sh"


def filter_command() -> str:
    for line in REPORT.read_text().splitlines():
        if line.startswith("run 10 sh -c \"grep -h 'is streaming"):
            return re.match(r'run 10 sh -c "(.*)"$', line).group(1)
    raise AssertionError("the routing filter line is missing from report-full.sh")


def test_it_reads_both_logs_and_matches_every_line_it_promises(tmp_path):
    (tmp_path / "listener.log.1").write_text(
        "x INFO waiting phone 21:B0 is streaming (transport pending) while B2:61 holds the aux\n"
        "x INFO unrelated chatter\n"
    )
    (tmp_path / "listener.log").write_text(
        "x INFO aux granted to Mack's iPhone (5C:AD:BA:F0:B2:61)\n"
        "x WARNING Mack's iPad holds the aux but its audio connection is gone (still connected)\n"
        "x INFO asked Mack's iPad to reconnect its audio\n"
        "x WARNING released the aux from Mack's iPad: its audio connection is gone\n"
        "x INFO the audio connection of Mack's iPad is back\n"
        "x INFO dropped the audio stream of waiting phone Mack's iPad (21:B0)\n"
        "x INFO speaker routed to 5C:AD:BA:F0:B2:61\n"
        "x WARNING lockerroom.relay: relay speaker 78:66:F3:1C:9D:B6 is connected but the player cannot open it\n"
    )
    cmd = filter_command().replace("/var/log/lockerroom", str(tmp_path))
    out = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, timeout=10).stdout

    assert "is streaming" in out                      # from the OLDER file
    for needle in ("aux granted", "audio connection is gone", "reconnect its audio",
                   "released the aux", "is back", "dropped the audio stream",
                   "speaker routed to", "lockerroom.relay"):
        assert needle in out, needle
    assert "unrelated chatter" not in out
