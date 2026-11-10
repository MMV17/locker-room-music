"""The over-the-air updater must never strand the box.

The listener is the control channel and nobody can reach this speaker with a
cable on short notice, so every claim the updater makes about itself is tested
as behaviour: the REAL pi/scripts/auxgoat-update is driven against a throwaway
box with a real git remote (see updater_harness.py). The invariants are
numbered as in the design review, so a failure names the promise it broke.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading

import pytest

from updater_harness import (
    APPLY_CRASH_POINTS, PI, UPDATER, VERIFY_CRASH_POINTS, Box, package,
)


@pytest.fixture
def box(tmp_path):
    b = Box(tmp_path)
    yield b
    b.stop_listener()


def healthy_update(box: Box) -> str:
    sha = box.push(package("healthy"), "v2")
    assert box.apply(sha).returncode == 0
    assert box.update("verify").returncode == 0
    assert box.result()["outcome"] == "committed"
    return sha


class TestTheHappyPath:
    def test_a_healthy_release_is_installed_and_committed(self, box):
        sha = box.push(package("healthy", {
            "pi/scripts/report-full.sh": "#!/bin/sh\necho report v2\n",
        }), "v2")

        applied = box.apply(sha)
        assert applied.returncode == 0, applied.stdout + applied.stderr
        # On trial: live, restarted, but not yet believed.
        assert box.state()["state"] == "trial"
        assert box.live_behavior() == "healthy"
        assert "restart lockerroom-listener" in box.systemctl_log()

        verified = box.update("verify")
        assert verified.returncode == 0, verified.stdout + verified.stderr
        assert box.state()["state"] == "idle"
        result = box.result()
        assert result["outcome"] == "committed" and result["ok"] is True
        assert result["to_commit"] == sha
        assert "not checked (no allowed_signers" in result["signature"]
        box.assert_sound()

        status = box.update("status").stdout
        assert sha in status and "committed" in status
        assert box.update("status", "--field", "commit").stdout.strip() == sha

    def test_the_first_update_converts_the_plain_directory_into_a_release(self, box):
        assert not box.pkg.is_symlink()
        healthy_update(box)
        assert box.pkg.is_symlink()
        # The code that was running before is kept, verified, as the way back.
        rollback = (box.root / "lockerroom.rollback").resolve()
        assert (rollback / "behavior.txt").read_text().strip() == "legacy"
        assert rollback.parent.name.startswith("legacy-")

    def test_the_same_content_twice_is_a_no_op(self, box):
        """I10: nothing to install means nothing is restarted."""
        sha = healthy_update(box)
        log_before = box.systemctl_log()
        again = box.apply(sha)
        assert again.returncode == 0 and "already up to date" in again.stdout
        assert box.systemctl_log() == log_before

    def test_a_second_update_builds_on_the_first(self, box):
        healthy_update(box)
        first = box.live_release()
        sha = box.push(package("healthy", {"pi/lockerroom/main.py": "VALUE = 3\n"}), "v3")
        assert box.apply(sha).returncode == 0
        assert box.update("verify").returncode == 0
        assert box.live_release() != first
        assert (box.root / "lockerroom.rollback").resolve().parent.name == first
        box.assert_sound()


class TestStagingGates:
    """I3: code that cannot start is refused before it is anywhere near live."""

    @pytest.mark.parametrize("label,extra,needle", [
        ("syntax error", {"pi/lockerroom/main.py": "def broken(:\n"}, "imports under"),
        ("selftest fails", {"pi/lockerroom/selftest.py":
                            "if __name__ == '__main__':\n    raise SystemExit(1)\n"}, "selftest"),
        ("unmet requirement", {"pi/requirements.txt": "pip\nthis-package-is-not-installed>=9\n"},
         "requirements"),
        ("script syntax error", {"pi/scripts/report-full.sh": "#!/bin/sh\nif then fi (\n"},
         "bash -n report-full.sh"),
    ])
    def test_a_release_that_fails_a_gate_never_goes_live(self, box, label, extra, needle):
        sha = box.push(package("healthy", extra), label)
        result = box.apply(sha)

        assert result.returncode == 1
        assert box.result()["outcome"] == "refused"
        assert needle in box.result()["reason"]
        assert box.live_behavior() == "legacy"
        assert not box.pkg.is_symlink(), "the live package was touched"
        assert "restart lockerroom-listener" not in box.systemctl_log()
        assert not list((box.root / "releases").glob(".staging-*"))


    def test_netwatch_is_checked_under_the_system_python_it_runs_on(self, box):
        """The watchdog runs on /usr/bin/python3, not the venv. A release that
        only imports under the venv would silently kill it."""
        sha = box.push(package("healthy"), "v2")
        result = box.apply(sha, AUXGOAT_SYS_PY="/bin/false")
        assert result.returncode == 1
        assert "netwatch imports under the system python" in box.result()["reason"]
        assert not box.pkg.is_symlink()


class TestTrialDecisions:
    def test_a_listener_that_crashes_on_start_is_rolled_back(self, box):
        """I5."""
        sha = box.push(package("crash"), "crashes")
        assert box.apply(sha).returncode == 0
        verified = box.update("verify")

        assert verified.returncode == 1
        assert box.live_behavior() == "legacy"
        result = box.result()
        assert result["outcome"] == "rolled-back" and "crashed" in result["reason"]
        assert "previous version is running again" in result["reason"]
        assert box.state()["state"] == "idle"
        box.assert_sound()

    def test_a_listener_that_never_beacons_with_the_network_up_is_rolled_back(self, box):
        """I6, first half: we can reach the Worker and the listener cannot."""
        sha = box.push(package("silent"), "silent")
        assert box.apply(sha).returncode == 0
        assert box.update("verify").returncode == 1
        assert box.live_behavior() == "legacy"
        assert "never reported in" in box.result()["reason"]

    def test_a_network_outage_neither_rolls_back_nor_commits(self, box):
        """I6, second half: do not punish good code for the campus wifi."""
        (box.stub / "net-up").unlink()
        sha = box.push(package("needsnet"), "needs the network")
        assert box.apply(sha).returncode == 0

        waiting = box.update("verify", AUXGOAT_VERIFY_MAX_LOOPS="30")
        assert waiting.returncode == 3, "verify decided something during an outage"
        assert box.state()["state"] == "trial"
        assert box.live_behavior() == "needsnet"

        # The network returns, the listener beacons, and only THEN it commits.
        (box.stub / "net-up").write_text("")
        assert box.update("verify").returncode == 0
        assert box.result()["outcome"] == "committed"

    def test_when_the_network_returns_and_it_still_cannot_beacon_it_rolls_back(self, box):
        (box.stub / "net-up").unlink()
        sha = box.push(package("silent"), "silent")
        assert box.apply(sha).returncode == 0
        assert box.update("verify", AUXGOAT_VERIFY_MAX_LOOPS="20").returncode == 3
        (box.stub / "net-up").write_text("")
        assert box.update("verify").returncode == 1
        assert box.live_behavior() == "legacy"

    def test_a_marker_for_another_release_proves_nothing(self, box):
        """I4: the marker must name THIS release."""
        sha = box.push(package("wrongid"), "wrong id")
        assert box.apply(sha).returncode == 0
        assert box.update("verify").returncode == 1
        assert box.result()["outcome"] == "rolled-back"

    def test_a_stale_marker_from_another_process_proves_nothing(self, box):
        """I4: right release, wrong PID and wrong boot."""
        sha = box.push(package("silent"), "silent")
        assert box.apply(sha).returncode == 0
        rid = box.live_release()
        box.stop_listener()
        (box.run_dir / "health.json").write_text(
            '{"release_id": "%s", "pid": 1, "boot_id": "boot-0", "loop_boottime": 9e9,'
            ' "good_beacons": 50, "first_good_boottime": 9e9, "last_good_boottime": 9.1e9}' % rid
        )
        assert box.update("verify").returncode == 1
        assert box.live_behavior() == "legacy"

    def test_the_trial_time_limit_rolls_back(self, box):
        """I7: never stuck on unconfirmed code for ever."""
        (box.stub / "net-up").unlink()
        sha = box.push(package("needsnet"), "needs the network")
        assert box.apply(sha).returncode == 0
        assert box.update("verify", AUXGOAT_TRIAL_MAX_S="0.3").returncode == 1
        assert "trial limit" in box.result()["reason"]
        assert box.live_behavior() == "legacy"

    def test_a_trial_survives_one_reboot_and_then_commits(self, box):
        sha = box.push(package("healthy"), "v2")
        assert box.apply(sha).returncode == 0
        box.reboot()
        assert box.state()["state"] == "trial" and box.state()["trial_boots"] == 1
        assert box.live_behavior() == "healthy"
        assert box.update("verify").returncode == 0
        assert box.result()["outcome"] == "committed"

    def test_three_reboots_on_trial_roll_back(self, box):
        """I7: reboots during a trial are themselves evidence."""
        (box.stub / "net-up").unlink()
        sha = box.push(package("needsnet"), "v2")
        assert box.apply(sha).returncode == 0
        for _ in range(3):
            box.reboot()
        assert box.state()["state"] == "idle"
        assert box.live_behavior() == "legacy"
        assert "rebooted 3 times" in box.result()["reason"]

    def test_a_failed_commit_is_not_tried_again(self, box):
        sha = box.push(package("crash"), "crashes")
        box.apply(sha)
        box.update("verify")
        again = box.apply(sha)
        assert again.returncode == 1
        assert "already tried and rolled back" in box.result()["reason"]

    def test_the_guard_restoring_the_old_code_is_reported_not_committed(self, box):
        """I11, second half: the live link moved under the trial."""
        healthy_update(box)
        old = box.live_release()
        sha = box.push(package("healthy", {"pi/lockerroom/main.py": "VALUE = 9\n"}), "v3")
        assert box.apply(sha).returncode == 0
        link = box.pkg
        link.unlink()
        link.symlink_to(f"releases/{old}/lockerroom")

        assert box.update("verify").returncode == 1
        result = box.result()
        assert result["outcome"] == "rolled-back"
        assert "no longer points at the release on trial" in result["reason"]
        assert box.state()["state"] == "idle"


class TestRefusals:
    """I10: each of these leaves the box exactly as it was."""

    def test_no_clone(self, box):
        sha = box.push(package("healthy"), "v2")
        box.fetch()
        shutil.rmtree(box.repo)
        result = box.update("apply", "--commit", sha)
        assert result.returncode == 1 and "no git clone" in box.result()["reason"]
        assert box.live_behavior() == "legacy"

    def test_a_commit_that_is_not_in_the_clone(self, box):
        result = box.apply("0" * 40)
        assert result.returncode == 1 and "not in the clone" in box.result()["reason"]

    def test_low_disk(self, box):
        sha = box.push(package("healthy"), "v2")
        result = box.apply(sha, AUXGOAT_MIN_FREE_MB="999999999")
        assert result.returncode == 1 and "MB free" in box.result()["reason"]
        assert not box.pkg.is_symlink()

    def test_music_playing_defers_instead_of_interrupting(self, box):
        """I8/I10."""
        status = box.tmp / "asound" / "card0" / "pcm0p" / "sub0"
        status.mkdir(parents=True)
        (status / "status").write_text("state: RUNNING\n")
        sha = box.push(package("healthy"), "v2")
        result = box.apply(sha)
        assert result.returncode == 1
        assert box.result()["outcome"] == "deferred"
        assert "restart lockerroom-listener" not in box.systemctl_log()
        assert box.live_behavior() == "legacy"

    def test_an_open_play_reported_by_the_listener_defers(self, box):
        healthy_update(box)
        marker = box.run_dir / "health.json"
        box.stop_listener()
        import json
        import os
        import time
        h = json.loads(marker.read_text())
        h.update(open_play=True, pid=os.getpid(),
                 loop_boottime=time.clock_gettime(time.CLOCK_BOOTTIME))
        marker.write_text(json.dumps(h))
        sha = box.push(package("healthy", {"pi/lockerroom/main.py": "VALUE = 4\n"}), "v3")
        assert box.apply(sha).returncode == 1
        assert "a song is playing" in box.result()["reason"]

    def test_a_trial_in_progress_refuses_another_update(self, box):
        """I9."""
        (box.stub / "net-up").unlink()
        first = box.push(package("needsnet"), "v2")
        assert box.apply(first).returncode == 0
        second = box.push(package("healthy"), "v3")
        result = box.apply(second)
        assert result.returncode == 1 and "already in progress" in result.stdout
        assert box.live_behavior() == "needsnet"

    def test_two_applies_at_once_only_one_switches(self, box):
        """I9: the lock, not luck."""
        sha = box.push(package("healthy"), "v2")
        box.fetch()
        results = []

        def go():
            results.append(box.update("apply", "--commit", sha))

        threads = [threading.Thread(target=go) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        codes = sorted(r.returncode for r in results)
        assert codes == [0, 1], [r.stdout[-300:] for r in results]
        assert any("already in progress" in r.stdout for r in results)
        assert box.systemctl_log().count("restart lockerroom-listener") == 1
        box.assert_sound()


class TestAntiRollbackAndSignatures:
    def test_an_older_commit_is_refused(self, box):
        healthy_update(box)
        result = box.apply(box.v1)
        assert result.returncode == 1
        assert "not a descendant" in box.result()["reason"]
        assert box.live_behavior() == "healthy"

    def test_a_force_pushed_branch_is_refused(self, box):
        """Somebody rewrote history. The box does not follow."""
        healthy_update(box)
        box._git(box.author, "reset", "-q", "--hard", box.v1)
        evil = box.push(package("healthy", {"pi/lockerroom/main.py": "VALUE = 666\n"}),
                        "rewritten", force=True)
        result = box.apply(evil)
        assert result.returncode == 1
        assert "not a descendant" in box.result()["reason"]
        assert "666" not in (box.pkg / "main.py").read_text()

    def test_an_installed_commit_missing_from_the_clone_is_refused(self, box):
        import json
        (box.root / "RELEASE.json").write_text(json.dumps({"commit": "a" * 40}))
        sha = box.push(package("healthy"), "v2")
        assert box.apply(sha).returncode == 1
        assert "history cannot be checked" in box.result()["reason"]

    def test_an_unsigned_commit_is_refused_when_signers_are_configured(self, box):
        (box.etc / "allowed_signers").write_text("nobody@example.invalid ssh-ed25519 AAAA\n")
        sha = box.push(package("healthy"), "unsigned")
        result = box.apply(sha)
        assert result.returncode == 1
        assert "failed signature verification" in box.result()["reason"]
        assert box.live_behavior() == "legacy"

    @pytest.mark.skipif(shutil.which("ssh-keygen") is None, reason="needs ssh-keygen")
    def test_a_signed_commit_is_accepted_when_signers_are_configured(self, box):
        key = box.tmp / "signing_key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
                       check=True)
        pub = (box.tmp / "signing_key.pub").read_text().strip()
        (box.etc / "allowed_signers").write_text(f"t@example.invalid {pub}\n")
        for k, v in (("gpg.format", "ssh"), ("user.signingkey", str(key)),
                     ("commit.gpgsign", "true")):
            box._git(box.author, "config", k, v)
        sha = box.push(package("healthy"), "signed")
        assert box.apply(sha).returncode == 0, box.result()
        assert box.update("verify").returncode == 0
        assert box.result()["signature"] == "commit signature verified"


class TestRequest:
    def test_request_fetches_checks_and_schedules_a_detached_apply(self, box):
        sha = box.push(package("healthy"), "v2")
        result = box.update("request")
        assert result.returncode == 0, result.stdout
        assert re.search(r"^scheduled unknown -> %s" % sha[:7], result.stdout)
        scheduled = (box.stub / "systemd-run.log").read_text()
        assert "--unit=auxgoat-update-apply" in scheduled and "--collect" in scheduled
        assert f"apply --commit {sha}" in scheduled
        assert "--wait-for-repair" not in scheduled
        # Scheduling changes nothing by itself.
        assert not box.pkg.is_symlink()

    def test_the_repair_bootstrap_waits_for_the_repair(self, box):
        box.push(package("healthy"), "v2")
        assert box.update("request", "--via-repair").returncode == 0
        assert "--wait-for-repair" in (box.stub / "systemd-run.log").read_text()

    def test_nothing_new_is_not_an_error_and_schedules_nothing(self, box):
        healthy_update(box)
        result = box.update("request")
        assert result.returncode == 0 and "already up to date" in result.stdout
        assert not (box.stub / "systemd-run.log").exists()

    def test_a_failed_fetch_refuses_rather_than_installing_stale_code(self, box):
        box.push(package("healthy"), "v2")
        shutil.rmtree(box.origin)
        result = box.update("request")
        assert result.returncode == 1 and "could not fetch" in result.stdout
        assert not (box.stub / "systemd-run.log").exists()

    def test_the_target_is_always_the_clones_own_upstream(self, box):
        """A branch nobody configured on the box can never be installed."""
        box._git(box.author, "checkout", "-q", "-b", "side")
        (box.author / "pi" / "lockerroom" / "main.py").write_text("VALUE = 5\n")
        box._git(box.author, "commit", "-q", "-am", "side work")
        side = box._git(box.author, "rev-parse", "HEAD")
        box._git(box.author, "push", "-q", str(box.origin), "side")
        result = box.apply(side)
        assert result.returncode == 1 and "is not on origin/main" in box.result()["reason"]

    def test_the_origin_follows_the_repo_rename_when_the_new_url_answers(self, box):
        moved = box.tmp / "renamed.git"
        shutil.copytree(box.origin, moved)
        box.push(package("healthy"), "v2")
        result = box.update("request", AUXGOAT_ORIGIN_OLD_MARK="origin.git",
                            AUXGOAT_ORIGIN_NEW_URL=str(moved))
        assert result.returncode in (0, 1)
        assert box._git(box.repo, "remote", "get-url", "origin") == str(moved)

    def test_an_unreachable_new_url_changes_nothing_and_fails_nothing(self, box):
        box.push(package("healthy"), "v2")
        result = box.update("request", AUXGOAT_ORIGIN_OLD_MARK="origin.git",
                            AUXGOAT_ORIGIN_NEW_URL=str(box.tmp / "nowhere.git"))
        assert result.returncode == 0
        assert box._git(box.repo, "remote", "get-url", "origin") == str(box.origin)


class TestPowerCuts:
    """I1: kill the updater at every step; the box must come back whole."""

    @pytest.mark.parametrize("point", APPLY_CRASH_POINTS)
    def test_a_power_cut_during_apply(self, box, point):
        sha = box.push(package("healthy"), "v2")
        crashed = box.apply(sha, crash_at=point)
        assert crashed.returncode == -9, f"{point} was never reached: {crashed.stdout[-400:]}"

        # I8: from the moment the trial is journaled, the way back exists.
        if APPLY_CRASH_POINTS.index(point) >= APPLY_CRASH_POINTS.index("rollback-link"):
            rollback = box.root / "lockerroom.rollback"
            assert rollback.is_symlink()
            assert (rollback / "behavior.txt").read_text().strip() == "legacy"

        box.reboot()
        box.assert_sound()
        assert box.live_behavior() in ("legacy", "healthy")
        state = box.state()["state"]
        assert state in ("idle", "trial")
        if state == "trial":
            assert box.live_behavior() == "healthy"
            assert box.update("verify").returncode == 0
        else:
            assert box.live_behavior() == "legacy"
            # And the box is not wedged: the same update goes through afterwards.
            assert box.apply(sha).returncode == 0, box.result()
            assert box.update("verify").returncode == 0
        assert box.result()["outcome"] == "committed"
        assert box.live_behavior() == "healthy"
        assert not list((box.root / "releases").glob(".staging-*"))
        box.assert_sound()

    @pytest.mark.parametrize("point", ["commit-journaled", "synced"])
    def test_a_power_cut_during_commit_still_finishes_the_commit(self, box, point):
        sha = box.push(package("healthy", {
            "pi/scripts/report-full.sh": "#!/bin/sh\necho report v2\n"}), "v2")
        assert box.apply(sha).returncode == 0
        assert box.update("verify", crash_at=point).returncode == -9
        box.reboot()
        assert box.state()["state"] == "idle"
        assert box.live_behavior() == "healthy"
        assert "report v2" in (box.bin / "report-full.sh").read_text()
        assert box.result()["outcome"] == "committed"

    @pytest.mark.parametrize("point", ["pre-rollback", "rolled-back-link"])
    def test_a_power_cut_during_rollback_still_ends_on_the_old_code(self, box, point):
        sha = box.push(package("crash"), "crashes")
        assert box.apply(sha).returncode == 0
        assert box.update("verify", crash_at=point).returncode == -9
        box.reboot()
        if box.state()["state"] == "trial":
            assert box.update("verify").returncode == 1
        assert box.state()["state"] == "idle"
        assert box.live_behavior() == "legacy"
        box.assert_sound()

    def test_every_crash_point_is_listed(self):
        found = set(re.findall(r'crash_point\("([^"]+)"\)', UPDATER.read_text()))
        assert found == set(APPLY_CRASH_POINTS) | set(VERIFY_CRASH_POINTS)

    def test_a_damaged_release_falls_back_to_the_previous_one_at_boot(self, box):
        """The SD card ate a file. Boot on the release that still verifies."""
        healthy_update(box)
        (box.pkg / "main.py").write_text("garbage from a dying card\n")
        box.reboot()
        assert box.live_behavior() == "legacy"
        box.assert_sound()


class TestReleasesAreImmutable:
    def test_a_release_is_byte_identical_after_its_trial(self, box):
        """I2."""
        sha = box.push(package("healthy"), "v2")
        assert box.apply(sha).returncode == 0
        release = box.pkg.resolve().parent
        before = (release / "MANIFEST.sha256").read_text()
        assert box.update("verify").returncode == 0
        box.assert_sound()
        assert (release / "MANIFEST.sha256").read_text() == before


class TestPostCommitSync:
    """I12: scripts and units move only after the listener has proved itself."""

    V2 = {
        "pi/scripts/report-full.sh": "#!/bin/sh\necho report v2\n",
        "pi/scripts/btwatch.sh": "#!/bin/sh\necho btwatch v2\n",
        "pi/systemd/bt-agent.service": "[Unit]\nDescription=agent v2\n",
    }

    def test_nothing_is_synced_while_the_release_is_on_trial(self, box):
        sha = box.push(package("healthy", self.V2), "v2")
        assert box.apply(sha).returncode == 0
        assert not (box.bin / "report-full.sh").exists()
        assert not (box.units / "bt-agent.service").exists()

    def test_a_rolled_back_release_syncs_nothing(self, box):
        sha = box.push(package("crash", self.V2), "v2")
        box.apply(sha)
        box.update("verify")
        assert not (box.bin / "report-full.sh").exists()
        assert not (box.units / "bt-agent.service").exists()

    def test_a_committed_release_syncs_scripts_and_units(self, box):
        (box.bin / "report-full.sh").write_text("#!/bin/sh\necho report v0\n")
        sha = box.push(package("healthy", self.V2), "v2")
        box.apply(sha)
        assert box.update("verify").returncode == 0
        assert "report v2" in (box.bin / "report-full.sh").read_text()
        assert (box.bin / "report-full.sh").stat().st_mode & 0o111
        assert "report v0" in (box.bin / "report-full.sh.prev").read_text()
        assert "agent v2" in (box.units / "bt-agent.service").read_text()
        assert (box.units / "lockerroom-listener.service.d" / "10-auxgoat.conf").exists()
        log = box.systemctl_log()
        assert "daemon-reload" in log
        assert "try-restart --no-block lockerroom-btwatch" in log
        assert "try-restart --no-block lockerroom-netwatch" in log

    def test_the_listener_unit_and_the_audio_drop_in_are_never_synced(self, box):
        """I13. A bad listener unit is a box nobody can reach."""
        sha = box.push(package("healthy", self.V2), "v2")
        box.apply(sha)
        assert box.update("verify").returncode == 0
        assert not (box.units / "lockerroom-listener.service").exists()
        assert not list(box.units.rglob("*aplay*"))
        text = UPDATER.read_text()
        sync = text[text.index("SYNC_SCRIPTS = ["):text.index("HEX = re.compile")]
        assert '"lockerroom-listener.service"' not in sync
        assert "bluealsa-aplay-aux.conf" not in sync.split("SYNC_UNITS = [")[1].split("]")[0]

    def test_a_unit_that_fails_verification_is_skipped_not_installed(self, box):
        (box.stub / "analyze-fail").write_text("")
        sha = box.push(package("healthy", self.V2), "v2")
        box.apply(sha)
        assert box.update("verify").returncode == 0
        assert not (box.units / "bt-agent.service").exists()
        assert "report v2" in (box.bin / "report-full.sh").read_text()
        assert "rejected it" in box.result()["log"]


class TestAdoptACableDeploy:
    def test_materialise_turns_the_release_link_back_into_a_directory(self, box):
        healthy_update(box)
        assert box.pkg.is_symlink()
        assert box.update("adopt", "--materialise").returncode == 0
        assert box.pkg.is_dir() and not box.pkg.is_symlink()
        assert box.live_behavior() == "healthy"
        # Writing into it is now safe: a reboot does not "repair" it away.
        (box.pkg / "main.py").write_text("VALUE = 'serial deploy'\n")
        assert box.update("adopt", "--commit", box.v1).returncode == 0
        box.reboot()
        assert "serial deploy" in (box.pkg / "main.py").read_text()
        assert box.update("status", "--field", "commit").stdout.strip() == box.v1


class TestTheShippedUnits:
    """I13, as text: the properties that keep the box reachable."""

    RECOVER = (PI / "systemd" / "auxgoat-update-recover.service").read_text()
    LISTENER = (PI / "systemd" / "lockerroom-listener.service").read_text()

    def test_recover_runs_before_the_listener(self):
        assert re.search(r"^Before=.*lockerroom-listener\.service", self.RECOVER, re.M)
        assert re.search(r"^TimeoutStartSec=60$", self.RECOVER, re.M)

    def test_the_listener_never_requires_the_updater(self):
        """If the updater is broken the listener must still start."""
        for line in self.LISTENER.splitlines():
            if re.match(r"(Requires|BindsTo|Requisite|PartOf)=", line):
                assert "auxgoat" not in line
        for unit in (PI / "systemd").glob("*"):
            for line in unit.read_text().splitlines():
                if re.match(r"(Requires|BindsTo|Requisite)=", line):
                    assert "auxgoat-update" not in line, unit.name

    def test_the_updater_never_deletes_the_live_package_path_blindly(self):
        text = UPDATER.read_text()
        assert "rm -rf" not in text
        # The only rmtree of the live path is inside the repair branch, where
        # it has already been judged unusable and a verified release is ready.
        assert text.count("shutil.rmtree(PKG") == 1
