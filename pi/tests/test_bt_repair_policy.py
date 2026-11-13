"""bt-repair-policy.sh: a phone that forgot this box can pair with it again.

Driven for real against a fake main.conf, with the bluetoothd restart replaced
by a command that records it was called.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bt-repair-policy.sh"
REPAIR_SH = SCRIPT.parent / "remote-repair.sh"
PROVISION_SH = SCRIPT.parent / "provision.sh"

STOCK = """\
[General]
#Name = BlueZ
#Class = 0x000100
#JustWorksRepairing = never
#Privacy = off

[Policy]
#AutoEnable=true
"""


def run(tmp_path: Path, conf_text: str | None, *args: str):
    conf = tmp_path / "main.conf"
    if conf_text is not None:
        conf.write_text(conf_text)
    marker = tmp_path / "restarted"
    env = dict(os.environ, BT_MAIN_CONF=str(conf), BT_RESTART_CMD=f"touch {marker}")
    result = subprocess.run(["bash", str(SCRIPT), *args], env=env,
                            capture_output=True, text=True, timeout=30)
    text = conf.read_text() if conf.exists() else None
    return result, text, marker.exists()


def lines(text: str) -> list[str]:
    return [l for l in text.splitlines() if "JustWorksRepairing" in l]


def test_stock_commented_default_is_replaced_and_bluetooth_restarted(tmp_path):
    result, text, restarted = run(tmp_path, STOCK)
    assert result.returncode == 0, result.stdout + result.stderr
    assert lines(text) == ["JustWorksRepairing = always"]
    assert text.index("JustWorksRepairing") < text.index("[Policy]")
    assert restarted


def test_an_explicit_never_is_replaced(tmp_path):
    _, text, restarted = run(tmp_path, "[General]\nJustWorksRepairing = never\n")
    assert lines(text) == ["JustWorksRepairing = always"]
    assert restarted


def test_missing_key_is_added_under_general(tmp_path):
    _, text, _ = run(tmp_path, "[General]\nClass = 0x200414\n\n[Policy]\n")
    assert lines(text) == ["JustWorksRepairing = always"]
    assert text.index("[General]") < text.index("JustWorksRepairing") < text.index("[Policy]")


def test_second_run_changes_nothing_and_does_not_restart(tmp_path):
    """Nobody watches a repair; pressing it twice must not drop phones twice."""
    run(tmp_path, STOCK)
    (tmp_path / "restarted").unlink()
    before = (tmp_path / "main.conf").read_text()
    result, text, restarted = run(tmp_path, None)
    assert result.returncode == 0
    assert text == before
    assert not restarted
    assert "already set" in result.stdout


def test_no_restart_flag_writes_but_does_not_restart(tmp_path):
    _, text, restarted = run(tmp_path, STOCK, "--no-restart")
    assert lines(text) == ["JustWorksRepairing = always"]
    assert not restarted


def test_missing_conf_fails_loudly(tmp_path):
    result, text, restarted = run(tmp_path, None)
    assert result.returncode != 0
    assert text is None and not restarted


def test_the_real_restart_never_drags_the_listener_with_it():
    """lockerroom-listener Requires= bluetooth; see test_run_repair_guard.py."""
    body = SCRIPT.read_text()
    default = body.split('BT_RESTART_CMD:-', 1)[1].split("}", 1)[0]
    assert "systemctl restart" in default
    assert "--job-mode=ignore-dependencies" in default


def test_repair_and_provision_both_call_it():
    repair = REPAIR_SH.read_text()
    assert "bt-repair-policy.sh" in repair
    # Before the units block, so bluealsa and bt-agent restart against the new daemon.
    assert repair.index("bt-repair-policy.sh") < repair.index("===== units: enable + restart")
    assert "bt-repair-policy.sh\" --no-restart" in PROVISION_SH.read_text()
