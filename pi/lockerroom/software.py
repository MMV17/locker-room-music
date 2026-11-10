"""What this listener knows about its own installation.

Four small jobs, all of them about the box being updated over the air (see
pi/scripts/auxgoat-update) and none of them about music:

  * which release is this?            -> `software` on every beacon
  * am I alive and beaconing?         -> /run/lockerroom/health.json
  * what happened to the last update? -> a `kind: update` report, sent once
  * a command's result that has not reached the server yet, kept on disk so a
    listener restart does not lose it.

Standard library only, and every function here swallows its own I/O errors: a
read-only disk or a missing directory must cost a status line, never the
beacon loop.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("lockerroom.software")

# Next to the package, inside the release directory the live symlink points
# into - which is why this resolves the path first. A cable deploy leaves a
# plain directory, and deploy.sh writes the same file one level up from it.
RELEASE_FILE = Path(__file__).resolve().parent.parent / "RELEASE.json"
HEALTH_PATH = Path("/run/lockerroom/health.json")
PENDING_PATH = Path("/var/lib/lockerroom/pending-result.json")
UPDATE_RESULT_PATH = Path("/opt/lockerroom/update/last-result.json")
UPDATE_REPORTED_PATH = Path("/var/lib/lockerroom/update-reported")
BOOT_ID_PATH = Path("/proc/sys/kernel/random/boot_id")

_COMMIT_RE = re.compile(r"^[0-9a-f]{4,40}$")


def _read_json(path: Path) -> dict:
    try:
        obj = json.loads(Path(path).read_text())
        return obj if isinstance(obj, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, obj: dict) -> bool:
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(obj, f)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return True
    except OSError:
        log.warning("could not write %s", path)
        return False


def boottime() -> float:
    """Seconds since boot. Not the wall clock: this box has no RTC, and a
    marker stamped with a date that can jump proves nothing to the updater."""
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def boot_id(path: Path = BOOT_ID_PATH) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return "unknown"


def release_info(path: Path = RELEASE_FILE) -> dict[str, Any]:
    """{release_id, commit, installed_at} for the code that is running."""
    raw = _read_json(path)
    commit = raw.get("commit")
    installed = raw.get("installed_at")
    return {
        "release_id": raw.get("release_id") if isinstance(raw.get("release_id"), str) else None,
        "commit": commit if isinstance(commit, str) and _COMMIT_RE.match(commit) else "unknown",
        "installed_at": installed if isinstance(installed, str) and installed else None,
    }


def software_payload(info: dict[str, Any]) -> dict[str, Any]:
    """Exactly the two keys the Worker validates, and nothing else."""
    return {"commit": info.get("commit") or "unknown", "installed_at": info.get("installed_at")}


class HealthMarker:
    """The proof-of-life file the updater's trial reads.

    Only code new enough to have this class writes it, which is the point: a
    release that cannot start, or that starts and cannot beacon, never
    produces a marker naming itself, and the updater rolls it back.
    """

    def __init__(self, release_id: str | None, path: Path = HEALTH_PATH,
                 boot_id_path: Path = BOOT_ID_PATH):
        self._path = Path(path)
        self._release_id = release_id
        self._boot_id = boot_id(boot_id_path)
        self._good = 0
        self._first_good: float | None = None
        self._last_good: float | None = None
        self._open_play = False
        self._sessions = 0

    def good_beacon(self) -> None:
        now = boottime()
        self._good += 1
        self._first_good = self._first_good if self._first_good is not None else now
        self._last_good = now

    def loop(self, sessions: Any = None) -> None:
        """Called once per beacon-loop pass, whether or not the beacon worked."""
        try:
            if sessions is not None:
                self._open_play = sessions.open_play_state() is not None
                aux = sessions.aux_state()
                self._sessions = len(aux.get("waiting", [])) + (1 if aux.get("holder") else 0)
        except Exception:  # noqa: BLE001 - a status read must never stop the loop
            pass
        _write_json(self._path, {
            "release_id": self._release_id,
            "pid": os.getpid(),
            "boot_id": self._boot_id,
            "loop_boottime": boottime(),
            "good_beacons": self._good,
            "first_good_boottime": self._first_good,
            "last_good_boottime": self._last_good,
            "open_play": self._open_play,
            "sessions": self._sessions,
        })


# -- a command result that has not reached the server yet --------------------

def load_pending(path: Path = PENDING_PATH) -> dict[str, Any]:
    raw = _read_json(path)
    return {k: raw.get(k) if isinstance(raw.get(k), dict) else None
            for k in ("result", "scan", "report")}


def save_pending(pending: dict[str, Any], path: Path = PENDING_PATH) -> None:
    if not any(pending.get(k) for k in ("result", "scan", "report")):
        try:
            Path(path).unlink()
        except OSError:
            pass
        return
    _write_json(path, {k: pending.get(k) for k in ("result", "scan", "report")})


# -- the outcome of the last over-the-air update ------------------------------

def unreported_update(
    max_chars: int,
    truncation_notice: str,
    result_path: Path = UPDATE_RESULT_PATH,
    reported_path: Path = UPDATE_REPORTED_PATH,
) -> tuple[str, dict[str, Any]] | None:
    """(id, report payload) for an update result the server has not seen."""
    result = _read_json(result_path)
    rid = result.get("id")
    if not isinstance(rid, str) or not rid:
        return None
    try:
        if Path(reported_path).read_text().strip() == rid:
            return None
    except OSError:
        pass

    def short(c: Any) -> str:
        return c[:7] if isinstance(c, str) and _COMMIT_RE.match(c) else "unknown"

    body = (
        f"AuxGoat software update: {result.get('outcome', 'unknown')}\n"
        f"{result.get('reason', '')}\n"
        f"from {short(result.get('from_commit'))} to {short(result.get('to_commit'))}\n"
        f"{result.get('signature') or ''}\n\n"
        f"--- updater log ---\n{result.get('log', '')}"
    )
    if len(body) > max_chars:
        body = body[: max_chars - len(truncation_notice)] + truncation_notice
    return rid, {
        "kind": "update",
        "at": result.get("at"),
        "body": body,
        "ok": result.get("ok") is True,
    }


def mark_update_reported(rid: str, reported_path: Path = UPDATE_REPORTED_PATH) -> None:
    path = Path(reported_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".update-reported-")
        with os.fdopen(fd, "w") as f:
            f.write(rid + "\n")
        os.replace(tmp, path)
    except OSError:
        log.warning("could not record that update result %s was reported", rid)
