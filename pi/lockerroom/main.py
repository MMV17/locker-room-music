from __future__ import annotations

import asyncio
import logging
import logging.handlers

from . import config as config_mod
from .bluez_watcher import BluezWatcher
from .lifecycle import SessionManager
from .storage import Store
from .control import beacon_loop
from .sync import drain_loop


def setup_logging(log_path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    root = logging.getLogger()
    root.setLevel(logging.INFO)

    stream = logging.StreamHandler()
    stream.setFormatter(fmt)
    root.addHandler(stream)

    file_handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=5_000_000, backupCount=3
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)


async def async_main() -> None:
    cfg = config_mod.load()
    setup_logging(cfg.log_path)

    log = logging.getLogger("lockerroom.main")
    log.info("starting lockerroom listener, api_base_url=%s", cfg.api_base_url)

    store = Store(cfg.db_path)
    session_manager = SessionManager(store)
    watcher = BluezWatcher(session_manager)

    await watcher.start()

    await asyncio.gather(
        drain_loop(cfg, store),
        # Liveness + remote control. Deliberately not routed through the
        # outbox: see the module docstring in control.py.
        beacon_loop(cfg),
    )


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
