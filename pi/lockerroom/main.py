from __future__ import annotations

import asyncio
import logging
import logging.handlers

from typing import Any, Awaitable, Callable

from . import clock
from . import config as config_mod
from . import relaytarget
from .aux import AuxRouter
from .bluez_watcher import BluezWatcher
from .control import beacon_loop
from .endpoints import HostPool, build_urls
from .lifecycle import SessionManager
from .relay import RelayManager
from .storage import open_store
from .sync import FatalStoreError, drain_loop


def setup_logging(log_path) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    root = logging.getLogger()
    root.setLevel(logging.INFO)

    stream = logging.StreamHandler()
    stream.setFormatter(fmt)
    root.addHandler(stream)

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=5_000_000, backupCount=3
        )
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)
    except OSError:
        # A full or read-only disk must not stop the listener starting: the
        # journal still gets everything through the stream handler above.
        root.exception("could not open %s - logging to the journal only", log_path)

    # httpx logs every request at INFO. At one beacon every ten seconds that is
    # 8,600 lines a day, which pushed the events worth reading out of the
    # rotated log in under two weeks. Failures are logged by our own code.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


async def supervised(
    name: str,
    factory: Callable[[], Awaitable[None]],
    *,
    once: bool = False,
    base_delay_s: float = 5.0,
    max_delay_s: float = 300.0,
    fatal: tuple[type[BaseException], ...] = (),
) -> None:
    """Run one part of the listener so that its failure is not the beacon's.

    The beacon is how this box is reached. Anything else that dies - the
    Bluetooth watcher because bluetoothd is not on the bus, the relay loop, the
    outbox drain - is retried here with a growing delay and its state is
    logged, while the beacon carries on and somebody can still press a button.

    `once` is for a part that finishes when it has started (the watcher, which
    then lives on signal callbacks): it is retried until it starts, then left.
    `fatal` exceptions are the deliberate exits and are passed straight up.
    """
    log = logging.getLogger("lockerroom.main")
    delay = base_delay_s
    while True:
        try:
            await factory()
            if once:
                log.info("%s is up", name)
                return
            log.error("%s returned, which it never should - restarting it", name)
        except asyncio.CancelledError:
            raise
        except fatal:
            raise
        except Exception:
            log.exception("%s failed - retrying in %.0fs (the beacon is unaffected)", name, delay)
        await asyncio.sleep(delay)
        delay = min(max_delay_s, delay * 2)


async def run_listener(
    cfg,
    *,
    store_opener: Callable[..., Any] = open_store,
    aux_factory: Callable[[], Any] = AuxRouter,
    watcher_factory: Callable[[Any], Any] = BluezWatcher,
    relay_factory: Callable[[Any], Any] = RelayManager,
    beacon: Callable[..., Awaitable[None]] = beacon_loop,
    drain: Callable[..., Awaitable[None]] = drain_loop,
    retry_s: float = 5.0,
    keeper: Any = None,
) -> None:
    """Build the listener and run it. Split from async_main so it can be tested
    with parts that fail: see tests/test_main_startup.py."""
    log = logging.getLogger("lockerroom.main")

    # One pool, shared: the beacon and the outbox drain learn about a dead
    # hostname from each other's failures instead of each finding out alone.
    pool = HostPool(build_urls(cfg.api_base_url, cfg.api_fallback_urls))
    log.info("api hosts, in order: %s (starting on %s)", ", ".join(pool.urls), pool.current)

    # Never raises: a damaged outbox is moved aside, an unusable disk falls
    # back to memory. See storage.open_store.
    store = store_opener(cfg.db_path)
    if getattr(store, "degraded", None):
        log.error("OUTBOX IS IN MEMORY ONLY (%s): unsent plays will not survive a restart",
                  store.degraded)

    # One phone audible at a time. A2DP is not exclusive - two connected phones
    # stream into the same speaker and bluealsa-aplay mixes them - so exactly
    # one gets routed. This is the ONLY place the real router is constructed;
    # everywhere else defaults to NullAux, so nothing restarts a system service
    # as a side effect of building a SessionManager.
    session_manager = SessionManager(
        store, aux=aux_factory(), relay_speaker_mac=cfg.relay_speaker_mac
    )

    # The outbound speaker link. Always constructed now, because the speaker can
    # be chosen from the Admin screen at runtime and there is no SSH into the
    # box on campus - so "no speaker yet" has to be a resting state rather than
    # a reason the object does not exist.
    #
    # An unconfigured box still reaches no Bluetooth code: with no target,
    # RelayManager.run() does nothing but sleep.
    #
    # Precedence: whatever the server last said, else the local cache of that,
    # else config.toml. The cache is what makes the box come back up on the
    # right speaker after a power cut in a room where nobody is present and the
    # network may not return first.
    try:
        cached = relaytarget.read_cache()
        initial = relaytarget.resolve(None, cached, cfg.relay_speaker_mac)
        relay = relay_factory(initial)
    except Exception:
        # A bad cached target must cost the relay, not the control channel.
        log.exception("could not set up the relay speaker - starting with wired output")
        cached, initial = None, None
        relay = relay_factory(None)
    session_manager.set_relay(relay)
    session_manager.set_relay_mac(initial)
    # And keep them in step when the speaker is changed from the Admin screen.
    # Without this the new speaker would be treated as a DJ's phone: granted
    # the aux, written into the play data. See test_lifecycle_relay.py.
    relay.on_target_changed(session_manager.set_relay_mac)
    if initial:
        source = "cache" if cached else "config.toml"
        log.info("bluetooth relay output: %s (from %s)", initial, source)
    else:
        log.info("no bluetooth relay speaker selected — wired output")

    async def start_watcher() -> None:
        # A fresh watcher per attempt. A phone that is connected but not routed
        # gets paused through it, so it does not run through a playlist into
        # nothing; wired here because the watcher takes the manager as its
        # sink, and doing it in either constructor would be a cycle.
        watcher = watcher_factory(session_manager)
        session_manager.set_pause(watcher.pause)
        # getattr: test doubles for the watcher predate profile control.
        if hasattr(watcher, "disconnect_profile") and hasattr(watcher, "connect_profile"):
            session_manager.set_profiles(watcher.disconnect_profile, watcher.connect_profile)
        try:
            await watcher.start()
        except BaseException:
            close = getattr(watcher, "close", None)
            if close is not None:
                close()
            raise

    await asyncio.gather(
        # Liveness + remote control. Deliberately not routed through the
        # outbox: see the module docstring in control.py. It also carries the
        # chosen speaker back down: selection is state on the beacon response,
        # not a parameterised command.
        #
        # FIRST, AND NOT SUPERVISED. Nothing below is awaited before this
        # starts, so a dead bluetoothd or a damaged database cannot keep the
        # box off the air. And if the beacon loop itself ever dies the right
        # answer is for the whole process to exit and systemd to restart it,
        # not to limp on unreachable.
        # `keeper` corrects the box's clock from the server's time (clock.py).
        # Only the real entry point passes one, so nothing under test can ever
        # set the clock of the machine running the tests.
        beacon(cfg, session_manager, relay=relay, pool=pool,
               **({"keeper": keeper} if keeper is not None else {})),
        supervised(
            "outbox drain", lambda: drain(cfg, store, pool=pool),
            base_delay_s=retry_s, fatal=(FatalStoreError,),
        ),
        supervised("bluetooth watcher", start_watcher, once=True, base_delay_s=retry_s,
                   max_delay_s=60.0),
        # Reconnects a speaker that was switched off and back on, without
        # anyone having to visit the locker room. A no-op until one is chosen.
        supervised("relay", relay.run, base_delay_s=retry_s),
    )


async def async_main() -> None:
    cfg = config_mod.load()
    setup_logging(cfg.log_path)

    log = logging.getLogger("lockerroom.main")
    log.info("starting lockerroom listener, api_base_url=%s", cfg.api_base_url)
    await run_listener(cfg, keeper=clock.Keeper())


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
