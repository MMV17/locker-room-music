from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG_PATH = Path("/etc/lockerroom/config.toml")


@dataclass(frozen=True)
class Config:
    api_base_url: str
    device_key: str
    speaker_name: str
    sync_interval_s: float
    db_path: Path
    log_path: Path


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
    )
