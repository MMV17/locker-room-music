"""
Wifi egress watchdog.

The problem this exists for, observed 2026-08-04: the Pi was associated with
HCGuest, held a valid IP, and still could not reach its own gateway. Every
status tool reported healthy. `nmcli` reconnect did not clear it. A headless
box in a locker room sits in that state indefinitely, and the first anyone
knows is that a whole practice went unrecorded.

So association is not the signal. **Real egress is.** Two decisions follow:

1. The probe is bound to the wifi interface with `curl --interface`. When the
   ethernet cable is plugged in the Pi prefers eth0 (metric 100 against
   wlan0's 600), so an unbound probe would sail out over ethernet and report
   healthy while wifi was dead. Binding is what makes this honest.

2. A failure is only counted when the Worker AND a neutral host are both
   unreachable. Probing only the Worker would mean a Cloudflare incident, or
   our own bad deploy, escalates into rebooting a speaker in a locker room.
   That is the wrong blast radius for someone else's outage.

Escalation is a ladder, not a hammer: bounce the connection, then restart
NetworkManager, then reboot. The reboot rung exists because the failure we
actually saw survived a reconnect — without it this watchdog would have
watched that outage happen and done nothing useful. It is rate-limited to one
reboot per 6 hours, and the timestamp is persisted to disk, so a Pi that comes
up still broken cannot reboot-loop.

Runs under the system python3 with no third-party imports, deliberately: the
watchdog must keep working when the listener's venv or code is broken, since
those are exactly the situations where you cannot get in to fix it.
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

# Actions the ladder can take. Strings rather than an enum so they read plainly
# in the log, which is the only place anyone will ever see them.
NONE = "none"
BOUNCE = "bounce"
RESTART_NM = "restart-nm"
REBOOT = "reboot"
DROP_ROUTE = "drop-route"

# What the two probes together say about the box. Added 2026-08-09 after the
# watchdog sat through a 38-minute outage without logging a single failure.
HEALTHY = "healthy"
OFFLINE = "offline"              # neither path works — the real outage
ROUTE_TRAP = "route-trap"        # wifi fine, default route dead (the cable)
WIFI_DEGRADED = "wifi-degraded"  # default route fine, wifi dead

STATE_PATH = Path("/var/lib/lockerroom/netwatch-state.json")

# A neutral second opinion. Deliberately not a Cloudflare property: the Worker
# is already behind Cloudflare, so a Cloudflare-wide incident must not be able
# to make both probes fail at once and trigger a reboot.
NEUTRAL_URL = "http://captive.apple.com/hotspot-detect.html"


@dataclass(frozen=True)
class WatchConfig:
    interface: str = "wlan0"
    connection: str = ""          # nmcli connection name; "" = look it up live
    probe_interval_s: float = 60.0
    timeout_s: float = 10.0
    bounce_after: int = 5         # ~5 min dead
    restart_nm_after: int = 10    # ~10 min dead
    reboot_after: int = 15        # ~15 min dead
    min_reboot_interval_s: float = 6 * 3600.0
    enabled: bool = True


def decide(fails: int, cfg: WatchConfig) -> str:
    """
    Map a consecutive-failure count to an action. Pure, so the ladder can be
    tested without a Pi, a radio, or a 15-minute wait.

    Thresholds fire once on the way past. Beyond the top rung the ladder keeps
    retrying rather than giving up, because "dead for an hour" still deserves
    another attempt — the time-based reboot limit is what stops that becoming
    a loop.
    """
    if fails < cfg.bounce_after:
        return NONE
    if fails == cfg.bounce_after:
        return BOUNCE
    if fails == cfg.restart_nm_after:
        return RESTART_NM
    # Check reboot before the periodic bounce: once we are past the top of the
    # ladder, rebooting is the stronger move and should win the tie.
    if fails >= cfg.reboot_after and (fails - cfg.reboot_after) % cfg.reboot_after == 0:
        return REBOOT
    if (fails - cfg.bounce_after) % cfg.bounce_after == 0:
        return BOUNCE
    return NONE


def can_reboot(last_reboot_ts: float | None, now: float, min_interval_s: float) -> bool:
    """Rate-limit the reboot rung. `None` means we have never rebooted."""
    if last_reboot_ts is None:
        return True
    return (now - last_reboot_ts) >= min_interval_s


def read_state(path: Path = STATE_PATH) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        # A missing or corrupt state file must not stop the watchdog. Losing
        # the reboot timestamp is a far smaller problem than not running.
        return {}


def write_state(state: dict, path: Path = STATE_PATH) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state))
    except OSError:
        logging.warning("netwatch: could not persist state to %s", path)


def _run(argv: list[str], timeout: float) -> tuple[int, str]:
    """Run an argv list. Never through a shell — same rule as pi commands."""
    try:
        p = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except (subprocess.TimeoutExpired, OSError) as e:
        return 1, str(e)


def probe_url(url: str, interface: str | None, timeout: float) -> bool:
    """
    True if `url` is reachable. Bound to `interface`, or over whatever the
    default route is when `interface` is None.
    """
    argv = ["curl"]
    if interface:
        argv += ["--interface", interface]
    argv += ["--max-time", str(int(timeout)), "-s", "-S", "-o", "/dev/null", url]
    rc, _ = _run(argv, timeout=timeout + 5)
    return rc == 0


def _egress_via(api_base_url: str, cfg: WatchConfig, interface: str | None) -> bool:
    """
    Healthy if EITHER target answers over this path.

    Cheap path first: the Worker is the thing we actually care about, so when
    it answers we ask nothing else.

    Both probes MUST keep the neutral-host fallback, and this is why they share
    one implementation. If the default-route probe checked only the Worker, a
    Cloudflare incident would look like `wifi ok, default route dead` — and the
    watchdog would respond by deleting the box's default route over somebody
    else's outage.
    """
    if probe_url(api_base_url, interface, cfg.timeout_s):
        return True
    return probe_url(NEUTRAL_URL, interface, cfg.timeout_s)


def has_egress(api_base_url: str, cfg: WatchConfig) -> bool:
    """Egress over the wifi interface specifically."""
    return _egress_via(api_base_url, cfg, cfg.interface)


def has_default_route_egress(api_base_url: str, cfg: WatchConfig) -> bool:
    """
    Egress over the default route — the path the beacon and the outbox use.

    This is the probe whose absence caused the 2026-08-09 blind spot: wlan0
    answered 200 while the default route via eth0 answered nothing, so the
    watchdog reported perfect health for 38 minutes while the Pi was invisible
    to the server.
    """
    return _egress_via(api_base_url, cfg, None)


def classify(wifi_ok: bool, default_ok: bool) -> str:
    """Pure. Which of the four situations the box is in."""
    if wifi_ok and default_ok:
        return HEALTHY
    if not wifi_ok and not default_ok:
        return OFFLINE
    if wifi_ok:
        return ROUTE_TRAP
    return WIFI_DEGRADED


def permitted(action: str, situation: str) -> str:
    """
    Gate the reboot rung on the box having no egress at all.

    Rebooting is justified when nothing can reach us and the failure survived a
    reconnect — that is what it was written for. It is NOT justified to fix
    wifi the box is not currently using: power-cycling a speaker that is
    working and reachable is strictly worse than leaving it alone. Downgrade to
    the strongest non-destructive rung instead.
    """
    if action == REBOOT and situation != OFFLINE:
        return RESTART_NM
    return action


def other_default_routes(interface: str) -> list[tuple[str, str]]:
    """
    Default routes that do NOT leave via `interface`, as (gateway, device).
    Gateway is "" for a scope-link route with no via.

    These are the candidates for the ethernet trap: a route that wins on metric
    and goes nowhere.
    """
    rc, out = _run(["ip", "route", "show", "default"], timeout=15)
    if rc != 0:
        return []

    routes: list[tuple[str, str]] = []
    for line in out.splitlines():
        parts = line.split()
        if not parts or parts[0] != "default":
            continue
        gw = dev = ""
        for i, tok in enumerate(parts):
            if tok == "via" and i + 1 < len(parts):
                gw = parts[i + 1]
            elif tok == "dev" and i + 1 < len(parts):
                dev = parts[i + 1]
        if dev and dev != interface:
            routes.append((gw, dev))
    return routes


def do_drop_route(cfg: WatchConfig) -> None:
    """
    Delete the dead non-wifi default route so traffic falls back to wifi.

    Deliberately a delete rather than a metric change: DHCP will hand the route
    back on renew, and having it re-dropped a minute later is the correct
    behaviour while the cable is still in. The permanent fix is unplugging it.
    """
    for gw, dev in other_default_routes(cfg.interface):
        argv = ["ip", "route", "del", "default"]
        if gw:
            argv += ["via", gw]
        argv += ["dev", dev]
        logging.error(
            "netwatch: default route via %s dev %s is dead while %s is healthy "
            "— dropping it (unplug the cable to fix this properly)",
            gw or "(no gateway)", dev, cfg.interface,
        )
        rc, out = _run(argv, timeout=30)
        if rc != 0:
            logging.error("netwatch: could not drop that route: %s", out.strip())


def active_connection(interface: str) -> str | None:
    """The nmcli connection currently bound to `interface`, if any."""
    rc, out = _run(["nmcli", "-t", "-f", "DEVICE,CONNECTION", "device"], timeout=15)
    if rc != 0:
        return None
    for line in out.splitlines():
        # nmcli -t escapes colons inside fields, so split from the left only.
        dev, _, conn = line.partition(":")
        if dev == interface and conn and conn != "--":
            return conn
    return None


def do_bounce(cfg: WatchConfig) -> None:
    conn = cfg.connection or active_connection(cfg.interface)
    if not conn:
        logging.warning("netwatch: no connection on %s to bounce", cfg.interface)
        _run(["nmcli", "device", "connect", cfg.interface], timeout=60)
        return
    logging.warning("netwatch: bouncing connection %r on %s", conn, cfg.interface)
    _run(["nmcli", "connection", "down", conn], timeout=60)
    time.sleep(3)
    rc, out = _run(["nmcli", "connection", "up", conn], timeout=90)
    if rc != 0:
        logging.error("netwatch: bringing %r back up failed: %s", conn, out.strip())


def do_restart_nm() -> None:
    logging.warning("netwatch: restarting NetworkManager")
    _run(["systemctl", "restart", "NetworkManager"], timeout=120)


def do_reboot() -> None:
    logging.error("netwatch: egress still dead — rebooting")
    # Plays are already durable in the local outbox (spec 5.3), so a reboot
    # here costs live now-playing, not data.
    _run(["systemctl", "reboot"], timeout=30)


def act(action: str, cfg: WatchConfig, now: float, state: dict) -> dict:
    """Carry out one rung. Returns the state dict to persist."""
    if action == DROP_ROUTE:
        do_drop_route(cfg)
    elif action == BOUNCE:
        do_bounce(cfg)
    elif action == RESTART_NM:
        do_restart_nm()
    elif action == REBOOT:
        if can_reboot(state.get("last_reboot_ts"), now, cfg.min_reboot_interval_s):
            state["last_reboot_ts"] = now
            write_state(state)
            do_reboot()
        else:
            logging.warning(
                "netwatch: reboot suppressed — last one was %.0f min ago",
                (now - state["last_reboot_ts"]) / 60,
            )
            # Still worth another bounce rather than sitting idle.
            do_bounce(cfg)
    return state


def watch_loop(api_base_url: str, cfg: WatchConfig) -> None:
    if not cfg.enabled:
        logging.info("netwatch: disabled by config, exiting")
        return

    state = read_state()
    fails = 0
    logging.info(
        "netwatch: watching %s on %s (probe %.0fs, bounce@%d restart@%d reboot@%d)",
        api_base_url, cfg.interface, cfg.probe_interval_s,
        cfg.bounce_after, cfg.restart_nm_after, cfg.reboot_after,
    )

    while True:
        wifi_ok = has_egress(api_base_url, cfg)

        # Only worth asking when a route exists that ISN'T wifi. With no cable
        # in, the default route IS wlan0, so the unbound probe would be the
        # same request down the same wire — and asking would also turn "no
        # default route at all" into a phantom route trap with nothing to drop.
        if other_default_routes(cfg.interface):
            default_ok = has_default_route_egress(api_base_url, cfg)
        else:
            default_ok = wifi_ok

        situation = classify(wifi_ok, default_ok)

        if situation == HEALTHY:
            if fails:
                logging.info("netwatch: egress restored after %d failed probes", fails)
            fails = 0

        elif situation == ROUTE_TRAP:
            # Not a wifi fault, so it must not feed the wifi ladder — bouncing
            # wlan0 here would "repair" a link that is already working while
            # the beacon stayed dead. Wifi is demonstrably healthy, so any
            # accumulated count is stale.
            fails = 0
            state = act(DROP_ROUTE, cfg, time.time(), state)

        else:
            fails += 1
            logging.warning(
                "netwatch: %s — no egress on %s (%d)", situation, cfg.interface, fails
            )
            action = permitted(decide(fails, cfg), situation)
            if action != NONE:
                state = act(action, cfg, time.time(), state)

        time.sleep(cfg.probe_interval_s)


def config_from_toml(raw: dict) -> WatchConfig:
    """
    Read the `[netwatch]` table, if there is one. Every key has a default, so
    an existing config.toml keeps working untouched — the watchdog is opt-out
    rather than opt-in, because the failure it guards against is silent.
    """
    w = raw.get("netwatch", {})
    d = WatchConfig()
    return WatchConfig(
        interface=w.get("interface", d.interface),
        connection=w.get("connection", d.connection),
        probe_interval_s=float(w.get("probe_interval_s", d.probe_interval_s)),
        timeout_s=float(w.get("timeout_s", d.timeout_s)),
        bounce_after=int(w.get("bounce_after", d.bounce_after)),
        restart_nm_after=int(w.get("restart_nm_after", d.restart_nm_after)),
        reboot_after=int(w.get("reboot_after", d.reboot_after)),
        min_reboot_interval_s=float(
            w.get("min_reboot_interval_s", d.min_reboot_interval_s)
        ),
        enabled=bool(w.get("enabled", d.enabled)),
    )


def main() -> None:
    import tomllib

    from .config import DEFAULT_CONFIG_PATH

    # Log to stdout and let journald own it — the watchdog must not depend on
    # a writable log path, since a full disk is one of the things that breaks
    # a box you then cannot reach. `journalctl -u lockerroom-netwatch`.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    with open(DEFAULT_CONFIG_PATH, "rb") as f:
        raw = tomllib.load(f)

    api_base_url = raw["api_base_url"].rstrip("/")
    watch_loop(api_base_url, config_from_toml(raw))


if __name__ == "__main__":
    main()
