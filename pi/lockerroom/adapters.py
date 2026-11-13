"""Which Bluetooth adapter does what (2026-11-13, the USB dongle).

    PHONES  where phones connect and send their audio. Discoverable as the
            speaker's name.
    RELAY   where the outbound link to the Bluetooth speaker (the JBL) lives.
            Hidden from phones.
    UART    the Pi's built-in chip, or "" if it is missing - what btwatch
            watches and rebinds.

WHY. The built-in chip is one radio on a serial line, shared with wifi. With
two phones and the relay on it, phones knocked each other's streams out and
the serial line lost audio fragments ("Unexpected start frame", docs/STATE.md
"Two phones: the second stream knocks out the first"). A USB dongle takes the
phones; the built-in chip keeps only the speaker.

    built-in only          PHONES = RELAY = the built-in chip   (today, unchanged)
    built-in + dongle      PHONES = dongle, RELAY = built-in    (SPLIT)
    dongle only            PHONES = RELAY = the dongle

ADAPTERS ARE TOLD APART BY BUS, NEVER BY NUMBER. hci0/hci1 follow probe order,
and btwatch's rebind re-creates the built-in adapter under the NEXT free
number - so after one recovery the built-in chip can be hci1 and the dongle
hci0. The built-in chip hangs off the serial bus, a dongle off USB, and that
never changes.

Also a CLI for the shell scripts, so there is one implementation of this, and
it ships atomically with the listener:

    PYTHONPATH=/opt/lockerroom /opt/lockerroom/venv/bin/python -m lockerroom.adapters
    PHONES=hci1
    RELAY=hci0
    UART=hci0
    SPLIT=1

Dependency-free on purpose (see macaddr.py): the laptop test venv is 3.9 and
config.py needs 3.11.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# Overridable so the shell scripts' tests can point everything at a fake tree.
SYSFS = Path(os.environ.get("AUXGOAT_BT_SYSFS", "/sys/class/bluetooth"))
# sysfs also holds one entry per CONNECTION ("hci0:12"); only adapters match.
_ADAPTER_RE = re.compile(r"^hci\d+$")


@dataclass(frozen=True)
class Roles:
    phones: str | None
    relay: str | None
    uart: str | None

    @property
    def split(self) -> bool:
        return bool(self.phones and self.relay and self.phones != self.relay)


def adapters(sysfs: Path = SYSFS) -> list[tuple[str, str]]:
    """[(name, "usb" | "uart")], lowest number first."""
    try:
        entries = sorted(sysfs.iterdir(), key=lambda p: int(p.name[3:]) if _ADAPTER_RE.match(p.name) else -1)
    except OSError:
        return []
    out = []
    for entry in entries:
        if not _ADAPTER_RE.match(entry.name):
            continue
        try:
            target = os.path.realpath(entry / "device")
        except OSError:
            target = ""
        out.append((entry.name, "usb" if "/usb" in target else "uart"))
    return out


def roles(sysfs: Path = SYSFS) -> Roles:
    found = adapters(sysfs)
    usb = [name for name, bus in found if bus == "usb"]
    uart = [name for name, bus in found if bus == "uart"]
    relay = uart[0] if uart else (usb[0] if usb else None)
    phones = usb[0] if (usb and uart) else relay
    return Roles(phones=phones, relay=relay, uart=uart[0] if uart else None)


def on_relay_only_adapter(device_path: str, sysfs: Path = SYSFS) -> bool:
    """Whether a BlueZ device object lives on an adapter phones must not use.

    Only ever true when split: with one adapter, everything shares it, exactly
    as before the dongle.
    """
    r = roles(sysfs)
    return r.split and device_path.startswith(f"/org/bluez/{r.relay}/")


def main() -> int:
    r = roles()
    print(f"PHONES={r.phones or ''}")
    print(f"RELAY={r.relay or ''}")
    print(f"UART={r.uart or ''}")
    print(f"SPLIT={1 if r.split else 0}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
