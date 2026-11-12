"""Properties of the shipped shell scripts and unit files.

Mostly read as TEXT, like the Requires= tests in test_run_repair_guard.py: a
unit file cannot be exercised without systemd, and the things that keep this
box reachable are exactly the things nobody notices have changed.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

PI = Path(__file__).resolve().parents[1]
SCRIPTS = PI / "scripts"
UNITS = PI / "systemd"

TOOLS = r"(bluetoothctl|hciconfig|nmcli|git|\"?\$\{?BTCTL\}?\"?)"


def code_lines(path: Path) -> list[tuple[int, str]]:
    """Lines that run something: not comments, not text being printed."""
    out = []
    text = path.read_text()
    if path.name == "deploy.sh":
        # Only the half that runs ON THE BOX. The rest runs on a laptop, where
        # the calls are local and macOS has no `timeout` to wrap them in.
        text = text[text.index("<<'REMOTE'"):]
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.match(r"(echo|say|printf|die)\b", stripped):
            continue
        if "command -v" in stripped and "&&" not in stripped:
            continue
        out.append((n, stripped))
    return out


class TestEveryCallThatCanHangIsBounded:
    """A7. bluetoothctl waits for as long as bluetoothd does not answer, git
    and nmcli wait on the network. On a box nobody can reach, a script that
    hangs is a watchdog that never fires or a control channel held open."""

    @pytest.mark.parametrize("script", sorted(SCRIPTS.glob("*.sh")), ids=lambda p: p.name)
    def test_bluetooth_network_and_git_calls_have_a_timeout(self, script):
        unbounded = []
        for n, line in code_lines(script):
            # Text that is only being printed is not a call.
            line = re.sub(r"\becho\s+(\"[^\"]*\"|'[^']*')", "echo", line)
            # Each place one of the tools is the COMMAND, not an argument.
            for m in re.finditer(
                r"(?:^|[;&|(`]|\$\(|\bif\b|\bthen\b|!|&&|\|\|)\s*"
                r"((?:timeout\s+\S+\s+)?(?:sudo\s+(?:-u\s+\S+\s+)?)?)" + TOOLS + r"(?=\s|$)",
                line,
            ):
                prefix = m.group(1)
                before = line[:m.start()]
                if "timeout" in prefix or re.search(r"\b(run|timeout)\s+\S+\s*$", before + prefix):
                    continue
                if "apt-get install" in line or line.startswith(("BTCTL=", "bluez ", "git curl")):
                    continue
                unbounded.append(f"{script.name}:{n}: {line}")
        assert unbounded == [], "\n".join(unbounded)

    def test_the_check_itself_can_fail(self, tmp_path):
        bad = tmp_path / "bad.sh"
        bad.write_text("#!/bin/sh\nbluetoothctl power on\nif ! hciconfig hci0; then :; fi\n")
        assert len([1 for _, line in code_lines(bad)
                    if re.search(r"^\s*(if ! )?" + TOOLS, line)]) == 2

    def test_btwatch_does_not_hang_when_bluetooth_tools_never_return(self, tmp_path):
        """The watchdog must outlive the thing it is watching."""
        binv = tmp_path / "bin"
        binv.mkdir()
        for name in ("hciconfig", "bluetoothctl", "rfkill"):
            (binv / name).write_text("#!/bin/sh\nexec sleep 300\n")
            (binv / name).chmod(0o755)
        # A fast `timeout` that still kills: the real durations are 10-15s.
        (binv / "timeout").write_text(
            '#!/bin/sh\nshift\n"$@" &\npid=$!\n( sleep 0.2; kill $pid 2>/dev/null ) &\n'
            'wait $pid 2>/dev/null\nexit 124\n')
        (binv / "timeout").chmod(0o755)
        env = dict(os.environ, PATH=f"{binv}:{os.environ['PATH']}", BTWATCH_ONESHOT="1",
                   RECOVER_CMD="true")
        result = subprocess.run(["bash", str(SCRIPTS / "btwatch.sh")], env=env,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0
        assert "rebinding" in result.stdout


class TestStartLimits:
    @pytest.mark.parametrize("unit", ["bt-agent.service", "keep-discoverable.service",
                                      "lockerroom-btwatch.service",
                                      "lockerroom-netwatch.service"])
    def test_no_start_rate_limit_and_it_is_in_the_unit_section(self, unit):
        text = (UNITS / unit).read_text()
        unit_section, service_section = re.split(r"^\[Service\]$", text, flags=re.M)
        assert re.search(r"^StartLimitIntervalSec=0$", unit_section, re.M), unit
        assert not re.search(r"^StartLimitIntervalSec", service_section, re.M)

    def test_the_listener_drop_in_holds_exactly_two_settings(self):
        """It rides outside any trial, so it may only ever carry settings that
        cannot stop the listener starting."""
        text = (UNITS / "lockerroom-listener-auxgoat.conf").read_text()
        settings = [line for line in text.splitlines()
                    if line and not line.startswith(("#", "["))]
        assert settings == ["StartLimitIntervalSec=0", "OOMScoreAdjust=-500"]

    def test_the_listener_unit_itself_was_not_edited_for_this(self):
        text = (UNITS / "lockerroom-listener.service").read_text()
        assert "StartLimitIntervalSec" not in text and "OOMScoreAdjust" not in text
        assert "Type=notify" not in text and "WatchdogSec" not in text


class TestTheClockLivesInTheListener:
    def test_there_is_no_boot_clock_script_any_more(self):
        """The boot-time script (a plain-HTTP, forward-only step) was never
        installed: one forged Date header could pin the clock in the future
        for good. The clock is kept by lockerroom/clock.py instead, from the
        verified beacon, and tested in test_clock.py. Nothing here may bring
        the script back by naming it."""
        assert not (SCRIPTS / "auxgoat-clock.sh").exists()
        assert not (UNITS / "auxgoat-clock.service").exists()
        pi = SCRIPTS.parent
        for d_ in (SCRIPTS, UNITS, pi / "lockerroom"):
            for f in d_.glob("*"):
                if f.is_file():
                    assert "auxgoat-clock" not in f.read_text(errors="replace"), f.name
        assert (pi / "lockerroom" / "clock.py").exists()


class TestTheNightlyRestart:
    def test_the_timer_does_not_catch_up_after_being_off(self):
        text = (UNITS / "auxgoat-nightly-restart.timer").read_text()
        assert re.search(r"^Persistent=false$", text, re.M)
        assert re.search(r"^OnCalendar=\*-\*-\* 04:30:00$", text, re.M)

    def run(self, tmp_path, state="idle", running=False, open_play=False):
        binv = tmp_path / "bin"
        binv.mkdir(exist_ok=True)
        log = tmp_path / "systemctl.log"
        (binv / "systemctl").write_text(f'#!/bin/sh\necho "$*" >> "{log}"\n')
        updater = tmp_path / "auxgoat-update"
        updater.write_text(f"#!/bin/sh\necho {state}\n")
        for f in (binv / "systemctl", updater):
            f.chmod(0o755)
        sub = tmp_path / "asound" / "card0" / "pcm0p" / "sub0"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "status").write_text("state: RUNNING\n" if running else "closed\n")
        health = tmp_path / "health.json"
        health.write_text('{"open_play": %s, "pid": 1}' % ("true" if open_play else "false"))
        env = dict(os.environ, PATH=f"{binv}:{os.environ['PATH']}",
                   ASOUND_ROOT=str(tmp_path / "asound"), AUXGOAT_UPDATER=str(updater),
                   AUXGOAT_HEALTH=str(health))
        result = subprocess.run(["bash", str(SCRIPTS / "auxgoat-nightly-restart.sh")],
                                env=env, capture_output=True, text=True, timeout=30)
        return result, (log.read_text() if log.exists() else "")

    def test_it_restarts_an_idle_listener(self, tmp_path):
        result, log = self.run(tmp_path)
        assert result.returncode == 0
        assert log.strip() == "try-restart lockerroom-listener"

    def test_it_is_skipped_while_an_update_is_on_trial(self, tmp_path):
        result, log = self.run(tmp_path, state="trial")
        assert "skipped" in result.stdout and log == ""

    def test_it_is_skipped_while_audio_is_playing(self, tmp_path):
        result, log = self.run(tmp_path, running=True)
        assert "skipped" in result.stdout and log == ""

    def test_it_is_skipped_while_a_song_is_open_on_the_relay(self, tmp_path):
        result, log = self.run(tmp_path, open_play=True)
        assert "skipped" in result.stdout and log == ""


class TestWhatGetsShipped:
    def test_the_legacy_test_domain_is_gone_from_the_speaker_code(self):
        offenders = []
        needle = "finestkind" + "farms"
        for path in PI.rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                try:
                    if needle in path.read_text():
                        offenders.append(str(path.relative_to(PI)))
                except UnicodeDecodeError:
                    pass
        assert offenders == []

    def test_a_new_box_is_provisioned_onto_the_current_host(self):
        text = (SCRIPTS / "provision.sh").read_text()
        assert 'api_base_url = "https://auxgoat-hc.mmvinton17.workers.dev"' in text
        assert "pip install -r" in text and '"dbus-fast>=' not in text

    def test_serial_deploy_ships_every_listener_module(self):
        """It shipped three named files, and broke the first time a fourth
        module was imported by one of them."""
        result = subprocess.run(
            ["python3", str(SCRIPTS / "serial-deploy.py"), "--dry-run"],
            capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        for module in (PI / "lockerroom").glob("*.py"):
            assert f"/opt/lockerroom/lockerroom/{module.name}" in result.stdout, module.name
        assert "/usr/local/bin/auxgoat-update" in result.stdout

    def test_the_cable_deploy_installs_the_updater_and_tells_it(self):
        text = (SCRIPTS / "deploy.sh").read_text()
        assert "/usr/local/bin/auxgoat-update adopt --commit" in text
        assert "auxgoat-update-recover.service" in text
        # Still correct whether the package path is a directory or a release link.
        assert "sudo rm -rf /opt/lockerroom/lockerroom\n" in text

    def test_the_full_report_shows_software_clock_and_connections(self):
        text = (SCRIPTS / "report-full.sh").read_text()
        for needle in ("auxgoat-update status", "timedatectl", "hcitool con",
                       "bluetoothctl devices Connected", "bluealsa-cli list-pcms",
                       "is streaming", "speaker routed to"):
            assert needle in text, needle

    def test_a_repair_leaves_running_watchdogs_alone(self):
        text = (SCRIPTS / "remote-repair.sh").read_text()
        units = re.search(r'^UNITS="([^"]*)"', text, re.M).group(1)
        assert "lockerroom-btwatch" not in units and "lockerroom-netwatch" not in units
        assert 'WATCHDOGS="lockerroom-btwatch lockerroom-netwatch"' in text

    def test_a_repair_asserts_the_wired_profile_without_bouncing_it(self):
        text = (SCRIPTS / "remote-repair.sh").read_text()
        assert "ipv4.ignore-auto-dns yes" in text and "ipv4.never-default yes" in text
        assert "nmcli connection up" not in text

    def test_the_bootstrap_is_armed(self):
        text = (SCRIPTS / "remote-repair.sh").read_text()
        assert re.search(r'^OTA_VIA_REPAIR="bootstrap"$', text, re.M)
