"""The Bluetooth controller can hard hang with every unit still green.

On 2026-08-23 both devices dropped in the same instant and dmesg filled with
`Bluetooth: hci0: Opcode 0x0c03 failed: -110` — HCI_Reset going unanswered. In
that state `systemctl restart bluetooth`, `hciconfig hci0 up` and `btmgmt power
on` ALL fail while every service still reports active. That is a dead speaker
in a locker room nobody can reach.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "btwatch.sh"

HEALTHY = "hci0:\tType: Primary  Bus: UART\n\tBD Address: 98:FE:54:34:14:13\n\tUP RUNNING PSCAN ISCAN"
DOWN = "hci0:\tType: Primary  Bus: UART\n\tBD Address: 98:FE:54:34:14:13\n\tDOWN"


def run(tmp_path: Path, hci_output: str) -> dict:
    """Fake hciconfig on PATH; RECOVER_CMD stands in for the rebind so the
    test never touches /sys."""
    fake = tmp_path / "hciconfig"
    fake.write_text("#!/bin/bash\ncat <<'HCIEOF'\n" + hci_output + "\nHCIEOF\n")
    fake.chmod(0o755)
    recovered = tmp_path / "recovered"
    proc = subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        env={
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "BTWATCH_ONESHOT": "1",
            "RECOVER_CMD": f"touch {recovered}",
        },
    )
    return {
        "rc": proc.returncode,
        "out": proc.stdout + proc.stderr,
        "recovered": recovered.exists(),
    }


def test_healthy_controller_is_left_alone(tmp_path):
    r = run(tmp_path, HEALTHY)
    assert not r["recovered"]
    assert r["rc"] == 0


def test_down_controller_triggers_recovery(tmp_path):
    r = run(tmp_path, DOWN)
    assert r["recovered"]


def test_missing_controller_triggers_recovery(tmp_path):
    """hciconfig prints nothing at all when the adapter has vanished."""
    r = run(tmp_path, "")
    assert r["recovered"]


def test_up_without_running_is_not_healthy(tmp_path):
    """UP alone is not enough — the wedged state can still report UP."""
    r = run(tmp_path, "hci0:\tType: Primary  Bus: UART\n\tUP PSCAN")
    assert r["recovered"]


def test_recovery_is_announced(tmp_path):
    """It must be findable in the journal after the fact."""
    r = run(tmp_path, DOWN)
    assert "wedged" in r["out"].lower()
