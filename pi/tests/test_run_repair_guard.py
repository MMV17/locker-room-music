"""run-repair.sh must never leave the listener package modified.

The listener IS the control channel. A repair mechanism that can replace it can
destroy remote access while it is being used — push one bad commit and the box
is unreachable with no way to take the commit back, on a network where 7844 is
blocked, Tailscale is SNI-blocked and TCP/22 is filtered.

run-repair.sh snapshots the package before the repair runs and restores it
afterwards if anything changed. That is a claim about behaviour, so it is
tested as one: these drive the real script against throwaway directories with
a stubbed systemctl, sudo and git on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run-repair.sh"


@pytest.fixture
def box(tmp_path):
    """A fake Pi: a listener package, a repo with a repair script, stub binaries."""
    pkg = tmp_path / "pkg"
    (pkg / "lockerroom").mkdir(parents=True)
    (pkg / "control.py").write_text("ORIGINAL LISTENER CODE\n")
    (pkg / "lockerroom" / "main.py").write_text("ORIGINAL MAIN\n")

    repo = tmp_path / "repo"
    (repo / "pi" / "scripts").mkdir(parents=True)

    # Stubs, so nothing here touches a real service or the network. `git` fails,
    # which is itself the documented degraded path: no clone, run what is on
    # disk and say so.
    binv = tmp_path / "bin"
    binv.mkdir()
    for name in ("systemctl", "sudo", "git", "stat", "timeout"):
        stub = binv / name
        if name == "sudo":
            # `sudo -u X cmd...` -> just run cmd, so the git stub is reached.
            stub.write_text('#!/bin/sh\nwhile [ "$1" = "-u" ]; do shift 2; done\nexec "$@"\n')
        elif name == "stat":
            stub.write_text('#!/bin/sh\necho testuser\n')
        elif name == "timeout":
            # GNU coreutils. Present on the Pi, absent on macOS, and these
            # tests are about the integrity guard rather than about bounding.
            stub.write_text('#!/bin/sh\nshift\nexec "$@"\n')
        else:
            stub.write_text(f'#!/bin/sh\necho "[stub {name} $*]"\nexit 1\n')
        stub.chmod(0o755)

    env = dict(os.environ)
    env["LOCKERROOM_PKG"] = str(pkg)
    env["LOCKERROOM_REPO"] = str(repo)
    # Its own lock directory: never the real /run/lockerroom of whatever
    # machine is running the tests.
    env["AUXGOAT_RUN"] = str(tmp_path / "run")
    env["PATH"] = f"{binv}:{env['PATH']}"
    return {"pkg": pkg, "repo": repo, "env": env}


def run(box) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env=box["env"],
        capture_output=True,
        text=True,
        timeout=120,
    )


def write_repair(box, body: str) -> None:
    p = box["repo"] / "pi" / "scripts" / "remote-repair.sh"
    p.write_text("#!/usr/bin/env bash\n" + body)
    p.chmod(0o755)


def package_state(pkg: Path) -> dict[str, str]:
    return {
        str(f.relative_to(pkg)): f.read_text()
        for f in sorted(pkg.rglob("*"))
        if f.is_file()
    }


class TestListenerPackageIsProtected:
    def test_a_well_behaved_repair_leaves_the_package_alone(self, box):
        write_repair(box, 'echo "restarted some units"\n')
        before = package_state(box["pkg"])

        result = run(box)

        assert package_state(box["pkg"]) == before
        assert "VERIFIED" in result.stdout
        assert "restarted some units" in result.stdout

    def test_a_repair_that_edits_the_listener_is_undone(self, box):
        """The one that matters. A repair script that rewrites listener code -
        by accident or otherwise - must not survive the run."""
        write_repair(box, 'echo "BACKDOOR" > "$LOCKERROOM_PKG/control.py"\n')
        before = package_state(box["pkg"])

        result = run(box)

        assert package_state(box["pkg"]) == before, "the package was left modified"
        assert "BACKDOOR" not in (box["pkg"] / "control.py").read_text()
        assert "MODIFIED THE LISTENER PACKAGE" in result.stdout
        assert "RESTORED" in result.stdout
        assert result.returncode != 0, "tampering must not report success"

    def test_a_repair_that_deletes_listener_files_is_undone(self, box):
        write_repair(box, 'rm -rf "$LOCKERROOM_PKG/lockerroom"\n')
        before = package_state(box["pkg"])

        result = run(box)

        assert package_state(box["pkg"]) == before
        assert (box["pkg"] / "lockerroom" / "main.py").exists()
        assert result.returncode != 0

    def test_a_repair_that_adds_a_file_to_the_package_is_undone(self, box):
        """Adding is modifying. A dropped-in module is loaded on the next
        listener restart just as surely as an edited one."""
        write_repair(box, 'echo "x" > "$LOCKERROOM_PKG/lockerroom/evil.py"\n')
        before = package_state(box["pkg"])

        run(box)

        assert package_state(box["pkg"]) == before
        assert not (box["pkg"] / "lockerroom" / "evil.py").exists()


class TestDegradedPaths:
    def test_a_missing_repair_script_is_reported_not_crashed(self, box):
        result = run(box)
        assert "is missing" in result.stdout
        assert result.returncode != 0

    def test_a_failed_pull_still_runs_what_is_on_disk_and_says_so(self, box):
        """Deliberate: the job of this button is to fix a box that is already
        partly broken. Refusing to run the last-known repair because the
        network is also unwell makes it useless exactly when it is needed —
        but it must be loud about running stale code."""
        write_repair(box, 'echo "ran the on-disk script"\n')

        result = run(box)

        assert "ran the on-disk script" in result.stdout
        assert "WITHOUT A SUCCESSFUL PULL" in result.stdout

    def test_the_report_always_reaches_its_end(self, box):
        """A report that stops at the first problem is the failure this whole
        feature exists to stop repeating."""
        write_repair(box, 'exit 3\n')
        result = run(box)
        assert "END OF REPAIR RUN" in result.stdout


# --------------------------------------------------------------------------- #
# The repair must not restart the listener — including INDIRECTLY.
#
# lockerroom-listener.service declares `Requires=bluetooth.service`, and
# systemd propagates a restart across Requires=. So `systemctl restart
# bluetooth` in the repair script restarted the listener too, killing the
# control channel mid-command and losing the log of that very run. Measured
# 2026-09-21: the run-repair that diagnosed an rfkill soft block never reported
# at all, and the listener journal showed it stopped and started mid-command.
#
# This is the "never modify the listener" rule arriving by a different road:
# not replacing the listener, but restarting it out from under itself. These
# tests read the shipped scripts as text, because that is where the mistake
# lives and a unit test of Python would not have caught it.
# --------------------------------------------------------------------------- #

REPAIR_SH = Path(__file__).resolve().parents[1] / "scripts" / "remote-repair.sh"
REPORT_SH = Path(__file__).resolve().parents[1] / "scripts" / "report-full.sh"
LISTENER_UNIT = Path(__file__).resolve().parents[1] / "systemd" / "lockerroom-listener.service"


class TestRepairCannotKillTheControlChannel:
    def test_the_listener_requires_bluetooth_so_the_hazard_is_real(self):
        """If this ever stops being true the rule below can be relaxed — but
        check, do not assume."""
        assert "Requires=bluetooth.service" in LISTENER_UNIT.read_text()

    def test_bluetooth_is_not_in_the_blanket_restart_list(self):
        body = REPAIR_SH.read_text()
        units = body.split('UNITS="', 1)[1].split('"', 1)[0]
        names = units.replace("\\", " ").split()
        assert "bluetooth" not in names, (
            "restarting bluetooth.service propagates to lockerroom-listener "
            "via Requires= and takes down the control channel mid-repair"
        )
        assert "lockerroom-listener" not in names

    def test_any_bluetooth_restart_ignores_dependencies(self):
        """It may still be restarted as a last resort — but never in a way that
        drags the listener with it."""
        for line in REPAIR_SH.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "systemctl restart" in stripped and "bluetooth" in stripped:
                assert "--job-mode=ignore-dependencies" in stripped, (
                    f"unguarded bluetooth restart would restart the listener: {stripped}"
                )

    def test_the_repair_clears_a_soft_block(self):
        """An rfkill soft block reports hci0 DOWN and Powered: no through any
        number of service restarts. It is the one thing that has to be cleared
        before anything else is worth trying."""
        assert "rfkill unblock" in REPAIR_SH.read_text()

    def test_the_diagnostic_collects_rfkill(self):
        """The line that explained the 2026-09-21 fault was missing from the
        dump that was supposed to explain it."""
        assert "rfkill" in REPORT_SH.read_text()


class TestThePackageAsAReleaseSymlink:
    """After the first over-the-air update the package path is a symlink into
    releases/<id>/. The original guard ran `find` on the link, which finds
    nothing - an empty list verified against an empty list. These hold the
    guard to meaning something there too."""

    @pytest.fixture
    def linked(self, box, tmp_path):
        real = tmp_path / "releases" / "abc-0" / "lockerroom"
        real.parent.mkdir(parents=True)
        shutil.move(str(box["pkg"]), str(real))
        other = tmp_path / "releases" / "evil-0" / "lockerroom"
        other.mkdir(parents=True)
        (other / "control.py").write_text("SOMEBODY ELSE'S LISTENER\n")
        box["pkg"].symlink_to("releases/abc-0/lockerroom")
        box["real"], box["other"] = real, other
        return box

    def test_an_untouched_release_verifies(self, linked):
        write_repair(linked, 'echo "fine"\n')
        result = run(linked)
        assert "VERIFIED" in result.stdout
        assert "package is release: releases/abc-0/lockerroom" in result.stdout
        assert linked["pkg"].is_symlink()
        assert not list(linked["real"].parent.glob(".pkg-snapshot.*")), "snapshot left behind"

    def test_an_edit_inside_the_release_is_undone(self, linked):
        write_repair(linked, 'echo "BACKDOOR" > "$LOCKERROOM_PKG/control.py"\n')
        before = package_state(linked["real"])
        result = run(linked)
        assert package_state(linked["real"]) == before
        assert "MODIFIED THE LISTENER PACKAGE" in result.stdout and "RESTORED" in result.stdout
        assert linked["pkg"].is_symlink()

    def test_repointing_the_link_at_other_code_is_undone(self, linked):
        """The files were never touched - and the listener would still have
        started somebody else's code."""
        write_repair(linked, 'ln -sfn releases/evil-0/lockerroom "$LOCKERROOM_PKG"\n')
        result = run(linked)
        assert os.readlink(linked["pkg"]) == "releases/abc-0/lockerroom"
        assert "RESTORED" in result.stdout
        assert "ORIGINAL" in (linked["pkg"] / "control.py").read_text()

    def test_replacing_the_link_with_a_directory_is_undone(self, linked):
        write_repair(linked, 'rm "$LOCKERROOM_PKG"; mkdir "$LOCKERROOM_PKG"; '
                             'echo EVIL > "$LOCKERROOM_PKG/control.py"\n')
        result = run(linked)
        assert linked["pkg"].is_symlink()
        assert os.readlink(linked["pkg"]) == "releases/abc-0/lockerroom"
        assert "RESTORED" in result.stdout

    def test_deleting_the_link_is_undone(self, linked):
        write_repair(linked, 'rm "$LOCKERROOM_PKG"\n')
        result = run(linked)
        assert os.readlink(linked["pkg"]) == "releases/abc-0/lockerroom"
        assert "RESTORED" in result.stdout


class TestTheUpdateLock:
    def test_a_repair_does_not_run_while_an_update_is_switching_code(self, box, tmp_path):
        import fcntl
        write_repair(box, 'echo "THE REPAIR RAN"\n')
        lockdir = tmp_path / "run"
        lockdir.mkdir()
        fd = os.open(lockdir / "update.lock", os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            text = SCRIPT.read_text().replace("flock -s -w 20 9", "flock -s -w 1 9")
            fast = tmp_path / "run-repair-fast.sh"
            fast.write_text(text)
            result = subprocess.run(["bash", str(fast)], env=box["env"], capture_output=True,
                                    text=True, timeout=60)
        finally:
            os.close(fd)
        assert result.returncode == 1
        assert "THE REPAIR RAN" not in result.stdout
        assert "update is switching the listener" in result.stdout

    def test_nothing_the_repair_starts_can_keep_the_lock(self, box, tmp_path):
        """A stray background process holding it would block every later update."""
        import fcntl
        write_repair(box, 'sleep 30 >/dev/null 2>&1 &\n'
                          'echo $! > "$LOCKERROOM_REPO/bg.pid"\necho started\n')
        result = run(box)
        assert "started" in result.stdout
        fd = os.open(tmp_path / "run" / "update.lock", os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)   # raises if still held
        finally:
            os.close(fd)
            try:
                os.kill(int((box["repo"] / "bg.pid").read_text()), 9)
            except (OSError, ValueError):
                pass

    def test_the_snapshot_is_not_taken_in_tmp(self):
        """/tmp is a RAM disk on the box and can be full; a short snapshot is
        how a restore turns into deleting the listener."""
        text = SCRIPT.read_text()
        assert "mktemp -d /tmp" not in text
        assert 'mktemp -d "$(dirname "$REAL")/.pkg-snapshot' in text

    def test_an_incomplete_snapshot_reports_but_never_destroys(self, box, tmp_path):
        """If the snapshot could not be taken, a modified package is left as
        it is rather than replaced with nothing."""
        write_repair(box, 'echo "CHANGED" > "$LOCKERROOM_PKG/control.py"\n')
        stub = Path(box["env"]["PATH"].split(":")[0]) / "cp"
        stub.write_text("#!/bin/sh\nexit 1\n")
        stub.chmod(0o755)
        result = run(box)
        assert "could not take a complete snapshot" in result.stdout
        assert "RESTORE FAILED" in result.stdout
        assert (box["pkg"] / "control.py").exists(), "the package was destroyed"


class TestFixTheSpeakerFollowUp:
    """'Fix the speaker' restarts the listener when healthy and reboots when
    not, and either one is SCHEDULED: the listener is running the repair."""

    def _code(self):
        return [l.strip() for l in REPAIR_SH.read_text().splitlines()
                if l.strip() and not l.strip().startswith("#")]

    def test_the_listener_restart_and_the_reboot_are_both_scheduled(self):
        code = self._code()
        restart = [l for l in code if "restart lockerroom-listener" in l]
        reboot = [l for l in code if "systemctl reboot" in l]
        assert restart and reboot
        # Each sits on a continuation of a systemd-run --on-active call.
        body = REPAIR_SH.read_text()
        for needle in ("systemctl restart lockerroom-listener", "systemctl reboot"):
            before = body[: body.index(needle)]
            last_call = before[before.rindex('"$SYSTEMD_RUN"'):]
            assert "--on-active=" in last_call

    def test_nothing_restarts_the_listener_inline(self):
        for line in self._code():
            if "restart lockerroom-listener" in line or "restart-listener" in line:
                assert line.startswith("--on-active") or "SYSTEMD_RUN" in line or "echo" in line, line

    def test_the_follow_up_is_the_last_thing_the_repair_does(self):
        body = REPAIR_SH.read_text()
        assert body.index("===== health check and follow-up") > body.index("===== software update: request")
