"""Which hostname the box talks to, and what it does when that one dies.

WHY THIS EXISTS. The box used to know exactly one hostname. The campus filter
has already blocked a whole zone by SNI within hours of it going live (see
"auxgoat.com is filtered" in docs/STATE.md), and a hostname can also simply be
retired. With one name, either event takes the beacon, the outbox AND the
"run repair" button down together - and the only fix is somebody standing next
to the speaker with a cable.

So there is an ORDERED LIST, shared by the beacon, the outbox drain and the
wifi watchdog:

    1. api_base_url from /etc/lockerroom/config.toml
    2. api_fallback_urls from the same file, if any
    3. DEFAULT_FALLBACKS below

and a small amount of memory: the last host that actually answered is written
to disk and used first after a restart, so a box whose primary has gone for
good does not rediscover that the slow way on every boot.

THE LIST IS NEVER LEARNED FROM THE SERVER. Every request carries the device
key, so a host that could add itself to this list could collect it. The names
come from this file and from the local config, and nowhere else.

Standard library only: netwatch imports this under the system python, which
has no httpx, and the updater asks it which hosts to probe.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterable

log = logging.getLogger("lockerroom.endpoints")

# Both serve the same Worker as the configured host. Order is preference.
DEFAULT_FALLBACKS: tuple[str, ...] = (
    "https://auxgoat-hc.mmvinton17.workers.dev",
    "https://hc.auxgoat.com",
)

CONFIG_PATH = Path("/etc/lockerroom/config.toml")
STATE_PATH = Path("/var/lib/lockerroom/api-host")

# One blip must not move the box off a healthy host; three in a row is a
# pattern. At the beacon's 10s cadence that is about half a minute.
FAILS_TO_ADVANCE = 3
# How often a box that has moved to a fallback looks back at its first choice.
PRIMARY_RETRY_S = 30 * 60.0

_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$")


def normalise(url: Any) -> str | None:
    """A usable base URL, or None. HTTPS only, host only, no path.

    HTTPS is not a preference here. The device key rides every request, and a
    plain-http host on this list would put it on the campus network in clear.
    """
    if not isinstance(url, str):
        return None
    url = url.strip().rstrip("/")
    return url if _URL_RE.match(url) else None


def build_urls(primary: Any, extra: Iterable[Any] = ()) -> list[str]:
    """The ordered, de-duplicated host list. Never empty."""
    urls: list[str] = []
    for raw in [primary, *list(extra or ()), *DEFAULT_FALLBACKS]:
        url = normalise(raw)
        if url is None:
            if raw:
                log.error("ignoring api host %r: not a plain https:// host", raw)
            continue
        if url not in urls:
            urls.append(url)
    return urls


def configured_urls(path: Path = CONFIG_PATH) -> list[str]:
    """The host list straight from config.toml, for callers with no Config.

    Used by netwatch and by the updater's "is the network up?" probe. A config
    that cannot be read still yields the built-in fallbacks: the callers are
    watchdogs, and a watchdog with nobody to ask is not a watchdog.
    """
    raw: dict = {}
    try:
        import tomllib

        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except (OSError, ValueError, ImportError):
        log.warning("could not read %s; using the built-in hosts only", path)
    extra = raw.get("api_fallback_urls", [])
    return build_urls(raw.get("api_base_url"), extra if isinstance(extra, list) else [])


def read_last_good(path: Path = STATE_PATH) -> str | None:
    try:
        return normalise(Path(path).read_text())
    except OSError:
        return None


def write_last_good(url: str, path: Path = STATE_PATH) -> None:
    """Atomic, and never fatal: forgetting this costs one slow start."""
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".api-host-")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(url + "\n")
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError:
        log.warning("could not remember the working api host in %s", path)


def last_good_first(urls: list[str], path: Path = STATE_PATH) -> list[str]:
    """The same list with the host that last worked moved to the front."""
    last = read_last_good(path)
    if last in urls:
        return [last, *[u for u in urls if u != last]]
    return list(urls)


def json_object(resp: Any) -> dict | None:
    """The response body as a JSON object, or None if it is anything else.

    This is the "is that really our Worker?" test. Our Worker answers every
    route, success or failure, with a JSON object. A filter page, a captive
    portal or a parked domain does not - and a 200 from one of those must never
    be mistaken for "the server took it".
    """
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001 - any decode failure is the same answer
        return None
    return body if isinstance(body, dict) else None


def not_our_worker(resp: Any) -> bool:
    """A non-JSON answer that is NOT just the Worker having a bad moment.

    A 5xx with an HTML or plain-text body is what a Worker exception or a
    Cloudflare incident looks like, and every hostname on the list fronts the
    same Worker - failing over would not help and would churn the pool. Below
    500, a non-JSON body means something else is answering for that name.
    """
    return json_object(resp) is None and getattr(resp, "status_code", 0) < 500


class HostPool:
    """Sticky last-good host, with failover and an occasional look back."""

    def __init__(
        self,
        urls: Iterable[str],
        state_path: Path = STATE_PATH,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._urls = [u for u in (normalise(u) for u in urls) if u] or list(DEFAULT_FALLBACKS)
        self._state_path = Path(state_path)
        self._clock = clock
        last = read_last_good(self._state_path)
        self._index = self._urls.index(last) if last in self._urls else 0
        self._persisted = last
        self._fails = 0
        self._last_primary_try = clock()
        if self._index:
            log.info("starting on %s, the host that last worked", self.current)

    @property
    def urls(self) -> list[str]:
        return list(self._urls)

    @property
    def current(self) -> str:
        return self._urls[self._index]

    def pick(self) -> str:
        """The base URL for the next request.

        Normally the current host. Once every PRIMARY_RETRY_S, while the box is
        on a fallback, it is the primary instead: one request finds out
        whether the first choice is back, and costs nothing if it is not.
        """
        if self._index and self._clock() - self._last_primary_try >= PRIMARY_RETRY_S:
            self._last_primary_try = self._clock()
            return self._urls[0]
        return self.current

    def success(self, url: str) -> None:
        """`url` answered as our Worker - even if the answer was a refusal."""
        if url not in self._urls:
            return
        index = self._urls.index(url)
        if index != self._index:
            if index != 0:
                return  # a late answer from a host we already left
            log.info("the primary api host %s is answering again", url)
            self._index = 0
        self._fails = 0
        if self._persisted != url:
            write_last_good(url, self._state_path)
            self._persisted = url

    def failure(self, url: str, why: str = "") -> None:
        """`url` could not be reached, or something else answered for it."""
        if url != self.current:
            return  # a failed look back at the primary costs nothing
        self._fails += 1
        if self._fails < FAILS_TO_ADVANCE or len(self._urls) < 2:
            return
        old = self.current
        self._index = (self._index + 1) % len(self._urls)
        self._fails = 0
        # Do not look back at the primary the moment we have left it.
        self._last_primary_try = self._clock()
        log.warning(
            "api host %s failed %d times in a row (%s) - moving to %s",
            old, FAILS_TO_ADVANCE, why or "no answer", self.current,
        )
