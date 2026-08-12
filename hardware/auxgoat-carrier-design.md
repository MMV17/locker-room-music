# AuxGoat carrier board — design

Date: 2026-08-12. Status: **design, ready to draw.** Nothing has been
fabricated. The netlist in `connections.csv` is complete enough to build the
schematic from; the layout decisions at the end are not yet made.

This is the board that turns the Raspberry Pi 4 + dongle + SD card on a desk
into one part you can put in a case. It exists because
`docs/superpowers/specs/2026-08-07-device-provisioning-design.md` §"What this
requires of the PCB and case" listed six hardware requirements and then said
they had to be decided before a board was laid out. This decides them.

Read the provisioning design first. This document assumes it.

---

## 1. The decision that changes the spec

`docs/spec.md` §2 says, in bold: **"Must be the Pi 4, not the Pi 5. The Pi 5
removed the 3.5mm analog audio jack."** The entire architecture depends on
analog audio coming out of the compute and going into the speaker's aux in.

**The CM4 has no analog audio out either.** It has the same problem the Pi 5
has, for the same reason. The 3.5mm jack on a Pi 4B is not a SoC feature — it
is PWM on GPIO40/41 pushed through an RC filter and an op-amp *on the 4B's own
board*, and GPIO40/41 are not brought out to the CM4 connectors at all. Moving
to a Compute Module means the analog output stage becomes our problem.

So the board carries a DAC. **TI PCM5102A, I2S, on GPIO18/19/21.**

This is not a compromise, it is an upgrade, and it is worth being clear about
why:

| | Pi 4B headphone jack | PCM5102A |
|---|---|---|
| Source | ~11-bit PWM through an RC filter | 32-bit sigma-delta |
| SNR | ~90 dB on a good day, and it is on the same board as a wifi radio | 112 dB |
| Output | ~1.1 Vrms, known for whine under CPU load | 2.1 Vrms, ground-centered |
| Driver | `dtparam=audio=on` | `dtoverlay=hifiberry-dac` |

The product is a music product. It has been playing through the worst analog
stage in the building since phase 1, and nobody has complained because nobody
has heard the alternative.

**Consequence for the spec:** §2's "must be the Pi 4" rule is about the analog
jack, and once the board has its own DAC the rule stops applying. `docs/spec.md`
should be amended when this board is real, not before — the current text is
correct for the current hardware.

**Consequence for the Pi software:** §5 below. It is a two-line config change
and one line of `provision.sh`, and it must land before the first board boots
or the box is silent.

### The output is padded 6 dB down

The PCM5102A puts out 2.1 Vrms full scale. Consumer aux inputs expect somewhere
around 0.3–1.0 Vrms and the cheap ones clip well before 2.1. A box that sounds
worse than the phone it replaced is a box nobody plugs in.

`R10/R12` and `R11/R13` are a fixed 470R/470R divider: −6 dB, 1.05 Vrms out,
235 Ω source impedance. Fixed rather than jumper-selectable because a jumper is
a support conversation and 1 Vrms is right for every input this will meet.

---

## 2. Module choice

**CM4102032** — 2 GB RAM, 32 GB eMMC, wireless.

- **2 GB** matches the Pi 4 in `docs/spec.md` §2 and is generous for what runs:
  BlueZ, one Python process, SQLite.
- **eMMC, not Lite.** The provisioning design already argued this: a consumer
  cannot reflash an SD card, and an SD card in an always-on appliance fails.
  This repo has its own evidence — `pi/scripts/provision.sh` exists because "a
  card stopped accepting writes and the rebuild turned out to be an hour of
  remembering which packages mattered."
- **32 GB, not 8 or 16.** The delta is a few dollars and the local SQLite
  outbox is never deleted from by design (spec §5.3, "never delete synced rows
  — the local DB is the backup of record"). A box that runs for five seasons
  should not be the thing that tests that rule.
- **Wireless.** Non-negotiable; the box is a Bluetooth speaker that syncs over
  wifi.

### The antenna is a config line, not a part number

The CM4 wireless module has both a PCB antenna and an MHF4 connector on the
module itself. There is no separate external-antenna SKU. You get the external
antenna by fitting a pigtail and adding **`dtparam=ant2`** to
`/boot/firmware/config.txt`. Without that line the u.FL connector is
electrically present and doing nothing, which is a genuinely confusing way to
lose an afternoon.

`docs/spec.md` §2 specifies a USB dongle with an external antenna because "the
Pi's built-in radio shares an antenna with wifi and gets unreliable in a crowded
room." **The CM4's MHF4 carries wifi and Bluetooth on the same feed, so an
external antenna improves the gain but does not separate the two radios.** That
is a real limitation of this design and it is being accepted for v1, because:

- STATE.md records the dongle as "deliberately deferred by Mack until range
  actually causes a problem; do not re-raise unprompted" — so the shared antenna
  has never actually been shown to be the problem.
- The board keeps a USB-A host port (§4.6), so the exact dongle from the spec's
  parts list still plugs in if range turns out to matter. That is the escape
  hatch, and it costs one connector.

If a second revision needs true radio separation, the answer is a soldered-down
USB Bluetooth module, not a bigger antenna.

**Compliance note:** swapping to an external antenna voids the module's
pre-certification unless the antenna is one Raspberry Pi has certified. Use the
official antenna kit for anything that leaves a desk.

---

## 3. What this board deliberately does not have

Every one of these is on the CM4 connector and costs real board area, layers,
or length matching to bring out. None of them is used by any code in this repo.

| Left off | Why |
|---|---|
| HDMI, DSI, CSI | Headless. There is no screen and there is no camera, and spec §1 forbids adding one that listens. |
| PCIe | Nothing to plug into it. Routing it is what forces the expensive part of a CM4 layout. |
| Ethernet / RJ45 | The Pi runs on HCGuest with no cable, verified. And STATE.md has a whole section titled "Do not leave the ethernet cable plugged in" — a dead eth0 route at metric 100 silently killed egress for 38 minutes. **Not fitting the connector removes that failure mode from the product permanently.** |
| microSD | eMMC part. |
| Second USB host | One is enough for the dongle escape hatch. |
| Real-time clock | The box has a network and no reason to know the time offline. |

Leaving Ethernet off is the one that is a product decision rather than a cost
decision, and it is worth saying plainly: this board cannot be given a wired
connection. That is on purpose. The netwatch route-trap bug
(STATE.md, 2026-08-09) is impossible on hardware with one interface.

---

## 4. The blocks

Full pin-level detail is in `connections.csv`. This is the reasoning.

### 4.1 Power

USB-C in, 5 V, 5.1k on both CC pins so a Type-C source will offer 3 A.
Polyfuse → TVS → ferrite → 210 µF of bulk, then straight to every +5V pin on
both connectors.

`docs/spec.md` §2 says "undervoltage causes Bluetooth dropouts, do not use a
phone charger." On a Pi 4 that was a warning printed on a box. Here it is the
copper: the CM4's 5 V pins are spread across both connectors and populating a
subset is a classic first-carrier mistake that produces exactly the symptom the
spec warns about — a box that works on the bench and drops Bluetooth in a room.

**Analog gets its own regulator.** `U3` is a 3.3 V LDO feeding only the DAC.
The CM4's own 3.3 V rail is downstream of the module's switchers and is powering
a radio that transmits in bursts; sharing it with an audio DAC is how you get a
whine that tracks wifi traffic. An LDO and two capacitors is a cheap way to
never have that conversation.

The CM4's 3.3 V still powers the LED, the button pull-up, and the secure
element — a few tens of milliamps, all of it digital. **Confirm the carrier-side
current budget for that rail against the CM4 datasheet before adding anything
else to it.**

### 4.2 Audio

Covered in §1. Two wiring details that are easy to get wrong:

- **`SCK` tied to GND.** The PCM5102A can take an external system clock or
  generate one with its internal PLL, and grounding SCK selects the PLL. The
  `hifiberry-dac` overlay assumes exactly this. A floating SCK gives you a DAC
  that enumerates and outputs silence.
- **`XSMT` through an RC.** 10k to +3V3_A with 100 nF to ground holds the DAC
  muted for about a millisecond after the rail comes up. Without it every boot
  and every reboot puts a pop through a speaker in a locker room.

The 3.5mm jack is a board-mount TRS. **The aux cable staying plugged in is the
enforcement mechanism for the whole product** — spec §2: "on most Bluetooth
speakers, an occupied aux jack disables their own Bluetooth radio." The case
needs a cable clamp or a captive cable; a jack someone can knock loose with a
gym bag defeats the product, not just the audio.

### 4.3 Status LED — discrete RGB, not addressable

The provisioning design asked for "addressable RGB or two discrete" and five
distinguishable states. This board uses **one common-cathode RGB LED on
GPIO5/6/13**, plain GPIO, three resistors.

**The reason is a pin conflict, and it is not obvious.** Driving a WS2812 from a
Pi needs hardware timing, and there are exactly three ways to get it: PWM0 on
GPIO18, PCM on GPIO21, or SPI0 MOSI on GPIO10. **GPIO18 and GPIO21 are the I2S
clock and data lines for the DAC.** So an addressable LED on this board would
have to go through SPI, which means it shares a peripheral with anything added
later and it breaks if the SPI clock divisor moves.

Three GPIOs and three resistors have no timing requirement, no level shifter, no
peripheral to contend for, and no driver. For an indicator behind a light pipe
that is the right trade.

The cost: green and blue have a forward voltage around 3.0 V against a 3.3 V
rail, so 100 Ω gives roughly 3 mA rather than the 15 mA a 5 V part would.
Adequate behind a diffuser, dim in daylight. If that turns out to be wrong, the
fix is a common-anode part on +5 V with a level shifter, and it is a resistor
network change, not a re-layout.

The five states the provisioning design requires — provisioning / connecting /
online-unbound / online-bound / error — fit comfortably in colour plus blink
pattern.

### 4.4 Provisioning button

Momentary to ground on GPIO16, with a 10k external pull-up, a 100 nF debounce
cap, and a 1k series resistor.

- **External pull-up** rather than the internal one, because the internal pull
  is a software setting and this button has to work during the states where
  software is the thing that is broken.
- **1k series** so a GPIO16 accidentally configured as an output driving high
  into a pressed button does not become a short.
- Long press only, per the provisioning design: "a long press, never a short
  one, so a box in a gym bag cannot factory-reset itself."

It is deliberately **not** wired to `GLOBAL_EN`. A hardware reset line on a
user-reachable button is a corrupted filesystem waiting for an impatient
person. `GLOBAL_EN` gets a test point.

### 4.5 Secure element

ATECC608B on I2C1, address 0x60. The provisioning design flagged this as
"optional for v1, but only addable at board design time" — which is the whole
argument for fitting it now. It is about a dollar.

Without it, the per-unit device secret is a file on eMMC that anyone with the
board can read, and the provisioning design says so in plain terms.

**The CM4 has no I2C pull-ups on the module.** A Pi 4B has 1.8k pull-ups on
GPIO2/3 on the main board, and it is easy to assume that carries over. It does
not. `R40`/`R41` are 4.7k on the carrier, and without them I2C simply does not
work.

### 4.6 USB, and the part that is not optional

**`J4` and `JP1` are how the board gets an operating system.** A CM4 with eMMC
is flashed with `rpiboot`, which requires the module's `USB_OTG` pair on a USB
device connector and `nRPIBOOT` held low. Leave either off and the only way to
program the board is to unsolder the module.

Two details:

- **`J4`'s VBUS is not connected to anything.** The board is powered from `J3`.
  Tying the two 5 V rails together back-feeds the flashing host. Flashing means
  plugging in both cables, and that needs to be written on the jig, because it
  looks like a fault the first time.
- **`JP1` ships unfitted.** Fitted means "boot from USB," which is a bricked
  box in the field.

`J5` is a USB-A host port off `USB2_DP/DM`, behind an AP2553 current-limited
switch with 150 µF downstream. It exists for one reason: the USB Bluetooth
dongle in `docs/spec.md` §2's parts list, if the shared antenna turns out to
matter. Note that the CM4's USB 2.0 host is **disabled by default** and needs
`dtoverlay=dwc2,dr_mode=host` in `config.txt` — another silent one.

### 4.7 Thermal

A footprint for a 2-pin 5 V fan header, **not populated**, no PWM control.

The Pi 4 spec asked for a ventilated case. A CM4 running BlueZ and one Python
process is nowhere near thermal throttling; the load is a radio, not a CPU. The
header is insurance that costs a footprint. If a sealed case does turn out to
cook, a fan running flat out is an acceptable answer for a locker room, which is
not a quiet place.

### 4.8 Silkscreen — the serial is functional

Reserve a silkscreen area for the unit serial and its QR. This is not cosmetic;
three separate things in the product read it:

1. **The QR binding path.** `auxgoat.com/d/A7F3K2` — provisioning design,
   §"Binding, via the QR". A sticker inside a sealed case is not a sticker.
2. **The SoftAP SSID**, `AuxGoat-A7F3K2`, so someone holding two boxes can tell
   them apart during setup.
3. **The Bluetooth name.** STATE.md's open list: "every speaker called `AuxGoat`
   collides in a Bluetooth list, and a phone paired to one will auto-connect to
   another. `AuxGoat 4F2C` or `AuxGoat — Crusaders`." **The serial on this board
   is the answer to that.** Same decision as the QR sticker, which STATE.md
   already said to decide together — so decide it as: the serial is the suffix,
   everywhere.

Note that the Bluetooth name comes from the systemd pretty hostname and nothing
else (STATE.md, verified on hardware 2026-08-09) — so "the serial is the
suffix" means `provision.sh` sets `hostnamectl set-hostname --pretty "AuxGoat
$SERIAL"`.

---

## 5. What has to change in `pi/` before a board boots

None of this is optional and all of it is small. Listed so it is not discovered
during bring-up.

| Change | Where | Detail |
|---|---|---|
| Enable the DAC | `/boot/firmware/config.txt` | Add `dtoverlay=hifiberry-dac`. **Remove `dtparam=audio=on`** — the internal audio device otherwise stays card 0 and `bluealsa-aplay` plays into nothing. |
| Enable the external antenna | `/boot/firmware/config.txt` | `dtparam=ant2` |
| Enable the USB host port | `/boot/firmware/config.txt` | `dtoverlay=dwc2,dr_mode=host` |
| Detect the hardware | `pi/scripts/provision.sh` | It currently hardcodes `dtparam=audio=on` and the headphone jack. It needs to branch on carrier vs Pi 4B rather than being edited by hand, because both will exist for a while. |
| Serial-suffixed name | `pi/scripts/provision.sh` | `hostnamectl set-hostname --pretty "AuxGoat $SERIAL"`, and `speaker_name` in `config.toml` must match it — STATE.md documents these as "three separate settings that only look like one." |
| LED and button service | new, `pi/lockerroom/` | Nothing in `pi/` touches GPIO today. Five LED states and a long-press handler. Follow `test_netwatch.py`: pure, testable with no hardware. |

**The audio one is the one that will bite.** `bluealsa-aplay` plays to the
default ALSA card and has no idea which device that is; if both the internal
audio and the DAC are enabled, card ordering decides whether the box makes
sound, and card ordering is not stable. Remove `dtparam=audio=on`, do not just
add the overlay.

---

## 6. Layout notes

Not decided yet, but constrained:

- **4 layers, SIG / GND / PWR / SIG.** The 0.4 mm pitch DF40 connectors need an
  inner layer to escape into, and the audio section needs an unbroken ground
  under it. Two layers is not worth attempting.
- **The CM4 footprint, keepout and mounting-hole pattern come from the official
  Raspberry Pi mechanical drawing.** Do not scale them off a picture.
- **`USB_OTG` and `USB2` are 90 Ω differential pairs**, length matched, over
  continuous ground. They are the only high-speed nets on the board, which is
  most of the reason for leaving PCIe and Ethernet off.
- **Analog ground is the same copper as digital ground**, joined under the DAC,
  with the audio section placed away from the module's switchers and the antenna
  feed. A split plane here causes more problems than it solves.
- Bulk capacitance sits at the CM4's 5 V pins, not at the connector.
- The 3.5mm jack, the USB-C power input, the button and the LED all reach the
  case wall, so their positions are a mechanical decision made with the
  enclosure, not after it.

---

## 7. Bring-up order

Matching the spirit of `docs/spec.md` §10 — each step is verifiable alone, and
you do not skip ahead.

1. **Power only.** No module fitted. Confirm 5 V at every CM4 pad, 3.3 V out of
   `U3`, no smoke, correct current limit on the polyfuse.
2. **Module fitted, `rpiboot`.** `JP1` in, both USB cables, and the eMMC
   enumerates as a mass storage device. If this fails nothing else can happen,
   which is why it is second.
3. **Boot to a shell.** Serial console or SSH over the USB host port.
4. **Audio.** `speaker-test -c2`, then a phone over Bluetooth into the real
   speaker. This is `docs/spec.md` §4.3's verification, re-run on new hardware.
5. **Radios.** Confirm `dtparam=ant2` took, and check range against the current
   Pi 4 box in the same room. That comparison is the only real evidence about
   the shared-antenna question.
6. **LED, button, secure element.** `i2cdetect` should show 0x60.
7. **The whole product.** `pi/scripts/deploy.sh` unchanged, a real phone, a real
   play landing in D1.

---

## 8. Open decisions

Carried forward from the provisioning design, still open, and each one changes
work:

1. **Is the SoftAP open or password-protected?** Unchanged from the provisioning
   design. Does not affect this board.
2. **Where does the device registry live?** Does not affect this board, but it
   is what decides whether the secure element's key is ever actually checked.
3. **Who does manufacture-time provisioning?** The jig needs to write a serial
   and a secret, flash eMMC over `J4`, and print the silkscreen serial to match.
   **The jig is a real piece of tooling and it is on the critical path for the
   second board, not the tenth.**
4. **Should `U4`'s enable be a GPIO instead of tied high?** It would let software
   power-cycle a wedged USB dongle. One GPIO, no cost, and it only matters in a
   world where the dongle is fitted. Cheap to add now, impossible later.
5. **Case, and the aux cable retention.** §4.2 — this is a product-defining
   detail masquerading as a mechanical one.
