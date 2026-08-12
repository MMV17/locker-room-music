#!/usr/bin/env python3
"""Generate a Flux-importable KiCad symbol library from connections.csv.

Flux imports KiCad *parts* — a legacy `.lib` symbol library — and nothing else
that we can author here. It cannot take a KiCad schematic, a KiCad layout, or
Gerbers. (Altium ASCII and Cadence EDIF schematics do import, but writing
either by hand is a worse bet than drawing the sheet.)

So what gets uploaded is a **block library**: one symbol per functional block,
whose pins are the nets that cross that block's boundary. Drop the seven
symbols on a Flux sheet and you have the top-level interconnect — the part of
the design that is ours — with the real subcircuits still to fill in from
Flux's own component library.

The point of generating it rather than drawing it is that `connections.csv`
stays the single source of truth. A net renamed there cannot silently disagree
with the symbol you imported last week.

    python3 hardware/flux/make-lib.py

Writes auxgoat-blocks.lib and auxgoat-blocks.dcm next to this file. Both are
committed, so you do not need to run this to use them.
"""

from __future__ import annotations

import csv
import sys
from collections import OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONNECTIONS = HERE.parent / "connections.csv"

# Nets that are power distribution rather than block interconnect. They go on
# the left of every symbol and get the `W` (power input) electrical type, so
# an ERC anywhere downstream treats them as rails instead of as signals.
POWER_NETS = {"+5V", "+3V3_CM4", "+3V3_A", "GND", "VBUS", "VBUS_F", "USB_VBUS"}

# The subset of those that are board-wide rails, and so belong on a block's
# boundary even when only one block happens to touch them. VBUS and USB_VBUS
# are deliberately not here: they exist between two parts inside a single
# block, and putting them on the boundary would advertise an interface that
# nothing on the other side can connect to.
GLOBAL_RAILS = {"+5V", "+3V3_CM4", "+3V3_A", "GND"}

# Nets that exist only inside one block and are not worth exposing. `NC` is the
# placeholder for "this pin is deliberately unconnected" and is never a real net.
SKIP_NETS = {"NC"}

# KiCad legacy geometry, in mils. 100 between pins is the standard grid.
PIN_PITCH = 100
PIN_LENGTH = 300
BODY_HALF_WIDTH = 700
BODY_MARGIN = 100

BLOCK_DESCRIPTIONS = {
    "PWR": "AuxGoat carrier: USB-C input, protection, 5V rail, analog 3V3 LDO",
    "CM4": "AuxGoat carrier: Raspberry Pi CM4 module and its two DF40 connectors",
    "AUDIO": "AuxGoat carrier: PCM5102A I2S DAC, -6dB pad, 3.5mm line out",
    "LED": "AuxGoat carrier: five-state RGB status indicator, plain GPIO",
    "BTN": "AuxGoat carrier: long-press provisioning button, debounced",
    "SEC": "AuxGoat carrier: ATECC608B secure element on I2C1",
    "USB_DEV": "AuxGoat carrier: rpiboot USB device port and nRPIBOOT jumper",
    "USB_HOST": "AuxGoat carrier: current-limited USB 2.0 host port",
    "THERM": "AuxGoat carrier: fan header, not populated",
}


def read_rows(path: Path) -> list[dict[str, str]]:
    """Read connections.csv, dropping the `#` comment lines it is full of.

    csv.DictReader has no comment support, so the filtering happens first. The
    comments carry most of the reasoning in that file and are worth keeping.
    """
    with path.open(newline="", encoding="utf-8") as fh:
        lines = [ln for ln in fh if not ln.lstrip().startswith("#") and ln.strip()]
    return list(csv.DictReader(lines))


def crossing_nets(rows: list[dict[str, str]]) -> dict[str, list[str]]:
    """Per block, the nets that also appear in some other block.

    A net wholly contained in one block (the RC on the button, say) is internal
    detail and does not belong on the block's boundary. Power rails always
    cross by definition. Order follows first appearance in the file, which
    keeps the symbols stable across regeneration.
    """
    blocks_by_net: dict[str, set[str]] = {}
    order: dict[str, OrderedDict[str, None]] = {}

    for row in rows:
        net, block = row["net"].strip(), row["block"].strip()
        if not net or not block or net in SKIP_NETS:
            continue
        blocks_by_net.setdefault(net, set()).add(block)
        order.setdefault(block, OrderedDict())[net] = None

    return {
        block: [n for n in nets if len(blocks_by_net[n]) > 1 or n in GLOBAL_RAILS]
        for block, nets in order.items()
    }


def symbol(block: str, nets: list[str]) -> str:
    """One KiCad legacy symbol: power on the left, signals on the right."""
    left = [n for n in nets if n in POWER_NETS]
    right = [n for n in nets if n not in POWER_NETS]

    rows = max(len(left), len(right), 1)
    half_height = (rows - 1) * PIN_PITCH // 2 + BODY_MARGIN
    name = f"AUXGOAT_{block}"

    out = [
        f"# {name}",
        "#",
        f"DEF {name} B 0 40 Y Y 1 F N",
        f'F0 "B" {-BODY_HALF_WIDTH} {half_height + 50} 50 H V L CNN',
        f'F1 "{name}" {-BODY_HALF_WIDTH} {-half_height - 100} 50 H V L CNN',
        f'F2 "" 0 0 50 H I C CNN',
        f'F3 "" 0 0 50 H I C CNN',
        "DRAW",
        f"S {-BODY_HALF_WIDTH} {half_height} {BODY_HALF_WIDTH} {-half_height} 0 1 10 f",
    ]

    number = 1
    for side, names in (("L", left), ("R", right)):
        # `orientation` in KiCad legacy is the direction the pin body extends
        # from its connection point, so a pin drawn on the LEFT edge points
        # Right, back toward the body. Getting this backwards is the classic
        # way to end up with a symbol whose pins float in space.
        if side == "L":
            x, orientation = -(BODY_HALF_WIDTH + PIN_LENGTH), "R"
        else:
            x, orientation = BODY_HALF_WIDTH + PIN_LENGTH, "L"

        top = (len(names) - 1) * PIN_PITCH // 2
        for i, net in enumerate(names):
            y = top - i * PIN_PITCH
            etype = "W" if net in POWER_NETS else "P"
            out.append(
                f"X {net} {number} {x} {y} {PIN_LENGTH} {orientation} 50 50 1 1 {etype}"
            )
            number += 1

    out += ["ENDDRAW", "ENDDEF", "#"]
    return "\n".join(out)


def main() -> int:
    if not CONNECTIONS.exists():
        print(f"missing {CONNECTIONS}", file=sys.stderr)
        return 1

    rows = read_rows(CONNECTIONS)
    blocks = crossing_nets(rows)

    lib = ["EESchema-LIBRARY Version 2.4", "#encoding utf-8", "#"]
    dcm = ["EESchema-DOCLIB  Version 2.0", "#"]

    for block, nets in blocks.items():
        lib.append(symbol(block, nets))
        dcm += [
            f"$CMP AUXGOAT_{block}",
            f"D {BLOCK_DESCRIPTIONS.get(block, 'AuxGoat carrier block')}",
            "K auxgoat carrier cm4",
            "$ENDCMP",
            "#",
        ]

    lib.append("#End Library")
    dcm.append("#End Doc Library")

    (HERE / "auxgoat-blocks.lib").write_text("\n".join(lib) + "\n", encoding="utf-8")
    (HERE / "auxgoat-blocks.dcm").write_text("\n".join(dcm) + "\n", encoding="utf-8")

    for block, nets in blocks.items():
        print(f"{block:<10} {len(nets):>2} boundary nets")
    print(f"\nwrote {len(blocks)} symbols to {HERE}/auxgoat-blocks.lib")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
