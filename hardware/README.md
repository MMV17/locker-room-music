# hardware/ — the AuxGoat carrier board

Everything needed to draw the AuxGoat carrier PCB in [Flux](https://www.flux.ai).
Nothing here has been fabricated.

| File | What it is |
|---|---|
| `auxgoat-carrier-design.md` | **Read this first.** The design and the reasoning — what is on the board, what is deliberately not, and the one decision that contradicts `docs/spec.md`. |
| `connections.csv` | The netlist. Every row is one pin on one net. This is the source of truth. |
| `bom.csv` | Parts, with manufacturer part numbers. |
| `flux/auxgoat-blocks.lib` | **The file you upload to Flux.** A KiCad symbol library of the board's nine functional blocks. |
| `flux/auxgoat-blocks.dcm` | Descriptions for those symbols. Optional, same folder. |
| `flux/make-lib.py` | Regenerates the `.lib` from `connections.csv`, so the two cannot drift. |

---

## What Flux can and cannot take

This shapes the whole workflow, so it is worth knowing before you start rather
than after.

**Flux imports:**

- **KiCad part libraries** — a legacy `.lib` symbol library, and `.kicad_mod`
  footprints. KiCad v4 through v6 format.
- **Altium schematics**, ASCII export only. A binary export imports empty.
- **Cadence schematics**, EDIF.

**Flux does not import:**

- KiCad schematics or KiCad PCB layouts.
- Gerbers, or a layout from anything else.

So there is no file anyone can hand you that turns into a finished schematic.
The schematic gets drawn in Flux. What this directory does is make that drawing
mechanical rather than a design exercise: every part is chosen, every net is
named, and every decision that a schematic cannot express is written down next
to the reason for it.

Flux exports fine in the other direction — Gerbers, drill, BOM, pick-and-place,
netlists — so this is an import-side limitation only.

---

## The upload, step by step

### 1. Import the block library

In Flux: **profile page → the Flux menu, top-left → Import → KiCAD parts**, and
select `flux/auxgoat-blocks.lib`.

That gives you nine symbols — `AUXGOAT_PWR`, `AUXGOAT_CM4`, `AUXGOAT_AUDIO`,
`AUXGOAT_LED`, `AUXGOAT_BTN`, `AUXGOAT_SEC`, `AUXGOAT_USB_DEV`,
`AUXGOAT_USB_HOST`, `AUXGOAT_THERM` — whose pins are the nets that cross each
block's boundary.

**Be clear about what these are.** They are scaffolding, not a shortcut. Drop
them on a sheet and wire them together and you have the top-level interconnect
of the board — the part that is genuinely ours and that no component library
contains — in about ten minutes, with the block interfaces guaranteed to match
`connections.csv`. The real parts still go inside each block.

### 2. Get the real parts from Flux's own library

Do **not** hand-build symbols for the ICs. Flux's library is backed by
distributor data; pull each of these by MPN from `bom.csv`:

| | MPN |
|---|---|
| CM4 module | `CM4102032` |
| CM4 connectors ×2 | `DF40C-100DS/0.4V(51)` |
| I2S DAC | `PCM5102APWR` |
| Secure element | `ATECC608B-SSHDA-B` |
| Analog LDO | `MCP1700T-3302E/TT` |
| USB power switch | `AP2553W6-7` |

**The CM4 symbol and footprint are the ones to be careful about.** Two hundred
pins on a 0.4 mm pitch. If Flux's part looks wrong or incomplete, take the
symbol and footprint from Raspberry Pi's own published KiCad library and import
them rather than typing a pin table by hand — `connections.csv` names CM4 pins
by **datasheet signal name** (`GPIO18`, `nRPIBOOT`, `USB_OTG_DP`) precisely so
that no pin number in this repo can ever be wrong.

### 3. Work through `connections.csv`

Filter by `block` and build one block at a time. Suggested order, which is also
the bring-up order in the design doc §7:

`PWR` → `CM4` → `USB_DEV` → `AUDIO` → `SEC` → `LED` → `BTN` → `USB_HOST` → `THERM`

`USB_DEV` comes early on purpose: without `J4` and `JP1` the board cannot be
flashed, and that is not a mistake you find late.

The `note` column carries the reason for anything non-obvious. Where a row says
something looks wrong — `J4`'s VBUS unconnected, `SCK` tied to ground, `JP1`
shipping unfitted — it is deliberate and the design doc says why.

### 4. Layout

Constraints are in the design doc §6. The short version: four layers, the CM4
footprint and keepout from Raspberry Pi's official mechanical drawing, 90 Ω
differential on the two USB pairs, and one continuous ground pour with the
audio section placed away from the module's switchers and the antenna feed.

---

## Regenerating the library

Only needed if you change `connections.csv`. The `.lib` and `.dcm` are
committed, so a fresh checkout can upload immediately.

```bash
python3 hardware/flux/make-lib.py
```

No dependencies — standard library only, same rule `pi/lockerroom/netwatch.py`
follows.

---

## Before you draw anything

Three things in the design doc change work elsewhere, and it is cheaper to know
them now:

1. **`docs/spec.md` §2's "must be the Pi 4" rule stops applying**, because the
   reason for it — the analog audio jack — is solved on this board by a DAC
   rather than by the choice of module. Design doc §1.
2. **Six lines of Pi configuration have to change** before a board makes a
   sound, and one of them is a deletion, not an addition. Design doc §5.
3. **The serial silkscreened on this board is the answer to a naming problem
   STATE.md has open** — every speaker currently answers to `AuxGoat`, so a
   phone paired to one auto-connects to another. Design doc §4.8.

---

Sources for the Flux import behaviour above:
[Importing Schematics from Cadence and Altium to Flux](https://docs.flux.ai/reference/reference-import-designs),
[Importing Components](https://docs.flux.ai/reference/reference-import-kicad),
[Importing Components from Other EDA Tools to Flux](https://docs.flux.ai/tutorials/tutorial-import-part),
[Schematics (KiCAD to Flux)](https://docs.flux.ai/Introduction/schematics--kicad-to-flux-).
