"""Smaller reliability fixes in the listener, each with the failure it stops."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

import lockerroom.lifecycle as lifecycle_mod
from lockerroom import netwatch, proc, software
from lockerroom.lifecycle import SessionManager
from lockerroom.netwatch import (
    DNS_BROKEN, OFFLINE, REBOOT, RESTART_NM, WatchConfig, permitted,
)

PI = Path(__file__).resolve().parents[1]
A, B = "AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"
PA, PB = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01", "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_02"
TRACK = {"Title": "Song", "Artist": "Band", "Duration": 200000}


class Store:
    def __init__(self, fail=False):
        self.rows, self.fail = [], fail

    async def enqueue(self, outbox_id, method, endpoint, payload):
        if self.fail:
            raise OSError("database or disk is full")
        self.rows.append(outbox_id)


class NullAux:
    async def route(self, mac):
        return None


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    from datetime import timedelta
    monkeypatch.setattr(lifecycle_mod, "MIN_PLAY_GRACE", timedelta(seconds=0.01))
    monkeypatch.setattr(lifecycle_mod, "AUX_SETTLE", timedelta(0))


class TestCreatedOnlyAfterTheWrite:
    """A11."""

    @pytest.mark.asyncio
    async def test_a_failed_create_does_not_leave_an_orphan_close(self):
        store = Store(fail=True)
        mgr = SessionManager(store, aux=NullAux())
        await mgr.on_device_connected(PA, A, "Phone A")
        await mgr.on_track_changed(PA, TRACK, 0)
        await asyncio.sleep(0.05)              # the create is attempted, and fails
        store.fail = False
        await mgr.on_device_disconnected(PA)
        # Before: created was set first, so a close was queued for a play the
        # server had never heard of - answered 404 for ever.
        assert store.rows == []

    @pytest.mark.asyncio
    async def test_a_successful_create_is_still_followed_by_its_close(self):
        store = Store()
        mgr = SessionManager(store, aux=NullAux())
        await mgr.on_device_connected(PA, A, "Phone A")
        await mgr.on_track_changed(PA, TRACK, 0)
        await asyncio.sleep(0.05)
        await mgr.on_device_disconnected(PA)
        assert [r.split("-")[1] for r in store.rows] == ["create", "close"]


class TestWaitingPhoneStreamingIsLogged:
    """TODO (a), diagnostics only: the measurement the multi-phone complaint needs."""

    async def two_phones(self):
        mgr = SessionManager(Store(), aux=NullAux())
        await mgr.on_device_connected(PA, A, "Holder")
        await mgr.on_track_changed(PA, TRACK, 0)
        await mgr.on_device_connected(PB, B, "Waiter")
        return mgr

    @pytest.mark.asyncio
    async def test_one_line_names_the_phone_by_two_octets_only(self, caplog):
        mgr = await self.two_phones()
        with caplog.at_level(logging.INFO, logger="lockerroom.lifecycle"):
            await mgr.on_transport_state_changed(PB, "active")
        lines = [r.getMessage() for r in caplog.records if "is streaming" in r.getMessage()]
        assert len(lines) == 1
        assert lines[0].startswith("waiting phone EE:02 is streaming")
        assert B not in lines[0], "the full MAC must not be logged"

    @pytest.mark.asyncio
    async def test_it_is_rate_limited_per_phone(self, caplog):
        mgr = await self.two_phones()
        with caplog.at_level(logging.INFO, logger="lockerroom.lifecycle"):
            for _ in range(20):
                await mgr.on_transport_state_changed(PB, "active")
                await mgr.on_transport_state_changed(PB, "idle")
        assert sum("is streaming" in r.getMessage() for r in caplog.records) == 1

    @pytest.mark.asyncio
    async def test_the_holder_streaming_is_not_news(self, caplog):
        mgr = await self.two_phones()
        with caplog.at_level(logging.INFO, logger="lockerroom.lifecycle"):
            await mgr.on_transport_state_changed(PA, "active")
        assert not any("is streaming" in r.getMessage() for r in caplog.records)

    @pytest.mark.asyncio
    async def test_it_changes_nothing_about_who_holds_the_aux(self):
        mgr = await self.two_phones()
        before = mgr.aux_state()
        await mgr.on_transport_state_changed(PB, "active")
        assert mgr.aux_state()["holder"]["mac"] == before["holder"]["mac"] == A


class TestNetwatchNeverRebootsForTheWrongReason:
    CFG = WatchConfig()

    def test_a_dns_only_failure_can_never_reach_the_reboot_rung(self):
        """A12."""
        assert permitted(REBOOT, DNS_BROKEN) == RESTART_NM
        assert permitted(REBOOT, OFFLINE) == REBOOT

    def test_names_failing_while_an_address_answers_is_dns_broken(self, monkeypatch):
        probed = []

        def probe(url, interface, timeout):
            probed.append(url)
            return url == netwatch.IP_PROBE_URL

        monkeypatch.setattr(netwatch, "probe_url", probe)
        monkeypatch.setattr(netwatch, "other_default_routes", lambda i: [])
        actions = []
        monkeypatch.setattr(netwatch, "act", lambda a, c, n, s: actions.append(a) or s)

        class Stop(Exception):
            pass

        ticks = []

        def sleep(_):
            ticks.append(1)
            if len(ticks) >= 31:
                raise Stop

        monkeypatch.setattr(netwatch.time, "sleep", sleep)
        with pytest.raises(Stop):
            netwatch.watch_loop(["https://a.example"], self.CFG)
        assert netwatch.IP_PROBE_URL in probed
        assert REBOOT not in actions, "a resolver fault rebooted the speaker"
        assert RESTART_NM in actions

    def test_no_link_at_all_still_reboots(self, monkeypatch):
        monkeypatch.setattr(netwatch, "probe_url", lambda *a: False)
        monkeypatch.setattr(netwatch, "other_default_routes", lambda i: [])
        actions = []
        monkeypatch.setattr(netwatch, "act", lambda a, c, n, s: actions.append(a) or s)

        class Stop(Exception):
            pass

        ticks = []

        def sleep(_):
            ticks.append(1)
            if len(ticks) >= 16:
                raise Stop

        monkeypatch.setattr(netwatch.time, "sleep", sleep)
        with pytest.raises(Stop):
            netwatch.watch_loop(["https://a.example"], self.CFG)
        assert REBOOT in actions

    def test_any_pool_host_answering_is_egress(self, monkeypatch):
        """Retiring the configured hostname must not look like a dead network."""
        asked = []

        def probe(url, interface, timeout):
            asked.append(url)
            return url == "https://fallback.example"

        monkeypatch.setattr(netwatch, "probe_url", probe)
        hosts = ["https://retired.example", "https://fallback.example"]
        assert netwatch.has_egress(hosts, self.CFG) is True
        assert netwatch.NEUTRAL_URL not in asked

    def test_the_host_the_listener_last_reached_is_probed_first(self, tmp_path):
        from lockerroom import endpoints
        state = tmp_path / "api-host"
        endpoints.write_last_good("https://b.example", state)
        assert endpoints.last_good_first(
            ["https://a.example", "https://b.example"], state
        ) == ["https://b.example", "https://a.example"]

    def test_netwatch_watches_the_whole_pool(self):
        source = (PI / "lockerroom" / "netwatch.py").read_text()
        assert "endpoints.configured_urls(" in source

    def test_a_reboot_is_deferred_while_music_is_playing(self, monkeypatch, tmp_path):
        """A13. Bluetooth audio does not need the internet."""
        monkeypatch.setattr(netwatch, "pcm_running", lambda *a, **k: True)
        done = []
        monkeypatch.setattr(netwatch, "do_reboot", lambda: done.append("reboot"))
        monkeypatch.setattr(netwatch, "do_bounce", lambda cfg: done.append("bounce"))
        monkeypatch.setattr(netwatch, "write_state", lambda s, *a: done.append("state"))
        state = netwatch.act(REBOOT, self.CFG, 1000.0, {})
        assert done == ["bounce"]
        assert "last_reboot_ts" not in state, "a deferred reboot used up the rate limit"

    def test_pcm_running_reads_the_alsa_status_files(self, tmp_path, real_pcm_running):
        sub = tmp_path / "card0" / "pcm0p" / "sub0"
        sub.mkdir(parents=True)
        (sub / "status").write_text("closed\n")
        assert real_pcm_running(tmp_path) is False
        (sub / "status").write_text("state: RUNNING\nowner_pid: 1\n")
        assert real_pcm_running(tmp_path) is True


class TestChildProcessesAreNotLeaked:
    """A7, Python half."""

    @pytest.mark.asyncio
    async def test_a_timed_out_child_is_killed_not_abandoned(self):
        child = await asyncio.create_subprocess_exec(
            "sleep", "60", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        with pytest.raises(asyncio.TimeoutError):
            await proc.communicate(child, timeout=0.05)
        assert child.returncode is not None, "the child is still running"
        with pytest.raises(ProcessLookupError):
            os.kill(child.pid, 0)

    @pytest.mark.asyncio
    async def test_a_normal_exit_returns_its_output(self):
        child = await asyncio.create_subprocess_exec(
            "sh", "-c", "echo hello", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate(child, timeout=5)
        assert out.strip() == b"hello"

    def test_relay_and_aux_no_longer_wait_without_killing(self):
        for name in ("relay.py", "aux.py"):
            source = (PI / "lockerroom" / name).read_text()
            assert "wait_for(proc.communicate()" not in source, name


class TestSoftwareIdentity:
    def test_a_release_file_is_read(self, tmp_path):
        f = tmp_path / "RELEASE.json"
        f.write_text('{"release_id": "abc-0", "commit": "%s", '
                     '"installed_at": "2026-11-10T12:00:00+00:00"}' % ("a" * 40))
        info = software.release_info(f)
        assert software.software_payload(info) == {
            "commit": "a" * 40, "installed_at": "2026-11-10T12:00:00+00:00"}

    @pytest.mark.parametrize("bad", ["", "XYZ", "A" * 40, "abc", "g" * 40, 7, None,
                                     "a" * 41, "deadbeef; rm -rf /"])
    def test_anything_that_is_not_a_commit_becomes_unknown(self, tmp_path, bad):
        import json
        f = tmp_path / "RELEASE.json"
        f.write_text(json.dumps({"commit": bad, "installed_at": 5}))
        assert software.software_payload(software.release_info(f)) == {
            "commit": "unknown", "installed_at": None}

    def test_a_missing_or_garbage_file_is_unknown_not_a_crash(self, tmp_path):
        assert software.release_info(tmp_path / "nope.json")["commit"] == "unknown"
        (tmp_path / "bad.json").write_text("{not json")
        assert software.release_info(tmp_path / "bad.json")["commit"] == "unknown"

    def test_the_marker_survives_an_unwritable_path(self, tmp_path):
        blocker = tmp_path / "file"
        blocker.write_text("x")
        marker = software.HealthMarker("r", path=blocker / "health.json")
        marker.good_beacon()
        marker.loop(None)      # must not raise


class TestSelftest:
    def run(self, config: Path):
        env = dict(os.environ, PYTHONPATH=str(PI))
        return subprocess.run([sys.executable, "-m", "lockerroom.selftest", str(config)],
                              cwd=PI, env=env, capture_output=True, text=True, timeout=60)

    def test_it_passes_with_a_config_like_the_one_on_the_box(self, tmp_path):
        cfg = tmp_path / "config.toml"
        cfg.write_text('api_base_url = "https://example.invalid"\ndevice_key = "k"\n'
                       'speaker_name = "AuxGoat"\nsync_interval_s = 5\n'
                       f'db_path = "{tmp_path}/x.db"\nlog_path = "{tmp_path}/x.log"\n')
        result = self.run(cfg)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "selftest ok" in result.stdout
        assert not (tmp_path / "x.db").exists(), "the selftest wrote to disk"

    def test_it_fails_when_the_config_cannot_be_loaded(self, tmp_path):
        cfg = tmp_path / "config.toml"
        cfg.write_text('speaker_name = "no api host here"\n')
        assert self.run(cfg).returncode != 0

    def test_it_fails_on_a_malformed_relay_mac(self, tmp_path):
        cfg = tmp_path / "config.toml"
        cfg.write_text('api_base_url = "https://example.invalid"\ndevice_key = "k"\n'
                       '[relay]\nspeaker_mac = "not-a-mac"\n')
        assert self.run(cfg).returncode != 0
