"""Keep the box's clock right, from the server it already talks to.

WHY THIS EXISTS. The Pi has no clock battery, and on the school network NTP
does not reach it: on 2026-11-12 the box was 8.6 days behind, was set by hand
over the serial console, and was four minutes behind again within the hour.
A wrong clock stamps songs with the wrong day, closes voting the instant a
song ends, and - once it is far enough off - sits outside the validity dates
of the server's TLS certificate, at which point nothing can be reached at all.

WHERE THE TIME COMES FROM. Every beacon is an HTTPS request to our own Worker
over a VERIFIED connection, and every response carries a `Date` header. That is
a time source nobody on the local network can forge without a certificate for
our hostname. So after a good beacon the listener compares that header with
its own clock and, when they disagree, sets the clock.

WHEN IT WILL NOT TOUCH THE CLOCK.

  * While a song is open or a phone is connected. Play times are measured on
    the wall clock, and stepping it under a song would corrupt that song.
    The correction simply waits for a quiet moment.
  * For a difference under THRESHOLD_S. Jitter is not drift.
  * Twice in MIN_INTERVAL_S. One correction, then a pause.
  * To a time outside sane bounds (before this was written, or decades on).

THE ONE HARD CASE: a clock so wrong that TLS itself fails ("certificate is not
yet valid"). Then there is no verified answer to read. `rescue()` handles it
without trusting anything it cannot check afterwards: it reads the Date header
with verification OFF, sets the clock to it, and then makes a VERIFIED request.
If that succeeds and agrees, the time was real - only the genuine server can
complete a verified handshake. If it does not, the clock is put back exactly
where it would have been, and nothing is tried again for an hour. A forged
header therefore costs a few seconds of wrong clock on an idle box, not a box
pinned in the wrong year - which is the flaw that kept the earlier boot script
(a plain-HTTP, forward-only step) from ever being installed.
"""

from __future__ import annotations

import logging
import ssl
import subprocess
import time
from email.utils import parsedate_to_datetime
from typing import Awaitable, Callable

import httpx

log = logging.getLogger("lockerroom.clock")

# Do not correct jitter; do correct real drift (the box loses minutes an hour).
THRESHOLD_S = 30.0
# At most one ordinary correction in this long.
MIN_INTERVAL_S = 600.0
# 2026-11-01T00:00:00Z, and twenty years on. A header outside this is ignored.
NOT_BEFORE = 1793491200.0
NOT_AFTER = NOT_BEFORE + 20 * 365.25 * 86400
# Consecutive certificate-date failures before the rescue is attempted.
CERT_FAILS_BEFORE_RESCUE = 3
# After a rescue attempt, successful or not, leave it alone this long.
RESCUE_BACKOFF_S = 3600.0
# The rescue is for a clock that is badly wrong, never for drift.
RESCUE_MIN_ERROR_S = 3600.0
# How closely the verified answer must agree with the clock just set.
RESCUE_AGREE_S = 120.0

# OpenSSL's X509 verify codes for "not yet valid" and "has expired".
_CERT_DATE_CODES = (9, 10)


def parse_date(header: object) -> float | None:
    """An HTTP Date header as epoch seconds, or None if it is not one."""
    if not isinstance(header, str) or not header.strip():
        return None
    try:
        return parsedate_to_datetime(header.strip()).timestamp()
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def sane(epoch: float | None) -> bool:
    return epoch is not None and NOT_BEFORE <= epoch <= NOT_AFTER


def wanted_step(
    local_now: float,
    server_now: float | None,
    idle: bool,
    since_last_step_s: float | None,
) -> float | None:
    """The time to set the clock to after a verified beacon, or None to leave it."""
    if not idle or not sane(server_now):
        return None
    assert server_now is not None
    if abs(server_now - local_now) <= THRESHOLD_S:
        return None
    if since_last_step_s is not None and since_last_step_s < MIN_INTERVAL_S:
        return None
    return server_now


def is_cert_date_error(exc: BaseException | None) -> bool:
    """Whether a failed request failed because of the certificate's DATES.

    Walks the exception chain: httpx wraps the ssl error. Both directions
    count - a clock too far behind sees "not yet valid", too far ahead sees
    "expired" - and nothing else does: an unknown issuer or a wrong hostname
    is somebody else's certificate, and no clock change should follow that.
    """
    seen = 0
    while exc is not None and seen < 8:
        if isinstance(exc, ssl.SSLCertVerificationError):
            if getattr(exc, "verify_code", None) in _CERT_DATE_CODES:
                return True
        text = str(exc).lower()
        if "certificate is not yet valid" in text or "certificate has expired" in text:
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def set_clock(epoch: float) -> bool:
    """Set the system clock. The listener runs as root; anything else fails here."""
    try:
        proc = subprocess.run(
            ["date", "-u", "-s", f"@{int(round(epoch))}"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("could not set the clock: %s", exc)
        return False
    if proc.returncode != 0:
        log.warning("could not set the clock: %s", (proc.stderr or proc.stdout).strip()[:200])
        return False
    return True


async def _unverified_date(url: str) -> float | None:
    """The server's Date header WITHOUT certificate verification. Rescue only."""
    try:
        async with httpx.AsyncClient(verify=False, timeout=10.0) as client:  # noqa: S501
            resp = await client.get(url + "/api/theme")
        return parse_date(resp.headers.get("date"))
    except (httpx.HTTPError, OSError):
        return None


async def _verified_date(url: str) -> float | None:
    """The server's Date header over a normally verified connection, or None."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url + "/api/theme")
        if resp.status_code != 200:
            return None
        return parse_date(resp.headers.get("date"))
    except (httpx.HTTPError, OSError):
        return None


class Keeper:
    """The clock's memory between beacons: when it last stepped, how many
    certificate-date failures in a row, when a rescue was last tried.

    Everything that touches the outside world is injectable, so the tests can
    drive every branch without a clock, a network or root.
    """

    def __init__(
        self,
        set_clock: Callable[[float], bool] = set_clock,
        wall: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
        unverified_date: Callable[[str], Awaitable[float | None]] = _unverified_date,
        verified_date: Callable[[str], Awaitable[float | None]] = _verified_date,
    ) -> None:
        self._set = set_clock
        self._wall = wall
        self._mono = mono
        self._unverified = unverified_date
        self._verified = verified_date
        self._last_step: float | None = None
        self._last_rescue: float | None = None
        self._cert_fails = 0

    def on_good_beacon(self, date_header: object, idle: bool) -> bool:
        """Call after a beacon our Worker answered over verified TLS.

        Returns True when the clock was stepped.
        """
        self._cert_fails = 0
        now_mono = self._mono()
        since = None if self._last_step is None else now_mono - self._last_step
        local = self._wall()
        target = wanted_step(local, parse_date(date_header), idle, since)
        if target is None:
            return False
        if not self._set(target):
            return False
        self._last_step = now_mono
        log.info("clock corrected by %+.0f seconds, from the server's time", target - local)
        return True

    def on_failure(self, exc: BaseException) -> bool:
        """Call when a beacon failed. True means: a rescue is worth attempting."""
        if not is_cert_date_error(exc):
            self._cert_fails = 0
            return False
        self._cert_fails += 1
        if self._cert_fails < CERT_FAILS_BEFORE_RESCUE:
            return False
        if self._last_rescue is not None and self._mono() - self._last_rescue < RESCUE_BACKOFF_S:
            return False
        return True

    async def rescue(self, url: str, idle: bool) -> bool:
        """Get out of "TLS fails because the clock is wrong". See the module docstring.

        Returns True when the clock was set and then PROVEN right.
        """
        if not idle:
            return False
        self._last_rescue = self._mono()
        self._cert_fails = 0
        claimed = await self._unverified(url)
        before_wall, before_mono = self._wall(), self._mono()
        if not sane(claimed):
            log.warning("clock rescue: no usable time from %s", url)
            return False
        assert claimed is not None
        if abs(claimed - before_wall) < RESCUE_MIN_ERROR_S:
            # The certificate complaint is not explained by our clock. Leave it.
            log.warning("clock rescue: the server's time is close to ours; not a clock problem")
            return False
        if not self._set(claimed):
            return False
        proven = await self._verified(url)
        if proven is not None and abs(proven - self._wall()) <= RESCUE_AGREE_S:
            self._last_step = self._mono()
            log.warning(
                "clock rescue: the clock was %+.0f seconds out; set, and confirmed over "
                "a verified connection", claimed - before_wall,
            )
            return True
        # Could not be proven: put the clock back where it would have been.
        restored = before_wall + (self._mono() - before_mono)
        self._set(restored)
        log.warning(
            "clock rescue: a time read without verification could not be confirmed "
            "over a verified connection - clock put back, not trying again for an hour"
        )
        return False
