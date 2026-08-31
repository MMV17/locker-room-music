# Bluetooth relay output: one speaker interface that every speaker has

**Date:** 2026-08-31
**Status:** design, not approved for build. See "When NOT to build this."

## The problem

Every speaker takes a different wired input, and none of the wired paths is
dependable across all of them:

| Speaker | Wired input | State |
|---|---|---|
| Aux speakers | 3.5mm | **Works, free, reliable** |
| JBL Charge 6 | USB-C only | **Conditional** — needs one specific cable *and* a near-full battery |
| Bluetooth-only speakers | none | **Unsupported entirely** |

The USB result is the one that moved. See "USB to the Charge 6 works,
CONDITIONALLY" in `STATE.md`: charging current is invisible to USB, governed by
the cable's CC resistor, and Li-ion charging is a cliff rather than a slope — so
the same cable in the same port plays fine at full charge and dies in four
seconds at 90%. The battery will be draining during exactly the use it is
needed for.

**Every one of those speakers has Bluetooth.** That is the only input they all
share, and it is the only output that removes the cable, the CC resistor and
the charging current from the problem at once.

## What this is not

This does not replace the wired paths. `audio-route.sh` and the USB/jack
routing stay exactly as they are, deployed and working. The relay is a **third
output**, and the wired ones remain preferred when present.

## Prior art: rejected 2026-08-23, re-examined

`STATE.md` records a relay test marked **NO-GO**. That verdict was correct for
the decision in front of it — the cable was not on hand and buying one was
cheaper than building this. The constraint has since changed. Each of the three
stated reasons, re-read:

**1. Stuttering — "airtime, not tuning."** The write-up diagnoses it precisely:
wifi was on **channel 11 (2462 MHz) at -64 dBm, negotiated down to 5.5 Mbit/s**,
an 802.11b rate burning enormous airtime, on the same chip and antenna
Bluetooth hops through. The conclusion drawn was "no headroom." **The fix is to
move wifi off 2.4 GHz, and that was never tried.** Confirmed available from
where the Pi sits: `_owetm_HCGuest_557c01f0` on **5260 MHz (-82 dBm)** and
**5805 MHz (-78 dBm)**.

**2. The controller wedged** (`HCI_Reset` returning -110). The write-up is
explicitly honest that this is unproven: *"this is correlation in time... the
test did not separate them."* A documented 6-second recovery exists.

**3. The listener treats the far speaker as a DJ.** Called "the finding that
actually kills the idea," but the write-up itself names the fix: *"teach the
lifecycle the difference between a phone that is a source and a speaker that is
a sink."* That is an ordinary bug in a module that already has tests.

So: one environmental cause with an untried free fix, one unproven correlation,
and one ordinary bug.

## Architecture

### Three-way output, one arbiter

```
USB audio card present?        -> wired USB   (ALSA default)
else relay speaker connected?  -> BT relay    (bluealsa device)
else                           -> 3.5mm jack  (ALSA default)
```

USB first because plugging a cable in is an explicit act. The relay second
because it is the standing default once configured. The jack last because it
cannot be detected and is the safe fallback — unchanged from today.

**`audio-route.sh` remains the single arbiter of which output is used.** It
gains a third branch. Multiple event sources feed it, exactly as udev does now:

| Event source | Fires on |
|---|---|
| udev (`99-lockerroom-audio.rules`) | sound card add/remove — USB speaker |
| relay manager (new) | BT speaker connect/disconnect |
| boot | `lockerroom-audio-route.service` |

### The mechanism problem, stated plainly

The wired outputs are selected by the **ALSA default**, and `bluealsa-aplay`
gets **no `-D`** — a rule stated in `STATE.md` and load-bearing for two
reasons: every failure path lands on a bare player, and `audio-check.sh --tone`
plays at `-D default` so it follows the routing automatically.

**The relay cannot work that way.** Its output is a bluealsa PCM, selected as:

```
bluealsa-aplay -S $AUX_MAC -D bluealsa:DEV=<speaker-mac>,PROFILE=a2dp
```

So the relay requires `-D`. This is the one place the existing rule bends, and
it must bend in the safe direction. Extend the existing drop-in using the same
load-bearing dash-and-bare-variable trick already documented there:

```
EnvironmentFile=-/run/lockerroom/aux.env
EnvironmentFile=-/run/lockerroom/output.env
ExecStart=
ExecStart=/usr/bin/bluealsa-aplay -S $AUX_MAC $AUX_DEV
```

`output.env` holds `AUX_DEV=-D bluealsa:DEV=...,PROFILE=a2dp` when relaying, and
is **absent otherwise**. A missing file, an empty variable, a crashed relay
manager, an uninstalled listener — every one of those expands to no argument at
all, lands on a bare `bluealsa-aplay`, and plays to the ALSA default, which is a
wired output. **Every failure path still ends at a working speaker.**

`audio-route.sh` writes and removes `output.env`, so the arbiter owns both
mechanisms and they cannot disagree.

**Known cost, stated up front:** while relaying, `audio-check.sh --tone` tests
the ALSA default (the jack), not the relay. The diagnostic must say so loudly
rather than silently mislead — this is the exact failure the wired design was
built to avoid, and it returns here by necessity. `audio-check.sh` gains a
branch that reads the routing and prints, in the relay case, that the tone
proves the analog path only and that the relay must be checked separately.

### The lifecycle role fix — the actual blocker

Today `lifecycle.py` sees any connected device as a DJ candidate:

```
lockerroom.lifecycle: aux granted to JBL Charge 6 (78:66:F3:1C:9D:B6)
lockerroom.lifecycle: session closed: JBL Charge 6 (78:66:F3:1C:9D:B6)
```

A relay target must never enter aux arbitration, never open or close a play
session, and never reach the play data or the site's connected-device list.

**Design: one config key and one guard.**

```toml
[relay]
speaker_mac = "AA:BB:CC:DD:EE:FF"   # absent = relay disabled entirely
```

The session manager treats `speaker_mac` as excluded by identity, before any
other logic. MAC rather than profile-role inspection because it is
deterministic, trivially testable, and cannot be confused by a speaker that
advertises both roles. The role check is the more general answer and can come
later; the allowlist is the correct v1.

**Relay disabled by default.** With no `speaker_mac`, none of this code path is
reachable and the box behaves exactly as it does today.

### The relay manager

A new module owning the outbound connection only:

- connect to `speaker_mac` at startup and on disconnect, with backoff
- notify the arbiter (run `audio-route.sh`) on connect and disconnect
- expose current relay state for `audio-check.sh` and the beacon
- never touch aux arbitration, sessions, or play data

Pairing is a one-time manual step (`bluetoothctl pair/trust`), documented in the
runbook. Not a scan-and-pick UI in v1.

### Airtime: move wifi to 5 GHz

```
nmcli connection modify <con> 802-11-wireless.band a
```

**Why this is the right trade for this product specifically:** the audio path
does not use wifi at all. Wifi carries only the beacon and the outbox drain, and
the outbox is store-and-forward SQLite — a weak link means plays sync late, not
that music stops. Trading wifi signal margin for Bluetooth airtime is trading
something this product barely needs for the thing it entirely depends on.

Must be verified: that the beacon still reaches production at -78 dBm, and that
the netwatch thresholds do not start bouncing a link that is merely weak.

### Bluetooth watchdog (`btwatch`)

Mirrors the existing `netwatch` pattern: detect a wedged controller, recover
without a reboot.

Detection: `hciconfig hci0` missing `UP RUNNING`, or HCI commands timing out.
Recovery, from `STATE.md` (six seconds, no reboot):

```bash
echo serial0-0 | sudo tee /sys/bus/serial/drivers/hci_uart_bcm/unbind
sleep 3
echo serial0-0 | sudo tee /sys/bus/serial/drivers/hci_uart_bcm/bind
```

Then restart `bluealsa`, `bluealsa-aplay`, `keep-discoverable`, `bt-agent`,
`lockerroom-listener`.

**Worth building regardless of the relay.** A wedged radio today is a dead
speaker with every unit green — the project's signature failure — on a box that
cannot be reached from campus.

## Anti-bypass: this is stronger, not weaker

`spec.md` §2 relies on occupying the speaker so nobody can pair straight to it
and skip the voting. Most portable speakers accept **one A2DP connection at a
time**, so the Pi holding that slot provides the same guarantee — and unlike a
jack, the Pi can notice a disconnect and **actively reconnect**. That is
enforcement that cannot be defeated by unplugging a cable.

**Must be verified per speaker.** A multipoint speaker (two simultaneous
connections) can still be bypassed. Note this is *already* unverified for the
current USB path — the go/no-go in `STATE.md` has never been tested.

## Risks and open questions

| Risk | Status |
|---|---|
| One antenna carrying A2DP sink + source | **Unproven.** 5 GHz is the untried free fix; a ~$10 USB BT dongle is the fallback |
| Controller wedge | **Unproven causation.** `btwatch` makes it survivable either way |
| Added latency (two BT hops) | Expected a few hundred ms. Tolerable with no video to sync to, but **measure it** |
| Double SBC transcode | **Not a risk** — measured 97.9% idle on 2026-08-23 |
| Multipoint speakers defeat anti-bypass | Per-speaker; test before relying on it |

**The fallback purchase, framed honestly:** if 5 GHz is not enough, a **~$10 USB
Bluetooth dongle** gives the outbound side its own radio and antenna and bypasses
the UART-attached onboard controller that wedged. Unlike a powered hub — which
fixes one speaker — this is one purchase that serves every speaker permanently.
Mack has ruled out per-speaker spending, which this is not; it is still a
purchase and should be presented as one.

## When NOT to build this

Stated plainly so this document does not read as advocacy:

- **If aux speakers are reliably available**, the jack path already works, is
  free, and has none of these risks.
- **If the Charge 6 is the only speaker** and charging it before practice is
  acceptable, USB already works under that condition.
- **If the stuttering persists on 5 GHz and the dongle is refused**, this cannot
  be made reliable and should be abandoned rather than tuned.

The relay earns its cost specifically when speakers are **arbitrary and
unknown** — which is the situation the original request described.

## Testing

**Unit** (existing `pi/tests/` pytest patterns):

| Case | Expected |
|---|---|
| relay MAC connects | no session opened, no aux granted, absent from play data |
| relay MAC + a real phone connected | phone gets the aux, relay excluded from arbitration |
| no `speaker_mac` configured | every code path behaves exactly as today |
| USB card present while relaying | USB wins, `output.env` removed |
| relay connected, no USB | `output.env` written with the correct device string |
| neither USB nor relay | `output.env` absent, ALSA default, bare player |
| relay manager dead | `output.env` absent, wired output, speaker still works |

**Hardware, in order:**

1. Relay to the Charge 6 with wifi on 2.4 GHz — reproduce the stuttering, to
   confirm the baseline before changing anything
2. Move wifi to 5 GHz — re-run; this is the experiment the whole design rests on
3. Full session: several songs, measure dropouts and latency
4. Anti-bypass: try to pair a phone directly to the speaker while relayed
5. Wedge recovery: verify `btwatch` restores a deliberately wedged controller

**Step 2 is the go/no-go.** If 5 GHz does not clear the stuttering, stop and
decide about the dongle before building anything else.

## Out of scope

- Scan-and-pick speaker selection UI (config key only in v1)
- Reporting the selected output in the heartbeat — still deferred, still
  wanted, `/run/lockerroom/audio-out` remains the hook
- Profile-role detection instead of a MAC allowlist
- Multiple relay targets
