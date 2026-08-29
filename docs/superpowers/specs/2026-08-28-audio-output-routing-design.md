# Automatic audio output routing: USB if present, else the jack

**Date:** 2026-08-28
**Status:** design approved, implementation pending

## The problem

Speakers disagree about how they take a wired input. Some have only a 3.5mm aux
jack; some, like the JBL Charge 6, have only USB-C digital audio and no analog
input at all (see "The speaker side" in `STATE.md`). We have both cables — a
3.5mm-to-3.5mm and a USB-A-to-USB-C — and today switching between them means
hand-editing `/etc/asound.conf` on a box that campus makes hard to reach.

The Pi should pick the right output by itself.

## The constraint that shapes everything

**The Pi 4's 3.5mm jack cannot be sensed.** The bcm2835 analog output has no
jack-detect pin and exposes no jack kcontrol, so no software anywhere on the
box can tell whether a cable is in it. "Detect which one is plugged in" is not
implementable as stated.

USB audio, by contrast, is completely reliable: the speaker enumerates as its
own ALSA card and udev fires on plug and unplug.

So the rule is one-sided:

> **If a USB playback card is present, route there. Otherwise, the analog jack.**

The jack is a fallback rather than a detection, which is also the safe
direction — the project's existing "every failure path lands on a working
speaker" principle already assumes analog.

### Rejected: send audio to both outputs at once

Considered and rejected. ALSA's `multi` plugin opens *all* its slaves or none,
so with the USB cable unplugged the open fails and **both** outputs go silent —
including the jack that is physically fine. That is the same class of bug as
"asound.conf names a card that does not exist," already documented in
`STATE.md` as: every unit green, room silent. Two free-running card clocks also
drift, producing xruns over a long session.

And it saves nothing: building a `multi` config requires knowing whether the
USB card exists, which is the same detection the one-sided rule needs.

### Rejected: a pure-ALSA config with no daemon

There is no such thing. ALSA config has no runtime conditional and no way to
test whether a card is present; `multi` and `plug` cannot express "use this
slave if it opens." Something has to watch and rewrite.

### Rejected: the Python listener writes `-D` into `aux.env`

The alternative was to add `$AUX_DEV` to the `bluealsa-aplay` drop-in and let
`aux.py` write `-D plughw:CARD=<id>,DEV=0`, reusing the existing dash-and-bare-
variable trick. It lands in a module that already has tests and never writes to
`/etc`.

Rejected for two reasons. It breaks the "never pass `-D` to `bluealsa-aplay`"
rule stated in `STATE.md`. More concretely, it makes `audio-check.sh --tone`
**lie**: the tone plays at `-D default`, so it would test the jack while real
audio went to USB. This project's entire documented history is *silent room,
everything green* — blinding the one diagnostic that addresses that is not a
trade worth making. It also puts output selection behind the listener being
alive.

## Architecture

One new script owns the decision and is **the only writer of
`/etc/asound.conf`.**

| File | Installed to | Role |
|---|---|---|
| `pi/scripts/audio-route.sh` | `/usr/local/bin/audio-route.sh` | The whole brain. Picks the output, writes the config, restarts the player. Idempotent. |
| `pi/systemd/lockerroom-audio-route.service` | `/etc/systemd/system/` | `Type=oneshot` wrapper so udev can trigger it and systemd serialises runs. |
| `pi/systemd/99-lockerroom-audio.rules` | `/etc/udev/rules.d/` | Fires the unit on sound-card add/remove. |

### The udev rule

```
ACTION=="add|remove", SUBSYSTEM=="sound", KERNEL=="card*", \
  RUN+="/usr/bin/systemctl --no-block start lockerroom-audio-route.service"
```

`RUN+=` with `--no-block` rather than `ENV{SYSTEMD_WANTS}`, because
`SYSTEMD_WANTS` is unreliable on `remove` — the device is already going away.
`--no-block` returns immediately, so this does not violate udev's rule against
long-running `RUN` programs.

The unit is **also** `WantedBy=multi-user.target` with `After=sound.target`, so
a speaker plugged in before power-on does not depend on coldplug replay
ordering. The script is idempotent, so running twice costs nothing.

### How the script picks

Not by matching the string `USB` in `/proc/asound/cards`. That is a name, and
names lie. It walks `/proc/asound/card*/` and accepts a card as a USB output
only if it has **both**:

- `usbid` — definitively a USB device
- a `pcm*p` entry — has a **playback** PCM, which is what excludes a USB
  microphone or a webcam from stealing the audio path

Lowest card index wins if there is somehow more than one. With no USB playback
card, the target is the `bcm2835` analog card, located with the same expression
`provision.sh` and `audio-check.sh` already use.

### Order of operations

1. Determine the target card id.
2. Compare against the card currently named in `/etc/asound.conf`. **If
   unchanged, exit without touching anything** — no pointless restart mid-song.
3. Write `/etc/asound.conf.tmp`, then `rename()` it into place. Atomic, so a
   crash or power cut can never leave a half-written config.
4. Write the selection to `/run/lockerroom/audio-out` (one line, e.g.
   `usb:Charge` or `jack:Headphones`).
5. `systemctl restart bluealsa-aplay`.

The written config keeps the existing `plug` → `hw` shape and the
`# managed by lockerroom` marker, and continues to name the card **by ID, never
by index** — card numbers move between boots and images, which is the bug that
caused the 2026-08-22 outage.

### Data flow

```
cable in → kernel registers card → udev add → oneshot starts
  → target changed: jack → usb:Charge
  → atomic write asound.conf, write /run/lockerroom/audio-out
  → restart bluealsa-aplay
  → next PCM open lands on the USB card
```

**The phone does not drop.** The A2DP link is held by `bluealsa`, which is
never touched; only `bluealsa-aplay` restarts. Expect roughly a one-second gap
in the music, no re-pair and no reconnect. Unplugging is the same in reverse.

### Ownership

No shared file, so no two writers and no race:

- `/run/lockerroom/aux.env` — **which phone is audible**. Owned by `aux.py`,
  unchanged by this work.
- `/etc/asound.conf` — **which output**. Owned by `audio-route.sh`.

The Python listener is not modified. Routing keeps working even if
`lockerroom-listener` is dead.

## Failure handling

The governing rule: **never write a config naming a card that does not exist.**
That is the catastrophic state documented in `STATE.md` — every playback open
fails and the room is silent with all units green.

| Case | Behavior |
|---|---|
| Neither USB nor analog card present | **Refuse to write.** Leave the existing config alone, log loudly, exit nonzero. |
| Hand-written `asound.conf` (a real DAC) | Left alone — same `# managed by lockerroom` marker rule `provision.sh` uses today. Exit 0 with a message. |
| `card` add fires before `pcm0p` exists | Retry enumeration 3× over ~2s. Without this a USB speaker is occasionally misread as "no playback" and ignored. |
| Event storm from a single plug | systemd coalesces queued starts; "no-op if unchanged" means at most one real restart. No debounce timer needed. |
| USB yanked mid-stream | `remove` fires, config reverts to the jack, player restarts. Self-healing, no manual step. |
| USB speaker powered off, or not in USB-audio mode | Does not enumerate at all, so it is simply absent and the jack keeps playing. Falls out for free. |
| Another USB playback device (a headset dongle) | It wins. Same "plugging it in is the instruction" rule; the choice is visible in `/run/lockerroom/audio-out` and in `audio-check.sh`. |

## Changes forced on existing scripts

### `deploy.sh` — required, not optional

Its verification block hard-checks
`/proc/asound/card$ANALOG_IDX/pcm0p/sub0/status` — the *analog* card
specifically. Once USB is correctly selected, that check fails and deploy
prints **"THIS BOX WILL BE SILENT"** on a perfectly healthy box. It must verify
whichever card is *selected*. Shipped unchanged, this feature would make deploy
lie in the most alarming possible direction.

### `provision.sh` — simplification

Its `asound.conf` heredoc is replaced by a call to `audio-route.sh`, so there
is exactly one writer and the two cannot drift.

This needs an `--bootstrap` flag for provision's pre-reboot case, where
`dtparam=audio=on` was only just added and no card exists yet: bootstrap writes
the stock id `Headphones` on faith, exactly as `provision.sh` does today.
Normal runs still refuse.

### `audio-check.sh` — extended

Prints the live selection from `/run/lockerroom/audio-out`, and under `--tone`
checks the PCM status of the **selected** card rather than the analog one. This
is the payoff of the chosen approach: the tone can never test a different
output than the one carrying the music. Its existing "no `/etc/asound.conf` →
card 0" catastrophic case is unchanged.

## Testing

`audio-route.sh` honors three environment overrides so it can be driven from
pytest against a fake card tree in `tmp_path`, fitting the existing `pi/tests/`
layout:

- `ASOUND_ROOT` (default `/proc/asound`)
- `ASOUND_CONF` (default `/etc/asound.conf`)
- `RESTART_CMD` (default `systemctl restart bluealsa-aplay`)

Faking goes through our own variables rather than `ALSA_CONFIG_PATH`, which
`STATE.md` records as having silently not worked because the system `alsa.conf`
includes `/etc/asound.conf` itself.

Cases:

| Fixture | Expected |
|---|---|
| USB card with `usbid` + `pcm0p` | selected |
| no USB card | analog selected |
| `usbid` but no `pcm*p` (a mic) | ignored, analog selected |
| two USB playback cards | lowest index, deterministically |
| neither card present | refuses to write, exits nonzero, existing file untouched |
| conf without the managed marker | untouched, exit 0 |
| selection unchanged | no write **and** no restart |
| any run | no `.tmp` file left behind |

Then on hardware: both cables, a phone streaming, plug and unplug each —
confirm the ~1s gap and that the phone stays paired.

## Out of scope

**Reporting the selected output in the heartbeat.** The failure this feature
introduces is "it picked the wrong output," which is invisible from the room
and is exactly the signature that has burned multi-hour sessions on this
project. One string in the beacon would turn it into a glance, and it rides
outbound 443, which campus does not block.

Deliberately deferred to a follow-up spec so the Pi-side routing lands
standalone before anything touches the Worker, D1 schema, and admin screen.
`/run/lockerroom/audio-out` exists partly as the hook that work will read.
