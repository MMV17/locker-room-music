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


# --------------------------------------------------------------------------- #
# The 2026-09-21 loop: 212 rebinds, nine hours, zero progress.
#
# An rfkill SOFT BLOCK survives an unbind/rebind, because the rebind destroys
# the rfkill device and creates a new one and systemd-rfkill restores the saved
# block onto it. So the watchdog re-applied the fault it was recovering from.
#
# These drive the real script with a FAKE BOX on PATH - rfkill, hciconfig and
# bluetoothctl backed by a state file - because the first version of these
# tests only grepped the script's source, and source-grep tests cannot fail for
# any of the defects that actually matter. Note especially that `rfkill` is in
# /usr/sbin on Debian and absent on a Mac, so without injecting it here
# `command -v rfkill` short-circuits and every line of recovery logic below is
# skipped while the suite still reports green.
# --------------------------------------------------------------------------- #


def box(tmp_path: Path, *, soft="no", hard="no", unblock_works=True) -> Path:
    """A fake adapter whose rfkill state drives what hciconfig reports."""
    state = tmp_path / "rfstate"
    state.write_text(f"{soft} {hard}\n")

    (tmp_path / "rfkill").write_text(f"""#!/bin/bash
read soft hard < "{state}"
case "$1" in
  list) printf '0: hci0: Bluetooth\\n\\tSoft blocked: %s\\n\\tHard blocked: %s\\n' "$soft" "$hard" ;;
  unblock) if [ "$hard" = no ] && [ "{int(unblock_works)}" = 1 ]; then printf 'no no\\n' > "{state}"; fi ;;
esac
exit 0
""")
    (tmp_path / "hciconfig").write_text(f"""#!/bin/bash
read soft hard < "{state}"
if [ "$soft" = no ] && [ "$hard" = no ]; then
  printf 'hci0:\\tType: Primary  Bus: UART\\n\\tUP RUNNING PSCAN ISCAN\\n'
else
  printf 'hci0:\\tType: Primary  Bus: UART\\n\\tDOWN\\n'
fi
exit 0
""")
    (tmp_path / "bluetoothctl").write_text("#!/bin/bash\nexit 0\n")
    (tmp_path / "sleep").write_text("#!/bin/bash\nexit 0\n")   # keep the suite fast
    for f in ("rfkill", "hciconfig", "bluetoothctl", "sleep"):
        (tmp_path / f).chmod(0o755)
    return tmp_path


def drive(tmp_path: Path, **env_extra) -> dict:
    recovered = tmp_path / "rebound"
    env = {
        "PATH": f"{tmp_path}:/usr/bin:/bin:/usr/sbin:/sbin",
        "BTWATCH_ONESHOT": "1",
        "RECOVER_CMD": f"touch {recovered}",
    }
    env.update(env_extra)
    proc = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)
    return {"out": proc.stdout, "rebound": recovered.exists(), "rc": proc.returncode}


class TestSoftBlockRecovery:
    def test_a_soft_block_is_cleared_without_rebinding(self, tmp_path):
        """The whole point. A rebind restarts the listener; clearing the block
        does not, so the cheap path has to actually win."""
        box(tmp_path, soft="yes")
        r = drive(tmp_path)
        assert "SOFT BLOCKED" in r["out"]
        assert "recovered by clearing the rfkill block" in r["out"]
        assert not r["rebound"], "must not tear the driver down for a mere soft block"

    def test_a_failed_unblock_is_named_and_still_rebinds(self, tmp_path):
        """If the clear does not take, saying so is the difference between a
        five minute diagnosis and the nine hour one."""
        box(tmp_path, soft="yes", unblock_works=False)
        r = drive(tmp_path)
        assert "DID NOT TAKE" in r["out"]
        assert "recovered by clearing" not in r["out"]
        assert r["rebound"], "a block that will not clear still deserves a rebind attempt"

    def test_a_hard_block_is_named_rather_than_silently_retried(self, tmp_path):
        """rfkill cannot clear a hard block, and the backoff advice used to
        point at 'Soft blocked', which reads fine in this case."""
        box(tmp_path, soft="no", hard="yes")
        r = drive(tmp_path)
        assert "HARD BLOCKED" in r["out"]
        assert "recovered by clearing" not in r["out"]

    def test_it_does_not_claim_an_unblock_it_never_performed(self, tmp_path):
        """Nothing was blocked; the adapter is down for some other reason. The
        journal must not send the next reader down the rfkill path."""
        box(tmp_path, soft="no")
        (tmp_path / "hciconfig").write_text(
            "#!/bin/bash\nprintf 'hci0:\\tType: Primary\\n\\tDOWN\\n'\nexit 0\n")
        (tmp_path / "hciconfig").chmod(0o755)
        r = drive(tmp_path)
        assert "recovered by clearing" not in r["out"]
        assert r["rebound"]

    def test_a_box_without_rfkill_still_recovers_the_old_way(self, tmp_path):
        """rfkill is not guaranteed to be installed. Its absence must not make
        the watchdog claim a clear, nor stop it rebinding."""
        box(tmp_path, soft="yes")
        (tmp_path / "rfkill").unlink()
        r = drive(tmp_path)
        assert "recovered by clearing" not in r["out"]
        assert r["rebound"]

    def test_a_healthy_adapter_is_left_alone(self, tmp_path):
        box(tmp_path)
        r = drive(tmp_path)
        assert not r["rebound"]
        assert "wedged" not in r["out"]


class TestBackoff:
    def test_recovery_is_rate_limited_after_repeated_failure(self, tmp_path):
        """Each recovery restarts the listener, so a watchdog that cannot win
        must stop hammering. Reachable only because MAX_CYCLES exists - the
        oneshot exit used to fire before this branch could ever run."""
        box(tmp_path, soft="yes", unblock_works=False)
        r = drive(tmp_path, BTWATCH_ONESHOT="0", BTWATCH_MAX_CYCLES="4",
                  BTWATCH_BACKOFF_AFTER="2", BTWATCH_BACKOFF_S="9999",
                  BTWATCH_INTERVAL_S="0")
        assert "rate-limiting recovery" in r["out"]
        assert r["out"].count("rebinding hci_uart_bcm") == 2, \
            "should stop attempting after BACKOFF_AFTER failures, not keep going"

    def test_a_nonsense_backoff_value_does_not_disable_the_backoff(self, tmp_path):
        """`[ x -ge never ]` prints 'integer expression expected' once a minute
        and evaluates false, which silently removes the rate limit."""
        box(tmp_path, soft="yes", unblock_works=False)
        r = drive(tmp_path, BTWATCH_ONESHOT="0", BTWATCH_MAX_CYCLES="4",
                  BTWATCH_BACKOFF_AFTER="never", BTWATCH_BACKOFF_S="9999",
                  BTWATCH_INTERVAL_S="0")
        assert "integer expression expected" not in r["out"]


# --------------------------------------------------------------------------- #
# The boot-time unblock.
#
# This one IS an assertion about file content, deliberately: a systemd unit is
# configuration, not code, and there is no behaviour to drive. The thing that
# must stay true is that SOMETHING clears an rfkill block before
# keep-discoverable starts trying to make the adapter discoverable - because
# bluetoothctl cannot, and its loop otherwise fails silently every 5 seconds.
# --------------------------------------------------------------------------- #

KEEP_DISC_UNIT = Path(__file__).resolve().parents[1] / "systemd" / "keep-discoverable.service"


class TestBootTimeUnblock:
    def test_the_unit_clears_a_soft_block_before_it_starts(self):
        body = KEEP_DISC_UNIT.read_text()
        pre = [l for l in body.splitlines() if l.startswith("ExecStartPre=")]
        assert pre, "nothing unblocks the radio before keep-discoverable runs"
        assert any("rfkill unblock" in l for l in pre)

    def test_the_unblock_cannot_stop_the_unit_starting(self):
        """`-` prefix. An unblock that fails - no rfkill installed, say - must
        not also cost us the discoverable loop."""
        pre = [l for l in KEEP_DISC_UNIT.read_text().splitlines()
               if l.startswith("ExecStartPre=") and "rfkill" in l]
        assert all(l.split("=", 1)[1].startswith("-") for l in pre)

    def test_it_uses_an_absolute_path(self):
        """systemd does not search PATH, and rfkill is in /usr/sbin."""
        pre = [l for l in KEEP_DISC_UNIT.read_text().splitlines()
               if l.startswith("ExecStartPre=") and "rfkill" in l]
        assert all("/usr/sbin/rfkill" in l for l in pre)
