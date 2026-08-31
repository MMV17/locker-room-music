from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from .macaddr import normalise as _normalise_mac

DEFAULT_CONFIG_PATH = Path("/etc/lockerroom/config.toml")


@dataclass(frozen=True)
class Config:
    api_base_url: str
    device_key: str
    speaker_name: str
    sync_interval_s: float
    db_path: Path
    log_path: Path
    # None means the Bluetooth relay is disabled entirely and every code path
    # behaves exactly as it did before the relay existed. That is the safety
    # property the whole feature rests on.
    relay_speaker_mac: str | None = None


def load(path: Path = DEFAULT_CONFIG_PATH) -> Config:
    with open(path, "rb") as f:
        raw = tomllib.load(f)

    return Config(
        api_base_url=raw["api_base_url"].rstrip("/"),
        device_key=raw["device_key"],
        speaker_name=raw.get("speaker_name", "AuxGoat"),
        sync_interval_s=float(raw.get("sync_interval_s", 15)),
        db_path=Path(raw.get("db_path", "/var/lib/lockerroom/lockerroom.db")),
        log_path=Path(raw.get("log_path", "/var/log/lockerroom/listener.log")),
        # Raises on a malformed value rather than falling back to "disabled":
        # a typo here should stop the listener with a clear message, not
        # silently produce a speaker that quietly ignores its own config.
        relay_speaker_mac=_normalise_mac(
            (raw.get("relay") or {}).get("speaker_mac"),
            field="[relay] speaker_mac",
        ),
    )
