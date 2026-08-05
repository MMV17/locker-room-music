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


def probe_url(url: str, interface: str, timeout: float) -> bool:
    """True if `url` is reachable *over `interface`*."""
    rc, _ = _run(
        [
            "curl", "--interface", interface,
            "--max-time", str(int(timeout)),
            "-s", "-S", "-o", "/dev/null",
            url,
        ],
        timeout=timeout + 5,
    )
    return rc == 0


def has_egress(api_base_url: str, cfg: WatchConfig) -> bool:
    """
    Healthy if EITHER target answers over the wifi interface.

    Cheap path first: the Worker is the thing we actually care about, so when
    it answers we ask nothing else.
    """
    if probe_url(api_base_url, cfg.interface, cfg.timeout_s):
        return True
    return probe_url(NEUTRAL_URL, cfg.interface, cfg.timeout_s)


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
    if action == BOUNCE:
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
        if has_egress(api_base_url, cfg):
            if fails:
                logging.info("netwatch: egress restored after %d failed probes", fails)
            fails = 0
        else:
            fails += 1
            logging.warning("netwatch: no egress on %s (%d)", cfg.interface, fails)
            action = decide(fails, cfg)
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
