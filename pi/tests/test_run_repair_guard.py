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
