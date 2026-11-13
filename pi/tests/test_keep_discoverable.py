"""keep-discoverable.sh can hold the adapter's link mode at CENTRAL.

OFF by default since 2026-11-13: iOS refused the role switch on hardware, so
the experiment changed nothing. These tests turn it on explicitly to keep the
mechanism honest in case it is ever wanted again.

Driven for real with fake hciconfig/bluetoothctl on PATH. The fake hciconfig
keeps its link mode in a file and, like the real one, accepts only the
spelling of its own BlueZ version.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "keep-discoverable.sh"

FAKE_HCICONFIG = """#!/bin/bash
# usage: hciconfig hci0 lm [mode]
echo "$*" >> "$STATE_DIR/calls"
[ "$2" = "lm" ] || exit 0
if [ -n "${3:-}" ]; then
  case "$3" in
    *"$SPELLING"*) echo "${SPELLING^^} ACCEPT" > "$STATE_DIR/lm" ;;
    *) echo "Invalid link mode" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "Link mode: $(cat "$STATE_DIR/lm")"
"""


def make_bin(tmp_path: Path, name: str, body: str) -> None:
    p = tmp_path / "bin" / name
    p.parent.mkdir(exist_ok=True)
    p.write_text(body)
    p.chmod(p.stat().st_mode | stat.S_IEXEC)


def run(tmp_path: Path, start_lm: str, spelling: str = "central", **extra):
    make_bin(tmp_path, "hciconfig", FAKE_HCICONFIG)
    make_bin(tmp_path, "bluetoothctl", "#!/bin/bash\nexit 0\n")
    (tmp_path / "lm").write_text(start_lm + "\n")
    env = dict(os.environ, PATH=f"{tmp_path / 'bin'}:{os.environ['PATH']}",
               STATE_DIR=str(tmp_path), SPELLING=spelling)
    env.setdefault("AUXGOAT_PREFER_CENTRAL", "1")
    env.update(extra)
    if env.get("AUXGOAT_PREFER_CENTRAL") == "default":
        del env["AUXGOAT_PREFER_CENTRAL"]
    result = subprocess.run(["bash", str(SCRIPT), "--once"], env=env,
                            capture_output=True, text=True, timeout=30)
    calls = (tmp_path / "calls").read_text() if (tmp_path / "calls").exists() else ""
    return result, (tmp_path / "lm").read_text().strip(), calls


def test_peripheral_is_switched_to_central(tmp_path):
    result, lm, _ = run(tmp_path, "PERIPHERAL ACCEPT")
    assert result.returncode == 0
    assert lm == "CENTRAL ACCEPT"
    assert "link mode set to central" in result.stdout


def test_older_bluez_spelling_master_is_used_when_central_is_refused(tmp_path):
    _, lm, calls = run(tmp_path, "SLAVE ACCEPT", spelling="master")
    assert lm == "MASTER ACCEPT"
    assert "lm accept,central" in calls and "lm accept,master" in calls


def test_already_central_is_left_alone_and_quiet(tmp_path):
    """It runs every five seconds; it must not rewrite or log every time."""
    result, lm, calls = run(tmp_path, "CENTRAL ACCEPT")
    assert lm == "CENTRAL ACCEPT"
    assert "accept," not in calls
    assert result.stdout == ""


def test_switched_off_touches_nothing(tmp_path):
    _, lm, calls = run(tmp_path, "PERIPHERAL ACCEPT", AUXGOAT_PREFER_CENTRAL="0")
    assert lm == "PERIPHERAL ACCEPT"
    assert calls == ""


def test_a_refused_switch_is_reported_and_the_loop_survives(tmp_path):
    result, lm, _ = run(tmp_path, "PERIPHERAL ACCEPT", spelling="nothing-matches")
    assert result.returncode == 0
    assert lm == "PERIPHERAL ACCEPT"
    assert "could not set link mode" in result.stdout


def test_off_by_default_since_ios_refused_it(tmp_path):
    _, lm, calls = run(tmp_path, "PERIPHERAL ACCEPT", AUXGOAT_PREFER_CENTRAL="default")
    assert lm == "PERIPHERAL ACCEPT"
    assert calls == ""
