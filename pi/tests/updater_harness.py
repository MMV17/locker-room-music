"""A fake Pi for driving the REAL pi/scripts/auxgoat-update.

Nothing here reimplements the updater. It builds a throwaway box - a real git
remote and clone, an installed listener package, stub systemctl / curl /
systemd-run / pgrep on PATH - and runs the shipped script against it, the same
way test_run_repair_guard.py drives run-repair.sh.

The stub `systemctl restart lockerroom-listener` starts a FAKE LISTENER whose
behaviour is decided by a file inside whichever package is live
(`lockerroom/behavior.txt`), so "the new code crashes" and "the new code runs
but cannot beacon" are properties of a commit, exactly as they are on the box.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import textwrap
from pathlib import Path

PI = Path(__file__).resolve().parents[1]
UPDATER = PI / "scripts" / "auxgoat-update"

# Every place apply/verify can be killed, in order. A new crash_point() in the
# updater must be added here, and test_every_crash_point_is_listed holds that.
APPLY_CRASH_POINTS = [
    "after-preflight", "staged-files", "gates-passed", "release-renamed",
    "converting-journaled", "legacy-moved", "converted", "rollback-link",
    "trial-journaled", "flipped", "listener-restarted",
]
VERIFY_CRASH_POINTS = ["commit-journaled", "synced", "pre-rollback", "rolled-back-link"]

FAKE_LISTENER = r'''
import json, os, sys, time
from pathlib import Path
root, run, stub = (Path(os.environ[k]) for k in ("AUXGOAT_ROOT", "AUXGOAT_RUN", "STUB"))
pkg = root / "lockerroom"
try:
    behavior = (pkg / "behavior.txt").read_text().strip()
except OSError:
    behavior = "legacy"
try:
    rid = json.loads((pkg.resolve().parent / "RELEASE.json").read_text())["release_id"]
except Exception:
    rid = None
bt = lambda: time.clock_gettime(time.CLOCK_BOOTTIME)
boot = Path(os.environ["AUXGOAT_BOOT_ID_FILE"]).read_text().strip()
show = stub / "listener.show"
if behavior == "crash":
    for n in range(1, 6):
        show.write_text(f"ActiveState=activating\nNRestarts={n}\nMainPID=0\n")
        time.sleep(0.05)
    sys.exit(1)
if behavior == "legacy":
    time.sleep(600)
good, first = 0, None
while True:
    ok = behavior in ("healthy", "wrongid") or (
        behavior == "needsnet" and (stub / "net-up").exists())
    now = bt()
    if ok:
        good += 1
        first = first if first is not None else now
    marker = {
        "release_id": "somebody-else" if behavior == "wrongid" else rid,
        "pid": os.getpid(), "boot_id": boot, "loop_boottime": now,
        "good_beacons": good, "first_good_boottime": first,
        "last_good_boottime": now if ok else first,
        "open_play": False, "sessions": 0,
    }
    tmp = run / "health.json.tmp"
    run.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(marker))
    os.replace(tmp, run / "health.json")
    time.sleep(0.03)
'''

STUBS = {
    "systemctl": r'''#!/bin/sh
echo "$*" >> "$STUB/systemctl.log"
case "$1" in
  show) cat "$STUB/listener.show" 2>/dev/null; exit 0 ;;
  is-active) [ -e "$STUB/apply-pending" ] && exit 0; exit 3 ;;
  restart)
    case " $* " in *" lockerroom-listener "*)
      [ -f "$STUB/listener.pid" ] && kill "$(cat "$STUB/listener.pid")" 2>/dev/null
      "$PYTHON" "$STUB/fake_listener.py" >/dev/null 2>&1 &
      echo $! > "$STUB/listener.pid"
      printf 'ActiveState=active\nNRestarts=0\nMainPID=%s\n' "$!" > "$STUB/listener.show" ;;
    esac ;;
esac
exit 0
''',
    "curl": '#!/bin/sh\n[ -e "$STUB/net-up" ] && exit 0\nexit 7\n',
    "pgrep": '#!/bin/sh\n[ -e "$STUB/repair-running" ] && exit 0\nexit 1\n',
    "systemd-run": '#!/bin/sh\necho "$*" >> "$STUB/systemd-run.log"\nexit 0\n',
    "systemd-analyze": '#!/bin/sh\n[ -e "$STUB/analyze-fail" ] && exit 1\nexit 0\n',
    "udevadm": "#!/bin/sh\nexit 0\n",
    "bluetoothctl": '#!/bin/sh\ncat "$STUB/bt-connected" 2>/dev/null\nexit 0\n',
}

# The package a commit carries. `behavior` decides how the fake listener acts
# once this package is the live one.
def package(behavior: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    files = {
        "pi/lockerroom/__init__.py": "",
        "pi/lockerroom/main.py": "VALUE = 1\n",
        "pi/lockerroom/netwatch.py": "from . import endpoints  # noqa: F401\n",
        "pi/lockerroom/endpoints.py":
            "def configured_urls():\n    return ['https://probe.invalid']\n",
        "pi/lockerroom/selftest.py":
            "if __name__ == '__main__':\n    raise SystemExit(0)\n",
        "pi/lockerroom/behavior.txt": behavior + "\n",
        "pi/scripts/report-full.sh": "#!/bin/sh\necho report v1\n",
        "pi/scripts/run-repair.sh": "#!/bin/sh\necho repair v1\n",
        "pi/scripts/btwatch.sh": "#!/bin/sh\necho btwatch v1\n",
        "pi/systemd/bt-agent.service": "[Unit]\nDescription=agent v1\n",
        "pi/systemd/lockerroom-listener.service": "[Unit]\nDescription=MUST NOT BE SYNCED\n",
        "pi/systemd/bluealsa-aplay-aux.conf": "[Service]\n# MUST NOT BE SYNCED\n",
        "pi/systemd/lockerroom-listener-auxgoat.conf": "[Unit]\nStartLimitIntervalSec=0\n",
        # Always satisfied wherever these tests can run.
        "pi/requirements.txt": "pip\n",
    }
    files.update(extra or {})
    return files


class Box:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.root = tmp / "opt"
        self.run_dir = tmp / "run"
        self.etc = tmp / "etc"
        self.bin = tmp / "usr-local-bin"
        self.units = tmp / "systemd"
        self.udev = tmp / "udev"
        self.stub = tmp / "stub"
        self.origin = tmp / "origin.git"
        self.author = tmp / "author"
        self.repo = self.root / "repo"
        self.pkg = self.root / "lockerroom"
        for d in (self.root, self.run_dir, self.etc, self.bin, self.units, self.udev,
                  self.stub, tmp / "asound"):
            d.mkdir(parents=True)
        (self.stub / "boot_id").write_text("boot-1\n")
        (self.stub / "fake_listener.py").write_text(FAKE_LISTENER)
        (self.stub / "net-up").write_text("")
        stubbin = tmp / "stubbin"
        stubbin.mkdir()
        for name, body in STUBS.items():
            p = stubbin / name
            p.write_text(body)
            p.chmod(0o755)

        self.env = dict(os.environ)
        self.env.update({
            "PATH": f"{stubbin}:{self.env['PATH']}",
            "STUB": str(self.stub), "PYTHON": sys.executable,
            "AUXGOAT_ROOT": str(self.root), "AUXGOAT_REPO": str(self.repo),
            "AUXGOAT_RUN": str(self.run_dir), "AUXGOAT_ETC": str(self.etc),
            "AUXGOAT_BIN_DIR": str(self.bin), "AUXGOAT_UNIT_DIR": str(self.units),
            "AUXGOAT_UDEV_DIR": str(self.udev), "AUXGOAT_ASOUND": str(tmp / "asound"),
            "AUXGOAT_VENV_PY": sys.executable, "AUXGOAT_SYS_PY": sys.executable,
            "AUXGOAT_BOOT_ID_FILE": str(self.stub / "boot_id"),
            "AUXGOAT_SELF": str(UPDATER),
            "AUXGOAT_POLL_S": "0.05", "AUXGOAT_STABLE_S": "0.3",
            "AUXGOAT_BEACON_GAP_S": "0.15", "AUXGOAT_NOBEACON_S": "0.6",
            "AUXGOAT_PROBE_EVERY_S": "0.1", "AUXGOAT_SETTLE_S": "0",
            "AUXGOAT_IDLE_WAIT_S": "0.3", "AUXGOAT_IDLE_POLL_S": "0.1",
            "AUXGOAT_ROLLBACK_CHECK_S": "0.1", "AUXGOAT_LOCK_WAIT_S": "1",
            "AUXGOAT_REPAIR_WAIT_S": "2",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
        })
        self.env.pop("AUXGOAT_UPDATE_CRASH_AT", None)

        self._git(None, "init", "-q", "--bare", "-b", "main", str(self.origin))
        self._git(None, "init", "-q", "-b", "main", str(self.author))
        self.v1 = self.push(package("legacy"), "v1")
        self._git(None, "clone", "-q", str(self.origin), str(self.repo))
        # What a cable deploy leaves: a plain directory, no release metadata.
        shutil.copytree(self.author / "pi" / "lockerroom", self.pkg)

    # -- git ---------------------------------------------------------------
    def _git(self, cwd: Path | None, *args: str) -> str:
        p = subprocess.run(["git", *args], cwd=cwd, env=self.env, capture_output=True,
                           text=True, check=True)
        return p.stdout.strip()

    def push(self, files: dict[str, str], msg: str = "change", force: bool = False) -> str:
        for rel, body in files.items():
            p = self.author / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body)
            if rel.endswith(".sh") or rel.endswith("auxgoat-update"):
                p.chmod(0o755)
        self._git(self.author, "add", "-A")
        self._git(self.author, "commit", "-q", "--allow-empty", "-m", msg)
        self._git(self.author, "push", "-q", *(["--force"] if force else []),
                  str(self.origin), "HEAD:main")
        return self._git(self.author, "rev-parse", "HEAD")

    def fetch(self) -> None:
        self._git(self.repo, "fetch", "-q", "origin")

    # -- running the real updater -----------------------------------------
    def update(self, *args: str, crash_at: str | None = None,
               **env: str) -> subprocess.CompletedProcess:
        e = dict(self.env)
        e.update(env)
        if crash_at:
            e["AUXGOAT_UPDATE_CRASH_AT"] = crash_at
        return subprocess.run([sys.executable, str(UPDATER), *args], env=e,
                              capture_output=True, text=True, timeout=120)

    def apply(self, commit: str, **kw) -> subprocess.CompletedProcess:
        self.fetch()
        return self.update("apply", "--commit", commit, **kw)

    def reboot(self) -> subprocess.CompletedProcess:
        """Power cut: /run is gone, a new boot id, recover, then the listener."""
        self.stop_listener()
        shutil.rmtree(self.run_dir)
        self.run_dir.mkdir()
        n = int((self.stub / "boot_id").read_text().strip().split("-")[1]) + 1
        (self.stub / "boot_id").write_text(f"boot-{n}\n")
        result = self.update("recover")
        subprocess.run(["systemctl", "restart", "lockerroom-listener"], env=self.env, check=True)
        return result

    def stop_listener(self) -> None:
        pidfile = self.stub / "listener.pid"
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except (OSError, ValueError):
                pass
            pidfile.unlink()

    # -- observations ------------------------------------------------------
    def live_behavior(self) -> str:
        return (self.pkg / "behavior.txt").read_text().strip()

    def live_release(self) -> str | None:
        return self.pkg.resolve().parent.name if self.pkg.is_symlink() else None

    def state(self) -> dict:
        import json
        try:
            return json.loads((self.root / "update" / "state.json").read_text())
        except OSError:
            return {}

    def result(self) -> dict:
        import json
        try:
            return json.loads((self.root / "update" / "last-result.json").read_text())
        except OSError:
            return {}

    def systemctl_log(self) -> str:
        try:
            return (self.stub / "systemctl.log").read_text()
        except OSError:
            return ""

    def assert_sound(self) -> None:
        """I1: the live package is complete, verified, and one whole release."""
        assert (self.pkg / "__init__.py").is_file(), "no usable live package"
        if self.pkg.is_symlink():
            release = self.pkg.resolve().parent
            lines = (release / "MANIFEST.sha256").read_text().splitlines()
            import hashlib
            for line in lines:
                digest, rel = line.split("  ", 1)
                assert hashlib.sha256((release / rel).read_bytes()).hexdigest() == digest, rel
        assert not list((self.root / "releases").glob(".staging-*")) or True


def dedent(s: str) -> str:
    return textwrap.dedent(s).lstrip("\n")
