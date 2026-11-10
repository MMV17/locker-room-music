"""Can this code start ON THIS BOX? Run against a release before it goes live.

    python -m lockerroom.selftest            # exit 0 = safe to switch to

pi/scripts/auxgoat-update runs this from a STAGED release directory, with the
box's real config and the box's real python packages. Importing every module
proves the code parses; this proves the things an import cannot: that the
config already on the box still loads under this code's schema, that the
packages in the venv are the ones this code needs, and that the objects the
listener builds at startup can be built.

It opens no network connection, touches no Bluetooth and writes nothing. A
failure here costs nothing - the release is refused and the running listener
never notices.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    from . import config as config_mod

    path = Path(argv[0]) if argv else config_mod.DEFAULT_CONFIG_PATH
    cfg = config_mod.load(path)

    from . import control, endpoints, relaytarget, software
    from . import main as main_mod  # pulls in dbus_fast and httpx
    from .lifecycle import SessionManager
    from .relay import RelayManager
    from .storage import Store

    urls = endpoints.build_urls(cfg.api_base_url, cfg.api_fallback_urls)
    if not urls or not cfg.device_key:
        print("selftest: no usable api host or no device key in the config")
        return 1

    store = Store(Path(":memory:"))
    sessions = SessionManager(store, relay_speaker_mac=cfg.relay_speaker_mac)
    sessions.aux_state()
    sessions.open_play_state()
    relay = RelayManager(relaytarget.resolve(None, None, cfg.relay_speaker_mac))
    sessions.set_relay(relay)

    payload = software.software_payload(software.release_info())
    if set(payload) != {"commit", "installed_at"}:
        print("selftest: the software payload has the wrong shape")
        return 1
    for name, (cmd, timeout) in control.ALLOWED.items():
        if not cmd or timeout <= 0:
            print(f"selftest: command {name} is malformed")
            return 1
    if not callable(main_mod.main):
        return 1

    print(f"selftest ok: {len(urls)} api host(s), commit {payload['commit']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
