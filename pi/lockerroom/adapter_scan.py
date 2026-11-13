"""Scan for speakers on ONE named adapter (2026-11-13, the USB dongle).

    python -m lockerroom.adapter_scan hci0 15

Prints the same lines bt-scan.sh always has - MAC<TAB>CLASS<TAB>RSSI<TAB>NAME -
so btscan.py parses it unchanged.

WHY THIS EXISTS. With a dongle carrying the phones, a new relay speaker has to
be found and paired by the BUILT-IN chip, because that is the adapter the relay
connects through. bluetoothctl scans whichever adapter it treats as default
(probe order), and a one-shot `busctl call ... StartDiscovery` does not work
either: BlueZ ends a discovery the moment the client that started it leaves
the bus, which for busctl is immediately. So this holds the connection for the
whole sweep. bt-scan.sh only calls it when lockerroom/adapters.py says split.
"""
from __future__ import annotations

import asyncio
import re
import sys
from typing import Any

_HCI_RE = re.compile(r"^hci\d+$")


def format_line(props: dict[str, Any]) -> str | None:
    """One output line from a Device1 property dict, or None without an address."""
    mac = props.get("Address")
    if not isinstance(mac, str) or not mac:
        return None
    cls = props.get("Class")
    rssi = props.get("RSSI")
    name = props.get("Name") or props.get("Alias") or ""
    name = str(name).replace("\t", " ").replace("\n", " ")
    return "\t".join([
        mac,
        f"0x{int(cls):08x}" if isinstance(cls, int) else "",
        str(int(rssi)) if isinstance(rssi, int) else "",
        name,
    ])


async def scan(hci: str, seconds: float) -> list[str]:
    from dbus_fast import BusType
    from dbus_fast.aio import MessageBus

    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    try:
        path = f"/org/bluez/{hci}"
        intro = await bus.introspect("org.bluez", path)
        adapter = bus.get_proxy_object("org.bluez", path, intro).get_interface("org.bluez.Adapter1")
        try:
            await adapter.call_start_discovery()
        except Exception:  # noqa: BLE001 - already discovering is fine
            pass
        await asyncio.sleep(seconds)
        try:
            await adapter.call_stop_discovery()
        except Exception:  # noqa: BLE001
            pass

        root = await bus.introspect("org.bluez", "/")
        om = bus.get_proxy_object("org.bluez", "/", root).get_interface(
            "org.freedesktop.DBus.ObjectManager")
        objects = await om.call_get_managed_objects()
        lines = []
        prefix = path + "/dev_"
        for obj_path, ifaces in objects.items():
            if not obj_path.startswith(prefix) or "/" in obj_path[len(prefix):]:
                continue
            dev = ifaces.get("org.bluez.Device1")
            if not dev:
                continue
            props = {k: getattr(v, "value", v) for k, v in dev.items()}
            line = format_line(props)
            if line:
                lines.append(line)
        return lines
    finally:
        bus.disconnect()


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not _HCI_RE.match(argv[0]):
        print("usage: python -m lockerroom.adapter_scan hciN SECONDS", file=sys.stderr)
        return 2
    try:
        seconds = max(1.0, min(60.0, float(argv[1])))
    except ValueError:
        return 2
    for line in asyncio.run(scan(argv[0], seconds)):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
