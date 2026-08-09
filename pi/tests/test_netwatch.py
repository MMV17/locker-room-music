"""
Tests for the wifi egress watchdog.

The ladder is deliberately pure so it can be tested without a Pi, a radio, or
a fifteen-minute wait. The parts that touch the world (curl, nmcli, reboot)
are thin wrappers over an argv runner and are exercised by patching that.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import netwatch  # noqa: E402
from lockerroom.netwatch import (  # noqa: E402
    BOUNCE,
    NONE,
    REBOOT,
    RESTART_NM,
    WatchConfig,
    can_reboot,
    config_from_toml,
    decide,
    has_egress,
)

CFG = WatchConfig(bounce_after=5, restart_nm_after=10, reboot_after=15)


class TestLadder:
    def test_quiet_until_the_first_threshold(self):
        # A blip must not bounce the radio. Four minutes of failure is a blip.
        for fails in range(0, 5):
            assert decide(fails, CFG) == NONE

    def test_bounces_at_five(self):
        assert decide(5, CFG) == BOUNCE

    def test_restarts_networkmanager_at_ten(self):
        assert decide(10, CFG) == RESTART_NM

    def test_reboots_at_fifteen(self):
        # The rung that matters: the zombie state observed on 2026-08-04
        # survived an nmcli reconnect.
        assert decide(15, CFG) == REBOOT

    def test_keeps_trying_past_the_top_of_the_ladder(self):
        # Dead for an hour still deserves another attempt. Silence here would
        # mean the watchdog gives up exactly when it is most needed.
        assert decide(20, CFG) == BOUNCE
        assert decide(30, CFG) == REBOOT

    def test_reboot_wins_ties_with_bounce(self):
        # 30 is a multiple of both 5 and 15. The stronger move should win.
        assert decide(30, CFG) == REBOOT


class TestRebootRateLimit:
    def test_allows_the_first_ever_reboot(self):
        assert can_reboot(None, now=1000.0, min_interval_s=6 * 3600) is True

    def test_blocks_a_second_reboot_inside_the_window(self):
        # This is what stops a Pi that comes up still broken from looping.
        assert can_reboot(1000.0, now=1000.0 + 3600, min_interval_s=6 * 3600) is False

    def test_allows_again_once_the_window_passes(self):
        assert can_reboot(1000.0, now=1000.0 + 6 * 3600, min_interval_s=6 * 3600) is True


class TestEgressProbe:
    def test_healthy_when_the_worker_answers(self, monkeypatch):
        calls = []

        def fake(url, interface, timeout):
            calls.append(url)
            return True

        monkeypatch.setattr(netwatch, "probe_url", fake)
        assert has_egress("https://example.test", CFG) is True
        # Cheap path: the neutral host is not consulted when the Worker is up.
        assert calls == ["https://example.test"]

    def test_falls_back_to_the_neutral_host(self, monkeypatch):
        # A Worker outage must NOT be able to reboot a locker room speaker.
        def fake(url, interface, timeout):
            return url != "https://example.test"

        monkeypatch.setattr(netwatch, "probe_url", fake)
        assert has_egress("https://example.test", CFG) is True

    def test_unhealthy_only_when_both_fail(self, monkeypatch):
        monkeypatch.setattr(netwatch, "probe_url", lambda *a, **k: False)
        assert has_egress("https://example.test", CFG) is False

    def test_probe_is_bound_to_the_wifi_interface(self, monkeypatch):
        # Without --interface the probe would leave via eth0 (metric 100) and
        # report healthy while wifi was dead. This is the whole point.
        seen = {}

        def fake_run(argv, timeout):
            seen["argv"] = argv
            return 0, ""

        monkeypatch.setattr(netwatch, "_run", fake_run)
        netwatch.probe_url("https://example.test", "wlan0", 10.0)
        assert "--interface" in seen["argv"]
        assert seen["argv"][seen["argv"].index("--interface") + 1] == "wlan0"

    def test_probe_never_uses_a_shell(self, monkeypatch):
        seen = {}

        def fake_run(argv, timeout):
            seen["argv"] = argv
            return 0, ""

        monkeypatch.setattr(netwatch, "_run", fake_run)
        netwatch.probe_url("https://example.test; rm -rf /", "wlan0", 10.0)
        # The URL stays one argv element; it cannot become another command.
        assert seen["argv"][-1] == "https://example.test; rm -rf /"


class TestConfig:
    def test_defaults_apply_when_the_table_is_absent(self):
        # An existing config.toml must keep working untouched.
        cfg = config_from_toml({"api_base_url": "https://example.test"})
        assert cfg.interface == "wlan0"
        assert cfg.bounce_after == 5
        assert cfg.enabled is True

    def test_values_override(self):
        cfg = config_from_toml(
            {"netwatch": {"interface": "wlan1", "bounce_after": 2, "enabled": False}}
        )
        assert cfg.interface == "wlan1"
        assert cfg.bounce_after == 2
        assert cfg.enabled is False


class TestActiveConnection:
    def test_finds_the_connection_bound_to_the_interface(self, monkeypatch):
        out = "eth0:netplan-eth0\nwlan0:netplan-wlan0-Chapin\nlo:lo\n"
        monkeypatch.setattr(netwatch, "_run", lambda argv, timeout: (0, out))
        assert netwatch.active_connection("wlan0") == "netplan-wlan0-Chapin"

    def test_returns_none_for_a_disconnected_interface(self, monkeypatch):
        out = "wlan0:--\n"
        monkeypatch.setattr(netwatch, "_run", lambda argv, timeout: (0, out))
        assert netwatch.active_connection("wlan0") is None


# ---------------------------------------------------------------------------
# The blind spot found in production 2026-08-09.
#
# netwatch probed only wlan0 and asked "is wifi healthy?". The beacon uses the
# DEFAULT ROUTE. With a cable plugged in those are different paths: the Pi had
# `default via 192.168.2.1 dev eth0 metric 100` which was dead, while wlan0
# reached the Worker fine. The beacon was down 38 minutes and the netwatch
# journal for that window held two lines — the service starting. The ladder
# never ran, because from where it was looking nothing was wrong.
# ---------------------------------------------------------------------------

from lockerroom.netwatch import (  # noqa: E402
    DROP_ROUTE,
    HEALTHY,
    OFFLINE,
    ROUTE_TRAP,
    WIFI_DEGRADED,
    classify,
    has_default_route_egress,
    other_default_routes,
    permitted,
)


class TestClassify:
    def test_both_paths_working_is_healthy(self):
        assert classify(wifi_ok=True, default_ok=True) == HEALTHY

    def test_neither_path_working_is_a_real_outage(self):
        assert classify(wifi_ok=False, default_ok=False) == OFFLINE

    def test_wifi_fine_but_default_route_dead_is_the_ethernet_trap(self):
        # Exactly the production failure. Bouncing wifi here would "fix" a
        # problem that does not exist while the beacon stayed dead.
        assert classify(wifi_ok=True, default_ok=False) == ROUTE_TRAP

    def test_default_route_fine_but_wifi_dead_is_only_degraded(self):
        # The box can still reach us, over ethernet. Worth repairing wifi,
        # never worth power-cycling a speaker that is working.
        assert classify(wifi_ok=False, default_ok=True) == WIFI_DEGRADED


class TestDefaultRouteProbe:
    def test_the_default_route_probe_is_not_bound_to_an_interface(self, monkeypatch):
        seen = []

        def fake_run(argv, timeout):
            seen.append(argv)
            return 0, ""

        monkeypatch.setattr(netwatch, "_run", fake_run)
        has_default_route_egress("https://example.test", CFG)
        assert seen, "no probe was issued"
        assert "--interface" not in seen[0], "must follow the default route, not wlan0"

    def test_a_worker_outage_is_not_mistaken_for_a_route_trap(self, monkeypatch):
        # If only the Worker is down, BOTH probes fall back to the neutral host
        # and both report healthy. Without this, a Cloudflare incident would
        # make the watchdog delete the box's default route.
        def fake(url, interface, timeout):
            return "captive.apple.com" in url

        monkeypatch.setattr(netwatch, "probe_url", fake)
        wifi = netwatch.has_egress("https://worker.test", CFG)
        default = has_default_route_egress("https://worker.test", CFG)
        assert classify(wifi_ok=wifi, default_ok=default) == HEALTHY


class TestOtherDefaultRoutes:
    IP_ROUTE = (
        "default via 192.168.2.1 dev eth0 proto dhcp src 192.168.2.2 metric 100 \n"
        "default via 192.168.1.1 dev wlan0 proto dhcp src 192.168.1.6 metric 600 \n"
    )

    def test_finds_the_non_wifi_default_route(self, monkeypatch):
        monkeypatch.setattr(netwatch, "_run", lambda argv, timeout: (0, self.IP_ROUTE))
        assert other_default_routes("wlan0") == [("192.168.2.1", "eth0")]

    def test_never_offers_to_delete_the_wifi_route(self, monkeypatch):
        only_wifi = "default via 192.168.1.1 dev wlan0 proto dhcp metric 600 \n"
        monkeypatch.setattr(netwatch, "_run", lambda argv, timeout: (0, only_wifi))
        assert other_default_routes("wlan0") == []

    def test_handles_a_route_with_no_gateway(self, monkeypatch):
        out = "default dev usb0 scope link metric 100 \n"
        monkeypatch.setattr(netwatch, "_run", lambda argv, timeout: (0, out))
        assert other_default_routes("wlan0") == [("", "usb0")]

    def test_survives_ip_route_failing(self, monkeypatch):
        monkeypatch.setattr(netwatch, "_run", lambda argv, timeout: (1, "boom"))
        assert other_default_routes("wlan0") == []


class TestRebootGate:
    def test_reboot_is_allowed_when_there_is_no_egress_at_all(self):
        assert permitted(REBOOT, OFFLINE) == REBOOT

    def test_reboot_is_downgraded_while_the_box_can_still_reach_us(self):
        # Rebooting a speaker that is working, to fix wifi it is not using,
        # is strictly worse than leaving it alone.
        assert permitted(REBOOT, WIFI_DEGRADED) == RESTART_NM

    def test_gentler_rungs_are_untouched(self):
        for situation in (OFFLINE, WIFI_DEGRADED):
            assert permitted(BOUNCE, situation) == BOUNCE
            assert permitted(RESTART_NM, situation) == RESTART_NM
            assert permitted(NONE, situation) == NONE


class TestDropRoute:
    def test_deletes_the_dead_default_route_by_gateway_and_device(self, monkeypatch):
        calls = []

        def fake_run(argv, timeout):
            calls.append(argv)
            if argv[:3] == ["ip", "route", "show"]:
                return 0, "default via 192.168.2.1 dev eth0 metric 100 \n"
            return 0, ""

        monkeypatch.setattr(netwatch, "_run", fake_run)
        netwatch.act(DROP_ROUTE, CFG, now=0.0, state={})
        assert ["ip", "route", "del", "default", "via", "192.168.2.1", "dev", "eth0"] in calls

    def test_never_uses_a_shell(self, monkeypatch):
        calls = []

        def fake_run(argv, timeout):
            calls.append(argv)
            if argv[:3] == ["ip", "route", "show"]:
                return 0, "default via 10.0.0.1 dev eth0 metric 100 \n"
            return 0, ""

        monkeypatch.setattr(netwatch, "_run", fake_run)
        netwatch.act(DROP_ROUTE, CFG, now=0.0, state={})
        for argv in calls:
            assert isinstance(argv, list)
            assert not any("&&" in part or ";" in part for part in argv)
