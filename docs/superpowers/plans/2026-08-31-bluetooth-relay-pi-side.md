# Bluetooth Relay Output (Pi side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pi play through a Bluetooth speaker it connects to itself, so any speaker works with no cable, while the existing USB and 3.5mm paths keep working unchanged.

**Architecture:** `audio-route.sh` stays the single arbiter of output and gains a third branch. Wired outputs continue to be selected by the ALSA default; the relay is selected by writing `AUX_DEV` into a second systemd `EnvironmentFile`, so every failure path still lands on a bare `bluealsa-aplay` playing to a wired output. A new `relay.py` owns only the outbound Bluetooth connection and never touches aux arbitration. `lifecycle.py` learns to ignore the far speaker so it is never mistaken for a DJ.

**Tech Stack:** Python 3.11+ (asyncio, dbus-fast via existing `bluez_watcher`), bash, systemd, udev, BlueZ/`bluetoothctl`, `bluealsa`, pytest.

## Global Constraints

- **Relay is OFF by default.** With no `[relay] speaker_mac` in config, every code path must behave exactly as it does today. This is the safety property that makes the change shippable.
- **Never a silent speaker.** Any failure — missing file, empty variable, dead relay manager, uninstalled listener — must expand to a bare `bluealsa-aplay` playing to the ALSA default (a wired output). Verified by test, not by inspection.
- **argv lists, never shell strings.** Every subprocess call passes a list. A MAC from config or from the network is never interpolated into a shell command. This matches `aux.py` and `control.py` and is the rule that keeps a locker-room speaker from becoming remote code execution.
- **MAC validation regex:** `^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`. Reject anything else, loudly.
- **Never pin ALSA cards by index.** Always by ID. Card numbers move between boots.
- **Existing tests must keep passing:** `python3 -m pytest pi/tests/ -q` — currently 118 passed.
- Run all commands from the repo root: `~/Desktop/Home_Projects/locker-room-music.nosync`.

---

### Task 1: Config gains the relay speaker

**Files:**
- Modify: `pi/lockerroom/config.py`
- Modify: `pi/config.example.toml`
- Test: `pi/tests/test_config_relay.py` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `Config.relay_speaker_mac: str | None` — uppercase MAC or `None`. Every later task reads this.

- [ ] **Step 1: Write the failing test**

Create `pi/tests/test_config_relay.py`:

```python
"""The relay speaker is opt-in, and a malformed MAC must not reach bluetoothctl."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import config as cfg  # noqa: E402

BASE = 'api_base_url = "https://x.example.com"\ndevice_key = "k"\n'


def write(tmp_path: Path, extra: str = "") -> Path:
    p = tmp_path / "config.toml"
    p.write_text(BASE + extra)
    return p


def test_absent_relay_section_means_disabled(tmp_path):
    assert cfg.load(write(tmp_path)).relay_speaker_mac is None


def test_relay_mac_is_read_and_uppercased(tmp_path):
    c = cfg.load(write(tmp_path, '\n[relay]\nspeaker_mac = "78:66:f3:1c:9d:b6"\n'))
    assert c.relay_speaker_mac == "78:66:F3:1C:9D:B6"


def test_empty_mac_means_disabled(tmp_path):
    assert cfg.load(write(tmp_path, '\n[relay]\nspeaker_mac = ""\n')).relay_speaker_mac is None


@pytest.mark.parametrize(
    "bad",
    ["not-a-mac", "78:66:F3:1C:9D", "78-66-F3-1C-9D-B6", "78:66:F3:1C:9D:B6; rm -rf /"],
)
def test_malformed_mac_is_rejected_loudly(tmp_path, bad):
    with pytest.raises(ValueError, match="speaker_mac"):
        cfg.load(write(tmp_path, f'\n[relay]\nspeaker_mac = "{bad}"\n'))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest pi/tests/test_config_relay.py -q`
Expected: FAIL — `AttributeError: 'Config' object has no attribute 'relay_speaker_mac'`

- [ ] **Step 3: Implement**

In `pi/lockerroom/config.py`, add after the imports:

```python
import re

# Rejected rather than sanitised. This value is passed to bluetoothctl as an
# argv element, and the one thing that must never happen is a config typo
# reaching a subprocess as something other than a MAC.
MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
```

Add the field to the dataclass (after `log_path`):

```python
    # None means the Bluetooth relay is disabled entirely and every code path
    # behaves exactly as it did before the relay existed.
    relay_speaker_mac: str | None = None
```

Add to `load()`, before the `return`:

```python
    relay_mac = (raw.get("relay", {}) or {}).get("speaker_mac", "") or ""
    relay_mac = relay_mac.strip()
    if relay_mac and not MAC_RE.match(relay_mac):
        raise ValueError(
            f"[relay] speaker_mac is not a MAC address: {relay_mac!r}. "
            "Expected AA:BB:CC:DD:EE:FF."
        )
```

and add to the `Config(...)` call:

```python
        relay_speaker_mac=relay_mac.upper() or None,
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pi/tests/ -q`
Expected: PASS — 122 passed (118 existing + 4 new).

- [ ] **Step 5: Document the key**

Append to `pi/config.example.toml`:

```toml
# Bluetooth relay output. OPTIONAL — omit the whole table and the speaker
# behaves exactly as before, using USB or the 3.5mm jack.
#
# When set, the Pi connects OUTWARD to this speaker as an A2DP source and
# plays through it, so no cable is needed at all. The speaker must be paired
# once by hand first:  bluetoothctl pair <MAC> && bluetoothctl trust <MAC>
#
# This MAC is excluded from aux arbitration by identity — see lifecycle.py.
# Without that exclusion the listener treats the far speaker as a DJ, grants it
# the aux and writes it into the play data.
# [relay]
# speaker_mac = "AA:BB:CC:DD:EE:FF"
```

- [ ] **Step 6: Commit**

```bash
git add pi/lockerroom/config.py pi/tests/test_config_relay.py pi/config.example.toml
git commit -m "Add the optional relay speaker MAC to config, validated strictly"
```

---

### Task 2: The listener stops mistaking the speaker for a DJ

This is the blocker recorded in `STATE.md` as *"the finding that actually kills the idea"*. On 2026-08-23 the connected JBL was granted the aux and opened play sessions.

**Files:**
- Modify: `pi/lockerroom/lifecycle.py:195-221` (constructor), `:293` (`on_device_connected`)
- Modify: `pi/lockerroom/main.py:47`
- Test: `pi/tests/test_lifecycle_relay.py` (create)

**Interfaces:**
- Consumes: `Config.relay_speaker_mac` from Task 1
- Produces: `SessionManager(store, aux=None, relay_speaker_mac: str | None = None)` — later tasks construct it this way.

- [ ] **Step 1: Write the failing test**

Create `pi/tests/test_lifecycle_relay.py`:

```python
"""The far speaker is a SINK, not a DJ.

On 2026-08-23 the relay target was granted the aux and opened play sessions:

    lockerroom.lifecycle: aux granted to JBL Charge 6 (78:66:F3:1C:9D:B6)

It must be excluded by identity, before any other logic.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.lifecycle import SessionManager  # noqa: E402
from lockerroom.storage import Store  # noqa: E402

SPEAKER = "78:66:F3:1C:9D:B6"
PHONE = "5C:AD:BA:F0:B2:61"


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "t.db")


@pytest.mark.asyncio
async def test_relay_speaker_never_opens_a_session(store):
    m = SessionManager(store, relay_speaker_mac=SPEAKER)
    await m.on_device_connected("/org/bluez/hci0/dev_78_66_F3_1C_9D_B6", SPEAKER, "JBL Charge 6")
    assert m._sessions == {}, "the far speaker must never become a session"


@pytest.mark.asyncio
async def test_relay_speaker_is_matched_case_insensitively(store):
    m = SessionManager(store, relay_speaker_mac=SPEAKER)
    await m.on_device_connected("/p", SPEAKER.lower(), "JBL Charge 6")
    assert m._sessions == {}


@pytest.mark.asyncio
async def test_phone_still_gets_the_aux_with_the_speaker_connected(store):
    m = SessionManager(store, relay_speaker_mac=SPEAKER)
    await m.on_device_connected("/speaker", SPEAKER, "JBL Charge 6")
    await m.on_device_connected("/phone", PHONE, "Mack's iPhone")
    assert list(m._sessions) == ["/phone"]
    assert m._aux_path == "/phone", "the phone must hold the aux, not wait behind a speaker"


@pytest.mark.asyncio
async def test_disconnecting_the_speaker_is_a_no_op(store):
    m = SessionManager(store, relay_speaker_mac=SPEAKER)
    await m.on_device_connected("/speaker", SPEAKER, "JBL Charge 6")
    await m.on_device_disconnected("/speaker")  # must not raise


@pytest.mark.asyncio
async def test_with_relay_disabled_nothing_is_excluded(store):
    """The safety property: unconfigured behaves exactly as before."""
    m = SessionManager(store)
    await m.on_device_connected("/speaker", SPEAKER, "JBL Charge 6")
    assert list(m._sessions) == ["/speaker"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest pi/tests/test_lifecycle_relay.py -q`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'relay_speaker_mac'`

- [ ] **Step 3: Implement**

In `pi/lockerroom/lifecycle.py`, change the constructor signature at line 196:

```python
    def __init__(self, store: Store, aux: Any | None = None, relay_speaker_mac: str | None = None):
        self._store = store
        self._aux = aux if aux is not None else NullAux()
        # The far speaker we play THROUGH, not a phone we play FOR. Excluded by
        # identity before any other logic: on 2026-08-23 it was granted the aux
        # and opened play sessions, which is what made the relay unusable.
        # Uppercased once here so every comparison is cheap and case-proof.
        self._relay_mac = relay_speaker_mac.upper() if relay_speaker_mac else None
        self._sessions: dict[str, Session] = {}
```

Add the guard as the **first** thing in `on_device_connected` (line 293), before the lock:

```python
    async def on_device_connected(self, device_path: str, mac: str, alias: str) -> None:
        if self._relay_mac and mac.upper() == self._relay_mac:
            # Not a DJ. It is where the music comes OUT. relay.py owns it.
            log.info("relay speaker connected: %s (%s) — not a session", alias, mac)
            return
        async with self._lock:
```

No change is needed in `on_device_disconnected`: the speaker never entered `_sessions`, so the disconnect finds nothing. The test asserts this rather than assuming it.

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pi/tests/ -q`
Expected: PASS — 127 passed.

- [ ] **Step 5: Wire it in main.py**

In `pi/lockerroom/main.py` line 47, change:

```python
    session_manager = SessionManager(store, aux=AuxRouter())
```

to:

```python
    session_manager = SessionManager(
        store, aux=AuxRouter(), relay_speaker_mac=cfg.relay_speaker_mac
    )
```

The config local in `async_main()` is named `cfg`, not `config`.

- [ ] **Step 6: Commit**

```bash
git add pi/lockerroom/lifecycle.py pi/lockerroom/main.py pi/tests/test_lifecycle_relay.py
git commit -m "Teach the lifecycle that the far speaker is a sink, not a DJ"
```

---

### Task 3: Three-way output arbitration

**Files:**
- Modify: `pi/scripts/audio-route.sh`
- Modify: `pi/systemd/bluealsa-aplay-aux.conf`
- Test: `pi/tests/test_audio_route.py` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `/run/lockerroom/relay-target` — written by Task 4; one line, a bare MAC. Its presence means "relay available".
  - `/run/lockerroom/output.env` — written by `audio-route.sh`; contains `AUX_DEV=-D bluealsa:DEV=<MAC>,PROFILE=a2dp`, or is **absent**.
  - `/run/lockerroom/audio-out` gains a third form: `relay:<MAC>`.

- [ ] **Step 1: Write the failing tests**

Append to `pi/tests/test_audio_route.py`:

```python
RELAY_MAC = "78:66:F3:1C:9D:B6"


def run_relay(tmp_path, cards, relay: str | None, conf_text: str | None = None) -> dict:
    """Same harness as `run`, plus a relay target file."""
    rt = tmp_path / "relay-target"
    if relay is not None:
        rt.write_text(relay + "\n")
    out_env = tmp_path / "output.env"
    make_cards(tmp_path / "asound", cards)
    root = tmp_path / "asound"
    conf = tmp_path / "asound.conf"
    state = tmp_path / "run" / "audio-out"
    flag = tmp_path / "restarted"
    if conf_text is not None:
        conf.write_text(conf_text)
    proc = subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/bin:/bin",
            "ASOUND_ROOT": str(root),
            "ASOUND_CONF": str(conf),
            "STATE_FILE": str(state),
            "RELAY_TARGET_FILE": str(rt),
            "OUTPUT_ENV_FILE": str(out_env),
            "RESTART_CMD": f"touch {flag}",
        },
    )
    return {
        "rc": proc.returncode,
        "out": proc.stdout + proc.stderr,
        "state": state.read_text().strip() if state.exists() else None,
        "output_env": out_env.read_text() if out_env.exists() else None,
        "conf": conf.read_text() if conf.exists() else None,
        "restarted": flag.exists(),
    }


def test_relay_used_when_no_usb(tmp_path):
    r = run_relay(tmp_path, [HDMI, ANALOG], RELAY_MAC)
    assert r["state"] == f"relay:{RELAY_MAC}"
    assert f"AUX_DEV=-D bluealsa:DEV={RELAY_MAC},PROFILE=a2dp" in r["output_env"]


def test_usb_beats_relay(tmp_path):
    """Plugging a cable in is an explicit act and wins."""
    r = run_relay(tmp_path, [HDMI, USB_SPEAKER, ANALOG], RELAY_MAC)
    assert r["state"] == "usb:Charge"
    assert r["output_env"] is None, "output.env must be REMOVED so the player runs bare"


def test_no_relay_target_falls_back_to_jack(tmp_path):
    r = run_relay(tmp_path, [HDMI, ANALOG], None)
    assert r["state"] == "jack:Headphones"
    assert r["output_env"] is None


def test_relay_target_with_garbage_is_refused(tmp_path):
    """A bad MAC must never reach the player's argv."""
    r = run_relay(tmp_path, [HDMI, ANALOG], "not-a-mac; rm -rf /")
    assert r["state"] == "jack:Headphones"
    assert r["output_env"] is None


def test_relay_still_writes_asound_conf_for_the_fallback(tmp_path):
    """The ALSA default must still name a real card, because every relay
    failure path lands on a bare player using it."""
    r = run_relay(tmp_path, [HDMI, ANALOG], RELAY_MAC)
    assert 'card "Headphones"' in r["conf"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest pi/tests/test_audio_route.py -q -k relay`
Expected: FAIL — state is `jack:Headphones` where `relay:...` is expected.

- [ ] **Step 3: Implement in `pi/scripts/audio-route.sh`**

Add near the other overridable paths:

```bash
RELAY_TARGET_FILE="${RELAY_TARGET_FILE:-/run/lockerroom/relay-target}"
OUTPUT_ENV_FILE="${OUTPUT_ENV_FILE:-/run/lockerroom/output.env}"
MAC_RE='^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$'
```

Add this function:

```bash
# The relay target, only if it is a well-formed MAC. Rejected rather than
# sanitised: this value becomes an argv element for the audio player, and a
# corrupted /run file must never be able to add arguments to it.
relay_target() {
  [ -r "$RELAY_TARGET_FILE" ] || return 1
  local m
  m="$(head -1 "$RELAY_TARGET_FILE" 2>/dev/null | tr -d ' \t\r\n')"
  [ -n "$m" ] || return 1
  if ! printf '%s' "$m" | grep -qE "$MAC_RE"; then
    say "WARNING: $RELAY_TARGET_FILE is not a MAC — ignoring it"
    return 1
  fi
  printf '%s\n' "$m"
}
```

**Keep the existing wired selection exactly as it is** — the ALSA default must still point at a real card, because every relay failure path falls back to it. After the existing `say "selected: $KIND ($CARD)"` and the `asound.conf` handling, add the relay arbitration. Replace the block that writes `$STATE_FILE` with:

```bash
# Three-way arbitration. USB first (plugging a cable in is an explicit act),
# then the relay (the standing default once configured), then the jack (which
# cannot be detected and is the safe fallback).
RELAY="$(relay_target)"
if [ "$KIND" != "usb" ] && [ -n "$RELAY" ]; then
  mkdir -p "$(dirname "$OUTPUT_ENV_FILE")" 2>/dev/null
  NEWDEV="AUX_DEV=-D bluealsa:DEV=$RELAY,PROFILE=a2dp"
  if [ "$(cat "$OUTPUT_ENV_FILE" 2>/dev/null)" != "$NEWDEV" ]; then
    printf '%s\n' "$NEWDEV" > "$OUTPUT_ENV_FILE"
    OUTPUT_CHANGED=1
  fi
  KIND="relay"; CARD="$RELAY"
else
  # No relay, or USB wins. Removing the file is what makes the player run bare.
  if [ -e "$OUTPUT_ENV_FILE" ]; then
    rm -f "$OUTPUT_ENV_FILE"
    OUTPUT_CHANGED=1
  fi
fi

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null
printf '%s:%s\n' "$KIND" "$CARD" > "$STATE_FILE" 2>/dev/null \
  || say "WARNING: could not write $STATE_FILE"
```

Initialise `OUTPUT_CHANGED=0` near the top of main, and make the final restart fire when **either** the config or the output env changed:

```bash
if [ "$CURRENT" = "$CARD_FOR_CONF" ] && [ "$OUTPUT_CHANGED" = "0" ]; then
  say "already routed to \"$CARD\" — nothing to do"
  exit 0
fi
```

where `CARD_FOR_CONF` is the wired card id chosen earlier (capture it into a separate variable **before** `CARD` is overwritten with the relay MAC, or the comparison against `asound.conf` becomes meaningless).

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pi/tests/test_audio_route.py -q`
Expected: PASS — all 19 (14 existing + 5 new).

- [ ] **Step 5: Add `$AUX_DEV` to the drop-in**

In `pi/systemd/bluealsa-aplay-aux.conf`, add a second `EnvironmentFile` and extend `ExecStart`:

```
EnvironmentFile=-/run/lockerroom/aux.env
# Which OUTPUT. Absent whenever a wired output is in use, which is what makes
# the bare-player fallback below the normal case rather than an error path.
EnvironmentFile=-/run/lockerroom/output.env
ExecStart=
ExecStart=/usr/bin/bluealsa-aplay -S $AUX_MAC $AUX_DEV
```

Extend the existing header comment:

```
# $AUX_DEV follows the SAME rule as $AUX_MAC and for the same reason: unset or
# empty, systemd drops it entirely and the player runs with no -D, playing to
# the ALSA default — which audio-route.sh guarantees names a real wired card.
# So a missing output.env, a dead relay manager, or an uninstalled listener all
# land on a working wired speaker rather than silence.
```

- [ ] **Step 6: Commit**

```bash
git add pi/scripts/audio-route.sh pi/systemd/bluealsa-aplay-aux.conf pi/tests/test_audio_route.py
git commit -m "Arbitrate three outputs: USB, then the Bluetooth relay, then the jack"
```

---

### Task 4: The relay manager

**Files:**
- Create: `pi/lockerroom/relay.py`
- Test: `pi/tests/test_relay.py` (create)

**Interfaces:**
- Consumes: `Config.relay_speaker_mac` (Task 1), `/run/lockerroom/relay-target` (Task 3)
- Produces: `RelayManager(mac, target_path=..., connect=..., route=...)` with `async def ensure_connected() -> bool`, `async def run(interval_s: float = 30.0) -> None`, `async def on_disconnected() -> None`.

- [ ] **Step 1: Write the failing test**

Create `pi/tests/test_relay.py`:

```python
"""Owns the outbound connection to the speaker. Nothing else.

It must never touch aux arbitration, sessions or play data — that separation is
what makes the 2026-08-23 failure impossible to repeat.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.relay import RelayManager  # noqa: E402

MAC = "78:66:F3:1C:9D:B6"


class FakeConnect:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    async def __call__(self, mac):
        self.calls.append(mac)
        return self.results.pop(0) if self.results else True


class FakeRoute:
    def __init__(self):
        self.calls = 0

    async def __call__(self):
        self.calls += 1


@pytest.mark.asyncio
async def test_writes_the_target_and_reroutes_on_connect(tmp_path):
    t = tmp_path / "relay-target"
    c, r = FakeConnect([True]), FakeRoute()
    m = RelayManager(MAC, target_path=t, connect=c, route=r)
    assert await m.ensure_connected() is True
    assert t.read_text().strip() == MAC
    assert r.calls == 1


@pytest.mark.asyncio
async def test_failed_connect_leaves_no_target(tmp_path):
    """No target file means audio-route falls back to a wired output."""
    t = tmp_path / "relay-target"
    c, r = FakeConnect([False]), FakeRoute()
    m = RelayManager(MAC, target_path=t, connect=c, route=r)
    assert await m.ensure_connected() is False
    assert not t.exists()


@pytest.mark.asyncio
async def test_already_connected_does_not_reroute_again(tmp_path):
    """A needless reroute restarts the player and cuts the music."""
    t = tmp_path / "relay-target"
    c, r = FakeConnect([True, True]), FakeRoute()
    m = RelayManager(MAC, target_path=t, connect=c, route=r)
    await m.ensure_connected()
    await m.ensure_connected()
    assert r.calls == 1


@pytest.mark.asyncio
async def test_disconnect_removes_the_target_and_reroutes(tmp_path):
    t = tmp_path / "relay-target"
    c, r = FakeConnect([True]), FakeRoute()
    m = RelayManager(MAC, target_path=t, connect=c, route=r)
    await m.ensure_connected()
    await m.on_disconnected()
    assert not t.exists(), "a stale target would route audio into a dead link"
    assert r.calls == 2


@pytest.mark.asyncio
async def test_reconnects_after_a_disconnect(tmp_path):
    t = tmp_path / "relay-target"
    c, r = FakeConnect([True, True]), FakeRoute()
    m = RelayManager(MAC, target_path=t, connect=c, route=r)
    await m.ensure_connected()
    await m.on_disconnected()
    assert await m.ensure_connected() is True
    assert t.read_text().strip() == MAC


@pytest.mark.asyncio
async def test_a_connect_that_raises_is_survived(tmp_path):
    class Boom:
        async def __call__(self, mac):
            raise RuntimeError("bluetoothctl went missing")

    t = tmp_path / "relay-target"
    m = RelayManager(MAC, target_path=t, connect=Boom(), route=FakeRoute())
    assert await m.ensure_connected() is False
    assert not t.exists()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest pi/tests/test_relay.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'lockerroom.relay'`

- [ ] **Step 3: Implement `pi/lockerroom/relay.py`**

```python
"""Owns the Pi's OUTBOUND Bluetooth connection to the speaker.

This module deliberately knows nothing about phones, sessions, the aux or play
data. On 2026-08-23 the relay failed because the listener treated the far
speaker as a DJ; keeping this concern in its own module, with the exclusion
enforced separately in lifecycle.py, is what stops that recurring.

It writes exactly one file: /run/lockerroom/relay-target. Its PRESENCE means
"a relay output is available"; audio-route.sh reads it and arbitrates. Its
absence means every wired fallback applies, which is why it is removed on
disconnect rather than left stale — a stale target routes audio into a dead
link, which is silence with every unit green.
"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger("lockerroom.relay")

TARGET_PATH = Path("/run/lockerroom/relay-target")
MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
CONNECT_TIMEOUT_S = 20.0
ROUTE_ARGV = ["sudo", "/usr/local/bin/audio-route.sh"]
ROUTE_TIMEOUT_S = 30.0


async def _bluetoothctl_connect(mac: str) -> bool:
    """argv list, never a shell string — the MAC is validated by config.py and
    passed as its own element, so it cannot become extra arguments."""
    proc = await asyncio.create_subprocess_exec(
        "bluetoothctl", "connect", mac,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=CONNECT_TIMEOUT_S)
    text = (out or b"").decode(errors="replace")
    return "Connection successful" in text or proc.returncode == 0


async def _run_audio_route() -> None:
    proc = await asyncio.create_subprocess_exec(
        *ROUTE_ARGV,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    await asyncio.wait_for(proc.communicate(), timeout=ROUTE_TIMEOUT_S)


class RelayManager:
    def __init__(
        self,
        mac: str,
        target_path: Path = TARGET_PATH,
        connect: Callable[[str], Awaitable[bool]] = _bluetoothctl_connect,
        route: Callable[[], Awaitable[None]] = _run_audio_route,
    ):
        if not MAC_RE.match(mac):
            raise ValueError(f"not a MAC address: {mac!r}")
        self._mac = mac.upper()
        self._target_path = target_path
        self._connect = connect
        self._route = route
        self._live = False

    async def ensure_connected(self) -> bool:
        if self._live:
            return True
        try:
            ok = await self._connect(self._mac)
        except Exception:
            log.exception("could not connect to the relay speaker %s", self._mac)
            return False
        if not ok:
            log.warning("relay speaker %s did not connect", self._mac)
            return False
        self._target_path.parent.mkdir(parents=True, exist_ok=True)
        self._target_path.write_text(f"{self._mac}\n")
        self._live = True
        log.info("relay speaker connected: %s", self._mac)
        await self._route()
        return True

    async def on_disconnected(self) -> None:
        """Remove the target FIRST, then reroute. Order matters: audio-route.sh
        reads the file, so clearing it before rerouting is what makes the
        fallback to a wired output immediate rather than one cycle late."""
        if not self._live:
            return
        self._live = False
        try:
            self._target_path.unlink()
        except OSError:
            pass
        log.warning("relay speaker %s disconnected — falling back", self._mac)
        await self._route()

    async def run(self, interval_s: float = 30.0) -> None:
        """Keep trying, forever. A speaker that was switched off and back on
        must rejoin without anyone visiting the locker room."""
        while True:
            await self.ensure_connected()
            await asyncio.sleep(interval_s)
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pi/tests/ -q`
Expected: PASS — 133 passed.

- [ ] **Step 5: Commit**

```bash
git add pi/lockerroom/relay.py pi/tests/test_relay.py
git commit -m "Add the relay manager: owns the outbound speaker link and nothing else"
```

---

### Task 5: Wire the relay into the listener

**Files:**
- Modify: `pi/lockerroom/main.py`
- Modify: `pi/lockerroom/lifecycle.py` (notify the relay on disconnect)
- Test: `pi/tests/test_lifecycle_relay.py` (extend)

**Interfaces:**
- Consumes: `RelayManager` (Task 4), `SessionManager(..., relay_speaker_mac=...)` (Task 2)
- Produces: `SessionManager.set_relay(relay)` — stores an object with `async def on_disconnected()`.

- [ ] **Step 1: Write the failing test**

Append to `pi/tests/test_lifecycle_relay.py`:

```python
class FakeRelay:
    def __init__(self):
        self.disconnects = 0

    async def on_disconnected(self):
        self.disconnects += 1


@pytest.mark.asyncio
async def test_speaker_disconnect_notifies_the_relay(store):
    relay = FakeRelay()
    m = SessionManager(store, relay_speaker_mac=SPEAKER)
    m.set_relay(relay)
    await m.on_device_connected("/speaker", SPEAKER, "JBL Charge 6")
    await m.on_device_disconnected("/org/bluez/hci0/dev_78_66_F3_1C_9D_B6")
    assert relay.disconnects == 1


@pytest.mark.asyncio
async def test_phone_disconnect_does_not_notify_the_relay(store):
    relay = FakeRelay()
    m = SessionManager(store, relay_speaker_mac=SPEAKER)
    m.set_relay(relay)
    await m.on_device_connected("/phone", PHONE, "Mack's iPhone")
    await m.on_device_disconnected("/phone")
    assert relay.disconnects == 0
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest pi/tests/test_lifecycle_relay.py -q`
Expected: FAIL — `AttributeError: 'SessionManager' object has no attribute 'set_relay'`

- [ ] **Step 3: Implement**

`on_device_disconnected` receives only a `device_path`, so match the relay by the path BlueZ uses: `/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF`.

In `lifecycle.py`, add to `__init__`:

```python
        self._relay: Any | None = None
        # BlueZ path form of the relay MAC, since on_device_disconnected only
        # ever sees a path. dev_78_66_F3_1C_9D_B6 for 78:66:F3:1C:9D:B6.
        self._relay_path_suffix = (
            "dev_" + self._relay_mac.replace(":", "_") if self._relay_mac else None
        )
```

Add the setter next to `set_pause`:

```python
    def set_relay(self, relay: Any) -> None:
        """Injected for the same reason as set_pause: keeps every test in
        test_lifecycle.py free of D-Bus and of bluetoothctl."""
        self._relay = relay
```

Add as the first thing in `on_device_disconnected` (line 510), before the lock:

```python
        if self._relay_path_suffix and device_path.endswith(self._relay_path_suffix):
            if self._relay is not None:
                await self._relay.on_disconnected()
            return
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pi/tests/ -q`
Expected: PASS — 135 passed.

- [ ] **Step 5: Wire it in main.py**

Add the import at the top of `pi/lockerroom/main.py`, next to the others:

```python
from .relay import RelayManager
```

In `async_main()`, immediately after the `session_manager.set_pause(watcher.pause)` line, add:

```python
    # The outbound speaker link. Constructed ONLY when configured, so an
    # unconfigured box cannot reach this code path at all — the same rule that
    # keeps AuxRouter out of every SessionManager built in a test.
    relay = None
    if cfg.relay_speaker_mac:
        relay = RelayManager(cfg.relay_speaker_mac)
        session_manager.set_relay(relay)
```

The long-lived tasks are collected in an `asyncio.gather(...)` at the end of
`async_main()`, not a list. Replace it with:

```python
    loops = [
        drain_loop(cfg, store),
        # Liveness + remote control. Deliberately not routed through the
        # outbox: see the module docstring in control.py.
        beacon_loop(cfg, session_manager),
    ]
    if relay is not None:
        # Reconnects a speaker that was switched off and back on, without
        # anyone visiting the locker room.
        loops.append(relay.run())

    await asyncio.gather(*loops)
```

- [ ] **Step 6: Commit**

```bash
git add pi/lockerroom/main.py pi/lockerroom/lifecycle.py pi/tests/test_lifecycle_relay.py
git commit -m "Start the relay manager with the listener and reconnect on drop"
```

---

### Task 6: Bluetooth watchdog

Worth having even without the relay: on 2026-08-23 the controller hard hung, every service still reported `active`, and the radio was dead — the project's signature failure on a box that cannot be reached from campus.

**Files:**
- Create: `pi/scripts/btwatch.sh`
- Create: `pi/systemd/lockerroom-btwatch.service`
- Test: `pi/tests/test_btwatch.py` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `/usr/local/bin/btwatch.sh`, unit `lockerroom-btwatch`

- [ ] **Step 1: Write the failing test**

Create `pi/tests/test_btwatch.py`:

```python
"""The controller can hard hang with every unit still green."""
from __future__ import annotations

import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "btwatch.sh"


def run(tmp_path, hci_output: str, extra_env=None) -> dict:
    fake = tmp_path / "hciconfig"
    fake.write_text(f"#!/bin/bash\ncat <<'EOF'\n{hci_output}\nEOF\n")
    fake.chmod(0o755)
    recov = tmp_path / "recovered"
    env = {
        "PATH": f"{tmp_path}:/usr/bin:/bin",
        "BTWATCH_ONESHOT": "1",
        "RECOVER_CMD": f"touch {recov}",
    }
    env.update(extra_env or {})
    p = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)
    return {"rc": p.returncode, "out": p.stdout + p.stderr, "recovered": recov.exists()}


def test_healthy_controller_is_left_alone(tmp_path):
    r = run(tmp_path, "hci0:\tType: Primary  Bus: UART\n\tUP RUNNING PSCAN ISCAN")
    assert not r["recovered"]
    assert r["rc"] == 0


def test_down_controller_triggers_recovery(tmp_path):
    r = run(tmp_path, "hci0:\tType: Primary  Bus: UART\n\tDOWN")
    assert r["recovered"]


def test_missing_controller_triggers_recovery(tmp_path):
    r = run(tmp_path, "")
    assert r["recovered"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m pytest pi/tests/test_btwatch.py -q`
Expected: FAIL — script does not exist.

- [ ] **Step 3: Implement `pi/scripts/btwatch.sh`**

```bash
#!/usr/bin/env bash
# Recover a wedged Bluetooth controller without a reboot.
#
# On 2026-08-23 the controller hard hung: both devices dropped in the same
# instant and dmesg filled with `Bluetooth: hci0: Opcode 0x0c03 failed: -110`
# (HCI_Reset going unanswered). `systemctl restart bluetooth`, `hciconfig hci0
# up` and `btmgmt power on` ALL fail in that state, while every service still
# reports active — the everything-green-and-silent failure class, on a box whose
# only other access is a serial cable.
#
# This box has no hciuart.service; the adapter is serdev-based with
# hci_uart_bcm bound to serial0-0. Unbinding and rebinding re-runs the firmware
# download and brings it back in about six seconds.
set -uo pipefail

INTERVAL_S="${BTWATCH_INTERVAL_S:-60}"
RECOVER_CMD="${RECOVER_CMD:-}"

healthy() { hciconfig hci0 2>/dev/null | grep -q "UP RUNNING"; }

recover() {
  echo "btwatch: controller is wedged — rebinding hci_uart_bcm"
  if [ -n "$RECOVER_CMD" ]; then
    $RECOVER_CMD
    return
  fi
  echo serial0-0 > /sys/bus/serial/drivers/hci_uart_bcm/unbind 2>/dev/null
  sleep 3
  echo serial0-0 > /sys/bus/serial/drivers/hci_uart_bcm/bind 2>/dev/null
  sleep 3
  # Everything that held a handle on the old adapter has to re-bind to the new
  # one, or the radio is back and nothing is using it.
  systemctl restart bluealsa bluealsa-aplay keep-discoverable bt-agent lockerroom-listener 2>/dev/null
  echo "btwatch: rebind complete"
}

while :; do
  if healthy; then
    [ "${BTWATCH_ONESHOT:-0}" = "1" ] && exit 0
  else
    recover
    [ "${BTWATCH_ONESHOT:-0}" = "1" ] && exit 0
  fi
  sleep "$INTERVAL_S"
done
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest pi/tests/ -q`
Expected: PASS — 138 passed.

- [ ] **Step 5: Create `pi/systemd/lockerroom-btwatch.service`**

```
# Recover a wedged Bluetooth controller without a reboot. See btwatch.sh for
# why the three obvious commands cannot do it.
[Unit]
Description=Locker Room Music Bluetooth controller watchdog
After=bluetooth.service
Wants=bluetooth.service

[Service]
Type=simple
ExecStart=/usr/local/bin/btwatch.sh
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Commit**

```bash
git add pi/scripts/btwatch.sh pi/systemd/lockerroom-btwatch.service pi/tests/test_btwatch.py
git commit -m "Add a Bluetooth controller watchdog with the six-second rebind recovery"
```

---

### Task 7: Ship it — deploy, provision, and an honest diagnostic

**Files:**
- Modify: `pi/scripts/deploy.sh`
- Modify: `pi/scripts/audio-check.sh`

**Interfaces:**
- Consumes: everything above
- Produces: an installed, enabled relay on the box

- [ ] **Step 1: Ship the new files in `deploy.sh`**

Add to the `scp` block:

```bash
scp -q "${REPO_ROOT}/pi/scripts/btwatch.sh" "${PI_HOST}:/tmp/btwatch.sh"
scp -q "${REPO_ROOT}/pi/systemd/lockerroom-btwatch.service" "${PI_HOST}:/tmp/lockerroom-btwatch.service"
```

Add to the remote block, next to the other installs:

```bash
sudo install -m 755 /tmp/btwatch.sh /usr/local/bin/btwatch.sh
sudo mv /tmp/lockerroom-btwatch.service /etc/systemd/system/lockerroom-btwatch.service
```

And after `daemon-reload`, alongside the other units:

```bash
sudo systemctl enable lockerroom-btwatch
sudo systemctl restart lockerroom-btwatch
```

Add `systemctl is-active lockerroom-btwatch` to the assertions block.

- [ ] **Step 2: Make `audio-check.sh` tell the truth about the relay**

This is the cost named in the spec and it must be loud, not silent. After the existing "which output is selected right now" section, add:

```bash
if [ "${SELECTED_KIND:-}" = "relay" ]; then
  echo
  echo "   !! RELAY MODE: --tone below tests the ANALOG DEFAULT, not the relay."
  echo "      The relay is selected with -D on the player, so the ALSA default"
  echo "      is NOT the audio path right now. A silent tone here does not mean"
  echo "      the room is silent, and a working tone does not mean it is not."
  echo "      To check the relay: bluetoothctl devices Connected"
  echo "      and: journalctl -u bluealsa-aplay -n 30"
fi
```

Set `SELECTED_KIND` where `SELECTED` is parsed:

```bash
SELECTED_KIND="$(cut -d: -f1 /run/lockerroom/audio-out 2>/dev/null)"
```

- [ ] **Step 3: Run the full suite**

Run: `python3 -m pytest pi/tests/ -q`
Expected: PASS — 138 passed.

Run: `bash -n pi/scripts/audio-route.sh pi/scripts/btwatch.sh pi/scripts/deploy.sh pi/scripts/audio-check.sh`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add pi/scripts/deploy.sh pi/scripts/audio-check.sh
git commit -m "Ship the relay: install btwatch, and stop --tone lying in relay mode"
```

- [ ] **Step 5: Deploy and verify on hardware**

```bash
pi/scripts/deploy.sh pi@192.168.2.3
```

Then on the Pi, add the speaker to `/etc/lockerroom/config.toml`:

```toml
[relay]
speaker_mac = "78:66:F3:1C:9D:B6"
```

Pair once by hand, then restart:

```bash
sudo bluetoothctl pair 78:66:F3:1C:9D:B6
sudo bluetoothctl trust 78:66:F3:1C:9D:B6
sudo systemctl restart lockerroom-listener
```

Verify:

```bash
cat /run/lockerroom/audio-out        # expect: relay:78:66:F3:1C:9D:B6
cat /run/lockerroom/output.env       # expect: AUX_DEV=-D bluealsa:DEV=...
systemctl show -p ExecStart --value bluealsa-aplay
journalctl -u lockerroom-listener -n 30
```

Then play music from a phone and confirm audio reaches the speaker.

**Fallback check — the one that matters most:** switch the speaker off mid-song. Expect `relay-target` to disappear, `audio-route.sh` to reroute, and audio to return to the jack within a few seconds. Switch it back on and expect it to rejoin within 30 seconds.

---

## Out of scope for this plan

Covered by **Plan 2** (`docs/superpowers/plans/`, to be written): the admin UI for scanning and selecting a speaker over the `pi_commands` channel — new allowlisted commands (`scan-speakers`, `connect-speaker`), the first **parameterised** command in a system deliberately designed without one, scan results posted back via the beacon, D1 storage, and the Admin screen flow. Until then the speaker is set by the config key above.

Also still deferred: reporting the selected output in the heartbeat.
