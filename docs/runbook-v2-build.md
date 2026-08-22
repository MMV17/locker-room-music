# Runbook — building the v2 AuxGoat box

Written 2026-08-19, for: **Pi 4B + SanDisk High Endurance 64GB + Argon ONE V2 +
CP2102 serial adapter**, running **Raspberry Pi OS Trixie (Debian 13) 64-bit**.

Do this at a desk, on home wifi, with the Pi in your hands. Do not do any of it
on campus — the filter blocks things this procedure needs, and every stage here
is easier to fix while you can see the box.

**The order is not arbitrary.** Three stages exist only to catch a specific
failure while it is still cheap: stage 1 proves the board and card before any
metal is in the way, stage 4 proves the box survives a power cut before it is
somewhere you cannot reach, and stage 5 proves the case has not cost you the
radio the product depends on. Do not skip them because the box "seems fine."

Tick these off as you go:

- [x] 1. Boot bare, baseline the radio — **done 2026-08-19**
- [x] 2. Assemble the Argon case — **done**, jumper moved to 2-3
- [x] 3. `argon1.sh`, fan and button — **done**, all five checks pass on Trixie
- [x] 4. Always-On mode + pull the plug — **PASSED, booted itself**
- [x] 5. Range test, cased vs bare — **PASSED, no measurable loss**
- [x] 6. Serial console — **WORKING 2026-08-19**: wires were swapped, and
      `stty`+`cat` mis-bauds on macOS. Use `sudo cu`.
- [x] 7. `provision.sh` — **done 2026-08-19**, box advertises as `AuxGoat 0001`
- [x] 8. Wifi, `device_key`, `deploy.sh` — **done 2026-08-19**, beaconing to production
  ← **resume here: stage 9**
- [ ] 9. End to end: a phone, a song, a row in D1
- [ ] 10. Into the room

**Box as built:** hostname `auxgoat`, `192.168.1.178` on the home LAN (reachable
as `pi@auxgoat`; **`auxgoat.local` does not resolve** — use the bare name or the
IP). wlan0 `98:fe:54:34:14:12`, Bluetooth `98:fe:54:34:14:13`. Advertises to
phones as **`AuxGoat 0001`** — see stage 7 for why it is numbered.

---

## Stage 0 — the card (done)

You flashed it already. Two things to confirm in Imager's settings before first
boot, because both are painful to fix later:

- **Set the hostname to `auxgoat`, not `raspberrypi`.** ROVER also answers to
  `raspberrypi.local` on mDNS, and STATE.md records a session lost to exactly
  that confusion. `auxgoat.local` is unambiguous. This is the *static* hostname
  and is separate from the pretty hostname phones see — `provision.sh` sets that
  to `AuxGoat` later.
- **SSH enabled, key or password set, and your home wifi configured.** Stage 1
  needs to reach the box.

If you already flashed without setting the hostname, don't reflash — fix it in
stage 1 with `sudo hostnamectl set-hostname auxgoat`.

---

## Stage 1 — boot bare, and baseline the radio

**Case still in the box. SD card in the Pi, nothing else attached but power and
(optionally) ethernet.**

Two reasons this stage exists:

1. **It proves the board and the card before any metal is in the way.** If this
   Pi has the same one-flicker fault as the last one, you want to know now, not
   after assembling a case around it.
2. **It is your only chance to measure the radio without the case.** Stage 5
   compares against these numbers. Once the case is on, there is nothing to
   compare to.

```bash
ssh pi@auxgoat

# Prove it is the right box and a healthy boot
uptime
cat /etc/os-release | head -2        # expect Debian 13 (trixie)
vcgencmd get_throttled               # expect throttled=0x0
```

**Now the baseline. Write these numbers down — put them in this file.**

```bash
# Wifi signal, in dBm. Do this standing in ONE spot you can return to.
iw dev wlan0 link | grep -i signal

# CPU temp with no case and no fan
vcgencmd measure_temp

# Bluetooth adapter is present and sane
hciconfig -a | head -20

# A stock image can come up with Bluetooth SOFT-BLOCKED. Hit on this box
# 2026-08-19. Every service stays green and no phone can see the speaker.
rfkill list
sudo rfkill unblock bluetooth      # if hci0 shows "Soft blocked: yes"
```

**Also take a Bluetooth baseline, not just a wifi one.** The wifi dBm is a
proxy; Bluetooth RSSI is the actual radio this product lives on, and once the
case is on there is nothing to compare against. You do not need the audio stack
for this — plain BlueZ will do it before `provision.sh` has ever run.

Put the phone **a measured distance away** (10 ft is fine — write down whatever
you use) and leave it sitting on its Bluetooth settings screen so it advertises.

**Use `btmgmt find`, not `bluetoothctl scan`.** Learned the hard way on
2026-08-19: `bluetoothctl`'s scan output interleaves every device in range, and
the RSSI lines it prints are easy to read off against the wrong MAC. `btmgmt`
gives one line per device with the address and rssi together.

```bash
sudo btmgmt find | grep -i <phone-BR/EDR-address>
# dev_found: 5C:AD:BA:F0:B2:61 type BR/EDR rssi -58 flags 0x0000
```

Run it two or three times and take the typical value — RSSI bounces a few dB on
its own, so a single reading is not a measurement.

**Match on the classic BR/EDR address, which on iOS is stable.** Mack's iPhone
is `5C:AD:BA:F0:B2:61` — identifiable because it advertises the classic profile
UUIDs (`110a` Audio Source, `110c` AVRCP Target, `111f` Handsfree AG). The
`E1:..`/`D8:..`-style random addresses in the same scan are BLE advertisements
from other devices — **and possibly from the same phone**, since an iPhone has
a rotating BLE identity separate from its classic address. Do not read RSSI off
those; you cannot tell whose they are.

If `bluetoothctl scan on` is already running, `scan off` and exit first — two
discoveries at once collide.

Repeat this exact setup, same spot and same distance, in stage 5. **That number
is the go/no-go on the case**, more than the wifi one is.

| measurement | bare (stage 1) | cased (stage 5) |
|---|---|---|
| wifi signal, same spot | **-66 dBm** (2026-08-19, home wifi) | **-61 dBm** — 5 dB *better* |
| idle CPU temp | **41.3 °C** | **35.5 °C** — case is 5.8 °C *cooler* |
| BT RSSI, `5C:AD:BA:F0:B2:61` at 10 ft | **-67.5 dBm mean, n=8** | **-68.7 dBm mean, n=10** → **no loss** |
| BT audio drops out at | ______ ft | ______ ft |

**-66 dBm bare leaves less headroom than it looks.** Rough bands: -50 excellent,
-60 good, -70 marginal, -80 unusable. Starting at -66 means a case that costs
the ~10 dB the M.2 version was measured losing puts this box at -76, which is
where links stop holding rather than just slowing down. It does not mean the
case will fail — the plain V2 has no M.2 board and should be milder — but it
does mean **there is no room to shrug off a bad stage 5 result.**

Note this reading was taken on home wifi at an unrecorded distance from the
router, so it is a *relative* baseline only. That is fine: stage 5 compares the
same box in the same spot, which is the only comparison that matters here.

### The Bluetooth baseline, and the noise floor that goes with it

Eight readings of `5C:AD:BA:F0:B2:61` at 10 ft, bare, 2026-08-19:

```
-70  -70  -69  -69  -69  -66  -64  -63
```

| | |
|---|---|
| mean | **-67.5 dBm** |
| median | -69 dBm |
| std dev | 2.6 dB |
| range | 7 dB (-63 strongest, -70 weakest) |

**The spread is the useful half of this.** A single reading swings 7 dB on a
box that is not moving, so any stage-5 comparison has to clear that band before
it means anything:

| cased vs bare | reading |
|---|---|
| **< 5 dB drop** | noise. Ignore it. |
| **5–8 dB drop** | ambiguous. Take another 8 samples before deciding. |
| **> 8 dB drop** (~3σ) | real. The case is costing you range. |

Take **at least 8 samples cased**, same phone, same spot, same 10 ft — a
like-for-like mean, not one reading against a mean.

And remember this is inquiry RSSI, which is systematically pessimistic versus a
live connected A2DP link. It is a good comparator and a poor predictor: **the
walk test with real audio in stage 9 is what actually settles whether the room
is covered.**

Then power down cleanly: `sudo shutdown -h now`, wait for the green LED to stop,
pull power.

---

## Stage 2 — assemble the Argon case

**Yes, the case goes on BEFORE you run the Argon script.** The script talks to
an MCU that lives on the case's fan board. With no case attached there is no
MCU: `i2cdetect` finds nothing, the fan does not exist, and the button does not
exist. The script would install cleanly and you would be able to verify none of
it.

**Power disconnected. Take the SD card OUT before assembling** — it sticks out
of the slot and the case will bend or snap it.

1. Remove any heatsinks already stuck to the Pi. The case *is* the heatsink and
   needs flat contact.
2. Lay the Pi into the bottom plate, ports lined up with the openings.
3. **Seat the daughterboard onto the Pi.** It plugs onto *both* micro-HDMI ports
   and the 3.5mm jack at once. Push it fully home and level — this is the single
   most commonly half-done step, and on this build it carries **the audio**, not
   just video. A partly-seated board means no aux.
4. Peel the plastic off **both sides** of the thermal pads and place them on the
   SoC and RAM.
5. Mate the GPIO header to the fan board on the case top, and press down evenly.
6. **Move the Always-On jumper from 1-2 to 2-3** on the Argon board's 3-pin
   header. See stage 4 for what it does, and for why it is emphatically *not*
   the Pi's GPIO pins 2 and 3. Much easier to reach now than after closing up.
7. Screw the assembly to the top case, then close the bottom plate.
8. **Put the SD card back in.**

Boot it. Confirm you can still SSH in, and that nothing got knocked loose:

```bash
ssh pi@auxgoat
vcgencmd measure_temp
```

The fan will not spin yet. That is expected — nothing is driving it until
stage 3.

---

## Stage 3 — the Argon script

**Home wifi, not campus.** The script fetches from `download.argon40.com` and
checks the time against `worldtimeapi.org` over plain HTTP — the campus filter
will mangle at least one of those.

```bash
curl https://download.argon40.com/argon1.sh | bash
```

It takes a while, because it also runs `apt-get update && apt-get upgrade -y`
and `rpi-eeprom-update`. **This is exactly why it runs before `provision.sh`** —
a full distro upgrade on top of a working listener is how you turn a build into
a debugging session.

Then reboot: `sudo reboot`.

### Verify all three things, individually

```bash
# 1. The MCU is visible. Expect "1a" in the grid.
sudo i2cdetect -y 1
#    If bus 1 is empty, try bus 0 before assuming the board is bad:
sudo i2cdetect -y 0

# 2. The fan daemon is running
systemctl status argononed.service

# 3. Drive the fan by hand — you should HEAR this
sudo i2cset -y 1 0x1a 0x64      # 100%
sudo i2cset -y 1 0x1a 0x00      # off
```

The fan only starts turning at about 10% duty, so a low value proves nothing —
use 100% for the test.

**4. The button.** Short press does nothing while running; **double-tap
reboots**; hold 3s does a clean shutdown. Test the double-tap now.

`argon-config` is installed at `/usr/bin/argon-config` if you want to change the
fan curve. Defaults are 55°C→10%, 60°C→55%, 65°C→100%, which are fine.

### Result: PASSED on Trixie, 2026-08-19

The script ran clean on **Raspberry Pi OS Trixie (Debian 13) 64-bit**. The older
forum reports of it failing on Trixie are stale — the `libgpiod` default is the
fix. Recorded here so nobody re-opens the Bookworm question on the strength of
those posts.

| check | result |
|---|---|
| `i2cdetect -y 1` | `1a` present on **bus 1** (not bus 0) |
| `argononed.service` | active (running), enabled, `/etc/argon/argononed.py` |
| `enable_uart` in `config.txt` | `enable_uart=1` — set by the script, as expected |
| `rfkill list bluetooth` | `Soft blocked: no` — **the unblock persisted across reboot** |
| idle temp, cased | **35.5 °C**, against 41.3 °C bare |

**The case runs 5.8 °C cooler than the bare board at idle.** That is also the
best evidence you get that the thermal pads and the daughterboard actually
seated properly — a badly assembled case runs *hotter*, not cooler.

### If the script fails on Trixie

Some older reports say it does. The current version uses `libgpiod`, which is
the correct modern path, so it probably will not — but if the fan will not run,
**do not switch to Bookworm to fix it.** Bookworm drops BlueZ from 5.82 to 5.66
underneath code that was debugged against 5.82, and re-opening the AVRCP work is
far worse than a manual fan. The fallback is a small cron/systemd loop that
reads `vcgencmd measure_temp` and writes a duty cycle with `i2cset`. The button
and Always-On are MCU features and work regardless of the script.

---

## Stage 4 — Always-On, and prove it

**The most important stage on this page.**

Default Argon behaviour: **power comes back after an outage and the Pi stays
off** until somebody presses the button. In a locker room, behind a filter, with
no SSH, that is a silent end of season — and nothing in this project can detect
it, because nothing is running.

```bash
sudo i2cset -y 1 0x01a 0xfe     # Mode 2, "Always ON"
```

(`0xfd` is Mode 1, the default. **Never send `0xff`** — that tells the MCU to
watch UART TX voltage and cut power when it drops, and you are about to attach a
serial console to exactly that pin.)

**The i2c write on its own is reported not to stick.** Multiple people on
Argon's own forum set Mode 2 and still had to press the button; Argon's answer
was that **an internal jumper also has to be moved.** Do both.

### The jumper — move it during assembly (stage 2), not here

**3-pin header on the Argon's own board. NOT the Pi's 40-pin GPIO header.** On
the Pi's header pin 2 is **5V** and pin 3 is **GPIO2/SDA** — bridging those
feeds 5V into a 3.3V input and shorts an i2c line. Different header entirely.

| jumper | after a power cut |
|---|---|
| **1-2** (factory default) | stays **off** until the button is pressed |
| **2-3** | **Always ON** — boots by itself |

Move it to **2-3**. It is easiest to reach while the case is open, so do it in
stage 2 rather than coming back for it.

**The fan will run at 100% from the moment the jumper is on 2-3 until
`argon1.sh` is installed.** Normal — the MCU has no temperature source and
defaults to full. It quiets down once `argononed` is driving it. Do not
troubleshoot it in between.

### Now actually test it

Nothing else in this runbook substitutes for this.

1. Boot the Pi, confirm you can SSH in.
2. **Pull the plug from the wall.** Not a soft shutdown — simulate an outage.
3. Wait ten seconds.
4. Plug it back in, and **do not touch the button.**
5. It should boot on its own. Confirm with `ssh pi@auxgoat`.

If it does not come back by itself, stop and fix it here. Do not carry on and
plan to sort it out later — later is in a locker room.

### Result: PASSED, 2026-08-19

Jumper on **2-3** plus `i2cset -y 1 0x01a 0xfe`. Plug pulled from the wall on a
running system, ten seconds, plugged back in, **button untouched — it booted by
itself.** Both halves were applied together, so which one is load-bearing is
untested and does not matter; do both on any future box.

**One thing this exposed, and it wasted a few minutes:** after the reboot the
box came back but **`auxgoat.local` stopped resolving**, so `ssh` and `ping`
both failed and it looked like the Pi had not booted. It had. The Pi's own LEDs
are inside the aluminium and not visible, so the only light you can see says
nothing about whether the Pi is running.

**Go by MAC, not by name, when a box looks dead:**

```bash
arp -a | grep -i 98:fe:54
# auxgoat (192.168.1.178) at 98:fe:54:34:14:12 on en0 ifscope [ethernet]
ssh pi@192.168.1.178
```

If the MAC appears in `arp`, the box booted and joined the network, and you have
a name-resolution problem rather than a hardware problem. That distinction is
the whole ballgame — the 2026-08-12 session was lost to inferring machine state
from a light.

---

## Stage 5 — the range test, cased vs bare

**This is a go/no-go on the case itself, and the reason to take it seriously is
specific to this product.**

Aluminium plus the ground planes on the case's boards makes a partial Faraday
cage around a Pi whose antenna is etched into the PCB right next to the micro-SD
slot. On the M.2 version of this case it was bad enough to be measured: early
boards could not hold a 2.4GHz link 3.7m from an access point. Yours is the
plain V2 and should be milder — but the mechanism is the same.

Every other write-up of this problem ends "just use 5GHz." **You cannot.
Bluetooth is 2.4GHz exclusively**, and holding an A2DP link to phones across a
room is the entire job.

```bash
# Same spot as stage 1. Compare against the number you wrote down.
iw dev wlan0 link | grep -i signal
```

A few dB of loss is normal and fine. **Ten or more, or a link that will not hold,
is the case failing the test.**

Then the one that actually matters — you need a phone and a room:

1. Pair a phone and play music (you can do this properly after stage 8; for now
   pair to the bare adapter and play anything).
2. Walk away until it stutters or drops. Note the distance.
3. If it is materially worse than the room you need to cover, **the case loses.**
   It is a cooling and tidiness upgrade; the product is the radio.

If the case does cost you range, options in order: reposition the box so the
SD-card edge faces the room, leave the magnetic top cover off, or fall back to a
plastic case with a fan. Don't spend a season fighting it.

### Result: PASSED — the Argon ONE V2 costs no measurable Bluetooth range

Measured 2026-08-19, same phone, same 10 ft, same method.

```
bare   (n=8)   -70 -66 -69 -63 -69 -69 -64 -70
cased  (n=10)  -71 -61 -82 -64 -68 -67 -66 -66 -71 -71
```

| | bare | cased |
|---|---|---|
| mean | -67.5 | **-68.7** |
| median | -69.0 | **-67.5** |
| std dev | 2.6 | 5.4 |
| strongest reading | -63 | **-61** |

- **Δ mean = -1.2 dB.** Threshold for "real" was 8 dB. This is a fifth of the
  bare noise band.
- **Δ median = +1.5 dB** — by that measure the cased box reads *better*.
- Drop the single `-82` outlier and Δ mean is **+0.3 dB**, i.e. identical.

**The most convincing number is the strongest reading: -61 cased against -63
bare.** Attenuation lowers the ceiling. A Faraday cage cannot produce a
best-case reading *better* than the unshielded box — so whatever the -82 was, it
was not the case blocking signal.

**Wifi corroborates independently: -61 dBm cased against -66 bare, also 5 dB
better.** Two separate radios, same answer, neither showing loss.

**Verdict: keep the case.** The 2.4GHz concern raised from the M.2 measurements
does not reproduce on the plain V2, which makes sense — the M.2 fault was copper
ground pours on the *M.2 board* sitting under the Pi, and this case has no such
board.

**On the wider spread** (σ 5.4 vs 2.6, one reading at -82): worth noting, not
worth chasing. Likeliest causes are the phone's screen dimming mid-run — it
stops advertising in classic when it sleeps — or transient 2.4GHz interference.
If dropouts ever show up in real use, come back to this and re-measure with the
phone held awake, before blaming the case.

---

## Stage 6 — the serial console, while everything works

Wire and test this **now**, on the desk, with a healthy box. The whole
2026-08-12 session went into inferring machine state from one blinking LED.
Discovering a wiring mistake during the next outage is precisely the failure this
prevents.

`enable_uart=1` is already set — the Argon script did it in stage 3. Confirm:

```bash
grep enable_uart /boot/firmware/config.txt
```

**Pi powered off. Adapter unplugged.** Lift the magnetic top cover to reach the
header.

**Verified working on the air 2026-08-19. This is the crossed wiring, and it
is correct — do not invert it.**

| adapter label | Pi physical pin | what the pin is |
|---|---|---|
| GND | **6** | ground |
| **TXD** | **10** | GPIO15 / Pi's **RXD** |
| **RXD** | **8** | GPIO14 / Pi's **TXD** |

- TX and RX are **crossed**, which is correct and is what the labels above
  already describe: the adapter's transmit goes to the Pi's receive. If you are
  reading this after a silent console, swapping them is still the cheap thing to
  try — cheap CP2102 boards do vary — but **this exact pairing is the one that
  was proven to work on this kit**, so put it back afterwards.
- **Leave VCC/5V disconnected.** The Pi has its own supply; connecting both
  backfeeds power and is a good way to make a second dead Pi.
- Set the adapter to **3.3V** if it has a jumper.
- Pin 8 is also the Argon's power-cut monitor. Harmless — both are passive
  listeners on a line the Pi drives — **as long as you never sent `0xff`.**

On the Mac:

```bash
ls /dev/cu.usbserial-*
screen /dev/cu.usbserial-XXXX 115200     # exit with Ctrl-A then K
```

Power-cycle the Pi and watch a full boot go past: firmware, kernel, systemd. If
you see that, you have a console that works when the network does not.

Nothing shows up? `ls` empty means the adapter did not enumerate (bad cable or a
counterfeit chip — return it). Garbage characters mean a baud mismatch. Silence
with a good device is usually TX/RX not crossed.

### RESOLVED, 2026-08-19 — the fault was on the Mac, not the Pi

**It works.** Clean text both ways at 115200, em dash and all — no framing
errors. Everything previously listed as "confirmed working, do not re-check"
was correct the whole time and stayed correct; re-verified after the distro
upgrade. `serial-getty@ttyS0` is `active`, so **the Pi transmits a login prompt
continuously and you never need to reboot to test this.**

**The wiring was right all along.** The console ended up on exactly the pairing
the table above always specified — adapter TXD to pin 10, RXD to pin 8. The
wires were pulled and re-seated during debugging, so whether one was ever
genuinely wrong cannot be established and is not worth claiming. What is
certain is that the box now works on the documented wiring.

**The real fault: `stty -f` does not survive on macOS.** It opens the port,
applies the baud, and CLOSES it — and closing resets the line discipline, so
the `cat` that follows opens a fresh port at the default 9600. Wiring perfect,
output `??????.???`. Every previous attempt at this stage used `stty` then
`cat`, which means **this stage may never have had a hardware problem at all.**

The lesson is about the tool, not the box: **a read-only `cat` cannot test a
console.** It cannot send a newline, so it cannot make a getty print a prompt,
and it silently reads at the wrong speed. Reach for `sudo cu` first.

**The tell is the character count, and it is worth knowing.** 8 lines of ~33
characters were sent and about 10 arrived. Reading far slower than the sender
loses most of the bytes and renders the rest unprintable. **Garbage that is
also far too SHORT means baud, not wiring** — proportional garbage would mean
wiring or noise. That distinction sends you to the right half of the problem.

**So the working macOS recipe is one process that opens the port and sets the
baud itself. Never `stty` then `cat`:**

```bash
sudo cu -l /dev/cu.usbserial-0001 -s 115200      # exit: ~.
```

**`sudo` is required** and this was not previously written down. `cu` needs a
lock file in `/var/spool/uucp`, which is `_uucp:wheel drwxr-xr-x` and not
writable by uid 501. Without it you get a *"Permission denied"* on the lock
followed by a misleading **`Line in use`** — which is `cu` assuming a holder
after its lock failed, NOT a real second reader. Check with
`lsof /dev/cu.usbserial-0001` before believing it.

`brew install picocom` avoids the lock-file business entirely:
`picocom -b 115200 /dev/cu.usbserial-0001` (exit Ctrl-A Ctrl-X).

**Three dead ends on the Mac side, none on the Pi.** `screen` fails with "could
not find a PTY", `stty`+`cat` silently mis-bauds, and `cu` needs root. On a
console whose entire purpose is working when nothing else does, that is worth
the space it takes here.

**One note on `serial-getty@ttyS0`:** it reports `enabled-runtime`, not
`enabled`. That is correct and not fragile — systemd's getty generator recreates
it every boot from `console=serial0,115200` in `cmdline.txt`. Do not "fix" it by
enabling it persistently.

---

## Stage 7 — provision.sh

Now, and not before, turn a blank Pi into a speaker.

```bash
scp pi/scripts/provision.sh pi/scripts/keep-discoverable.sh pi@auxgoat:
ssh pi@auxgoat 'sudo SPEAKER_NAME="AuxGoat 0001" bash provision.sh'
```

**Pass `SPEAKER_NAME` or you get the bare default `AuxGoat`.** It sets two
things at once: the pretty hostname phones see, and `speaker_name` in
`config.toml`, which is the `heartbeats` PRIMARY KEY server-side. Re-running
this script without the variable renames the box back.

It installs bluez, bluez-alsa-utils, bluez-tools, alsa-utils and the python
venv, sets the Bluetooth class to `0x200414` so phones show it as a speaker,
sets the pretty hostname to `AuxGoat`, **asserts the audio output**, makes
journald volatile, asserts `noatime`, and writes a config template.

**Watch the `== audio out ==` section.** It is new as of 2026-08-21 and it is
the difference between a box that makes a sound and one that does not — see
"A fresh provision came up silent" in `docs/STATE.md`. If it prints
`added dtparam=audio=on ... NEEDS A REBOOT`, the analog jack did not exist as
an ALSA card until now, and **there will be no audio until the box reboots**;
the script says so again at the end. That reboot is the one stage 8 already
asks for, so it costs nothing extra — but skipping it and then testing audio
will send you looking for a half-seated daughterboard that is seated fine.

**Then watch `== audio out: verify ==`, which is the one that actually
matters.** New 2026-08-22. Everything above it writes configuration; this is
the only line that *tests* the result. You want:

```
   VERIFIED: the default opened card 2 ("Headphones") and ran
```

It plays `/dev/zero` — silence — so it is safe to run with people in the room,
and it checks **which** card started, not just that something opened. If it
prints an error instead, the script says `THE AUDIO OUTPUT DID NOT VERIFY` at
the very end and **the box will be silent no matter how green everything else
looks**. Do not ship it. This is the check that would have saved the whole
2026-08-21 → 22 hunt; see "CONFIRMED (2026-08-22)" in `docs/STATE.md`.

It deliberately does **not** do wifi or `device_key`. Both need a human, and
both are stage 8.

Expected in the output: `noatime already set on /`. That is a pass, not a
failure — Raspberry Pi OS ships it, and the check is there to catch an image
that does not.

### Result: PASSED, 2026-08-19 — but it needed one fix

Both documented passes appeared: `bluetooth not soft-blocked` and `noatime
already set on /`. `dbus-fast` installed from a prebuilt aarch64 wheel rather
than falling back to a source build, which is the slow failure the package list
in the script exists to avoid.

| check | result |
|---|---|
| pretty hostname | `AuxGoat 0001` |
| advertised BlueZ name | `AuxGoat 0001` **after a bluetooth restart** — see below |
| device class | `0x6c0414` — low half `0x0414` is Audio/Video + Loudspeaker, as asked |
| `keep-discoverable.sh` | installed `0755` to `/usr/local/bin` |
| `config.toml` | written `0600`, `device_key` still `REPLACE_ME` |
| journald | `Storage=volatile`, `/var/log/journal` removed |
| rfkill | `Soft blocked: no` |

**The bug this stage found: `provision.sh` ended with `systemctl start
bluetooth`, which does nothing when bluetoothd is already running.** Everything
landed correctly on disk — pretty hostname, `Class = 0x200414` in `main.conf` —
and the adapter went on advertising `auxgoat` with a generic class, because
nothing reloaded it. `docs/spec.md` has said since phase 1 that this is not
picked up live. **Fixed in the script (`restart`, not `start`).** On a truly
blank image the bug is invisible, which is why it survived this long.

**Two things that look wrong here and are not:**

- **`Discoverable: no`.** `DiscoverableTimeout = 0` means "never expire", not
  "turn on". `keep-discoverable.sh` does the turning on, and its systemd unit
  arrives with `deploy.sh` in stage 8.
- **The class is not literally `0x200414`.** BlueZ recomputes the upper
  *service*-class bits from the SDP profiles actually registered and only takes
  the device-class half from `main.conf`. Expect it to change again once
  `bluealsa` registers the A2DP sink. The half phones draw an icon from is
  correct.

**On the name.** Numbered rather than bare `AuxGoat` because STATE.md's open
item said every box sharing one name collides in a Bluetooth list and a phone
paired to one will auto-connect to another. STATE.md wanted this decided
together with the QR sticker — but only the QR *hostname* is blocked on the
campus filter, and the *serial* is not. `0001` is the same serial a
`/d/<serial>` QR would carry whenever that hostname gets settled, so nothing is
foreclosed and nothing has been printed.

---

## Stage 8 — wifi, the key, and the code

**REBOOT FIRST, between stage 7 and this stage.** `provision.sh` installs
`bluez` and `bluez-alsa-utils`, which queue systemd unit restarts; `deploy.sh`
then restarts those same units. On 2026-08-19 that combination wedged systemd
(`Transaction for bt-agent.service/restart is destructive`) and **the hardware
watchdog reset the board mid-deploy** — `/dev/watchdog0` has a 1-minute
timeout and systemd stopped petting it. The deploy half-finished. A reboot in
between costs 40 seconds and avoids all of it.

```bash
sudo reboot
```

**You do NOT have to be on campus to set up HCGuest.** `nmcli device wifi
connect` needs to scan, but `nmcli connection add` creates the profile offline
and NetworkManager joins the moment it sees the SSID. Do it at the desk.

```bash
# Off-campus, ahead of time — the verified recipe from STATE.md.
sudo nmcli connection add type wifi con-name HCGuest ifname wlan0 ssid HCGuest \
  connection.autoconnect yes connection.autoconnect-priority 20 ipv4.method auto
sudo nmcli connection modify HCGuest wifi.cloned-mac-address permanent

# Priority 20 beats home wifi's 0, so it takes HCGuest at school and falls back
# to home otherwise. `permanent` stops NetworkManager randomising the MAC, which
# a guest network that meters per-MAC would see as a new device every time.

# Then put the real key in. Copy DEVICE_KEY from backend/.secrets.local on the
# laptop — it is NOT in git, and Cloudflare secrets are write-only, so that file
# is the only copy that exists.
sudo nano /etc/lockerroom/config.toml
```

Leave `api_base_url` at `https://lockerroom.finestkindfarms.com`. It has
survived both campus filter episodes untouched, which is more than
`hc.auxgoat.com` can say.

Then ship the code from the laptop:

```bash
pi/scripts/deploy.sh pi@auxgoat
```

That installs the systemd units, the `bluealsa-aplay` drop-in, and the listener.

### Result: PASSED, 2026-08-19 — after three fixes

All seven units `active` **and** `enabled`, beaconing 200 OK to production.

**Three things this stage found, all now fixed in the scripts:**

1. **`deploy.sh` never enabled `lockerroom-listener`.** It enabled netwatch,
   bt-agent and keep-discoverable but not the core service, which had only ever
   been enabled by hand on the first box — the *same* omission that had already
   bitten twice, this time on the thing that does the actual job. A box like
   that plays audio perfectly and **records nothing after the next power cut**,
   with every unit anyone thinks to check still green. Fixed in `deploy.sh`.
2. **The Trixie image has no passwordless sudo.** There is no
   `/etc/sudoers.d/010_pi-nopasswd`, so `deploy.sh` fails partway with
   *"a terminal is required to read the password"*. Note `010_global-tty`
   disables `tty_tickets`, which means one interactive `sudo` makes everything
   work for 15 minutes and then mysteriously stops — easy to misread as flaky
   SSH. Fix once, interactively:

       echo 'pi ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010_pi-nopasswd
       sudo chmod 0440 /etc/sudoers.d/010_pi-nopasswd && sudo visudo -c

3. **The watchdog reset described above.** Reboot between stages 7 and 8.

**Unattended reboot verified 2026-08-19, watched over the serial console.** All
of `lockerroom-listener`, `bt-agent`, `keep-discoverable`, `lockerroom-netwatch`,
`bluealsa`, `bluealsa-aplay` and `argononed` came back `active` with nobody
touching the box; the adapter returned as `AuxGoat 0001` and discoverable, the
paired phone reconnected on its own, and a beacon reached production within
seconds. **This is the test that catches the enable bug above** — run it on
every future box rather than trusting `systemctl is-enabled`.

**Also worth knowing:** `journald` is `Storage=volatile` as of stage 7, so when
the box rebooted mid-deploy **the previous boot's log was gone** and the cause
had to be inferred. The runbook says that cost is "covered by the serial
console" — it is not, because stage 6 is parked. That is the second time the
parked console has had a real cost.

---

## Stage 9 — end to end

```bash
ssh pi@auxgoat
systemctl status lockerroom-listener bluetooth bluealsa bluealsa-aplay bt-agent keep-discoverable
tail -f /var/log/lockerroom/listener.log
```

Then the real test, which no amount of green systemd output substitutes for:

1. **Pair a phone.** It should appear as **AuxGoat** and show as a speaker.
2. **Play a song.** Audio out of the 3.5mm jack on the *back of the case* —
   this is where a half-seated daughterboard shows up.

   **If everything else works and this does not, do NOT start pulling the case
   apart.** A silent jack with a paired phone, live AVRCP metadata and a green
   `systemctl` is almost never hardware — see "A fresh provision came up
   silent" in `docs/STATE.md`. Run the diagnostic first, and start with the
   tone, because it splits the problem in half:

   ```bash
   sudo audio-check.sh --tone
   ```

   Tone audible → the analog path and the daughterboard are fine, and the fault
   is in Bluetooth. Tone silent → Bluetooth is innocent; it is the ALSA default
   device, the mixer, or `dtparam=audio=on` not having survived a reboot, and
   the verdict at the bottom of the report says which. Re-running
   `provision.sh` fixes all three.

   The `--tone` output also prints `/proc/asound/cardN/pcm0p/sub0/status` while
   the tone is playing. **`state: RUNNING` there is the software/hardware
   split**: it means the kernel is genuinely clocking samples out of the SoC,
   so every layer this repo controls is working and a silent room is physical
   from the SoC pin onward.

   **The physical ladder, cheapest first. Do not skip to the screwdriver.**

   | # | Test | If it works |
   |---|---|---|
   | 1 | **Wired headphones in the case's rear jack**, run `--tone` | Pi, jack and daughterboard are all fine. The fault is the cable or the speaker — stop here and go to 4. |
   | 2 | **A monitor on the case's HDMI port** | The daughterboard is seated. It carries HDMI and the 3.5mm extension on one rigid PCB, so video out means it is mated. (A tilted board can in principle mate HDMI and not the jack — test 1 settles that directly, which is why it is first.) |
   | 3 | **The same 3.5mm cable from a phone** into the same speaker | The cable and the speaker are fine, and the fault is back at the Pi. 3.5mm cables fail constantly; suspect the cable before anything soldered. |
   | 4 | **Does the speaker even have an analog input?** | See "The speaker side" in `docs/STATE.md`. A JBL Charge 5 or 6 has **no aux jack at all** and no cable will change that. This is the likeliest answer if the speaker is new. |

   Only if 1 and 2 both fail is it worth opening the case, and then the thing
   to look at is the daughterboard sitting level on *both* micro-HDMI ports and
   the 3.5mm barrel — stage 2, step 3.
3. **Open the front door** at `https://auxgoat.mmvinton17.workers.dev` and type
   `CRUSADERS`. On campus use that hostname, not `auxgoat.com`.
4. **Confirm the play reaches D1** — it should show as now-playing on the site
   within a poll cycle.

Then the two things that have never been exercised by a human, per STATE.md:

- The **new aux screens on a real phone** — "Someone else has the aux" on the
  idle screen, and the waiting banner. Built and deployed 2026-08-09, verified
  only by e2e. Two phones and two minutes settles it.
- **A real session.** The reveal has never fired for anyone and no leaderboard
  has ever rendered from real votes. That is the actual remaining risk in this
  project, and it is bigger than everything above.

---

## Stage 10 — into the room

- Mount it so the **micro-SD edge faces the room**, not a wall or a metal locker.
  That is where the antenna is.
- Think about heat and damp. Nothing ever explained why the first board died, and
  "environment" is still the only untested theory. This case has a fan, which
  means it now actively pulls humid room air through the box — that changes the
  question rather than settling it.
- **Do not leave the ethernet cable plugged in** (see STATE.md — a dead cable
  poisoned `resolv.conf` and made netwatch misdiagnose a healthy wifi link).
- Consider a **pre-provisioned spare card on a shelf.** Turns a mid-season death
  into a swap instead of an evening.

---

## Sources

- Argon i2c codes and the GPIO pin table — <https://github.com/Argon40Tech/Argon-ONE-i2c-Codes>
- `argon1.sh` itself, read 2026-08-19 — <https://download.argon40.com/argon1.sh>
- Always-On not sticking without the jumper — <https://forum.argon40.com/t/not-able-to-set-my-argon-one-v2-to-mode-2-power-always-on/2126>
- 2.4GHz Faraday-cage measurements — <https://www.martinrowan.co.uk/2021/06/argon-one-m-2-ssd-case-wifi-issues-resolved/>
- Assembly guide — <https://wiki.argon40.com/en/AssemblyGuides/One_V2/V2Case>
