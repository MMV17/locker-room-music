"""Decides whose audio actually comes out of the speaker.

A2DP is not exclusive, and `bluealsa-aplay` plays EVERY connected source
unless it is handed a MAC allowlist:

    Usage: bluealsa-aplay [OPTION]... [BT-ADDR]...

So two phones connected at once were mixed into the same speaker. This module
narrows that allowlist to exactly one phone.

The mechanism is a one-line environment file plus a service restart, rather
than anything cleverer, because of how it has to fail. The drop-in reads

    EnvironmentFile=-/run/lockerroom/aux.env
    ExecStart=/usr/bin/bluealsa-aplay -S $AUX_MAC

with an UNBRACKETED $AUX_MAC on purpose: systemd drops an unset or empty
unbracketed variable entirely rather than passing an empty argument. So a
missing file, an empty value, or a listener that never ran all land on plain
`bluealsa-aplay -S` — which plays anything, exactly as it did before any of
this existed. The failure mode is the old behaviour, never a silent speaker.

/run is tmpfs, so a reboot clears the file and the same default applies. The
listener unit also resets it on the way out (ExecStopPost), so a crash cannot
leave the room routed to a phone that has gone home.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger("lockerroom.aux")

ENV_PATH = Path("/run/lockerroom/aux.env")
RESTART_ARGV = ["systemctl", "restart", "bluealsa-aplay"]
RESTART_TIMEOUT_S = 15.0



async def _systemctl_restart() -> None:
    """Restart the audio player so it picks up the new allowlist.

    argv list, never a shell string — the same rule the Pi's control channel
    follows, and for the same reason: nothing here should be one quoting
    mistake away from running arbitrary input.
    """
    proc = await asyncio.create_subprocess_exec(
        *RESTART_ARGV,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=RESTART_TIMEOUT_S)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{' '.join(RESTART_ARGV)} exited {proc.returncode}: "
            f"{(out or b'').decode(errors='replace').strip()[:200]}"
        )


class AuxRouter:
    def __init__(
        self,
        env_path: Path = ENV_PATH,
        restart: Callable[[], Awaitable[None]] = _systemctl_restart,
    ):
        self._env_path = env_path
        self._restart = restart
        # What the audio player is believed to be running with. Only updated
        # after a restart actually succeeds; see route().
        #
        # Read off disk rather than assumed, because a listener restart must
        # not look like a change. Assuming "unknown" here meant the first
        # route() after every restart re-pointed a player that was already
        # correct - and a needless restart is not free, it destroys the A2DP
        # transport of any phone that happens to be connecting at the time.
        self._live: str | None = self._read_live()

    def _read_live(self) -> str:
        """The filter the audio player is currently running with.

        Absent file or absent key both mean no filter, which is exactly what
        the systemd drop-in falls back to.
        """
        try:
            text = self._env_path.read_text()
        except OSError:
            return ""
        for line in text.splitlines():
            if line.startswith("AUX_MAC="):
                return line.split("=", 1)[1].strip()
        return ""

    async def route(self, mac: str | None) -> None:
        """Make `mac` the only phone the speaker plays.

        None means no filter at all — play whatever is connected. That is the
        right answer whenever fewer than two phones are connected, because one
        phone cannot mix with anything, and it is what keeps the common case
        free of restarts entirely. See SessionManager._aux_target.
        """
        target = "" if mac is None else mac.upper()
        if target == self._live:
            return

        self._env_path.parent.mkdir(parents=True, exist_ok=True)
        self._env_path.write_text(f"AUX_MAC={target}\n")

        try:
            await self._restart()
        except Exception:
            # Leaving _live unset is the important half. Believing the failed
            # target was applied would skip the restart next time and strand
            # the room on whatever the player is actually still playing.
            self._live = None
            log.exception("could not restart the audio player for %s", target)
            return

        self._live = target
        log.info("speaker routed to %s", target or "anything connected")
