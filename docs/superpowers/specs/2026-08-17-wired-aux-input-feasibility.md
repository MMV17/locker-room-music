# Wired aux input (a cord from a phone) — feasibility

Date: 2026-08-17. Status: **research only. Nothing here is built, and the
recommendation is not to build it as specified.**

The question, as asked: can a phone or iPad play music into AuxGoat over a cord
— USB-C to aux — instead of Bluetooth? And would the box need a physical *in*
as well as its existing *out*, so that it sits downstream of the phone doing the
playing?

## The short answer, both halves

**On the hardware question — yes, it needs an input it does not have.** The Pi
4B has exactly one analog audio port and it is an output. Any analog wired path
means adding input hardware. There is one wired path that avoids adding
hardware, and it does it by repurposing the port the Pi is currently powered
through, which has its own cost. Both are laid out below.

**On whether it is worth doing — the audio is the easy half, and the audio is
not the product.** A cord carries audio and nothing else. AuxGoat does not exist
to make sound; `bluealsa-aplay` did that on day one of phase 1. It exists to
know **which song is playing and whose phone played it**, and every bit of that
comes from AVRCP over Bluetooth. Pull the Bluetooth out and the speaker still
works perfectly while the product stops existing: no track, no DJ, no vote, no
leaderboard, no reveal.

So this is not a driver problem. It is a question about what the box is for,
and it should be decided as one.

## What the Pi 4B's ports actually do

Worth stating plainly, because "aux" is used for both directions in casual
speech and the board is asymmetric:

| Port | Direction | Notes |
|---|---|---|
| 3.5 mm TRRS jack | **OUT only** | Stereo out + composite video on the fourth ring. There is no microphone or line-in pin. This is what `bluealsa-aplay` feeds today via `snd_bcm2835` (see STATE.md, "Any replacement needs ANALOG AUDIO OUT"). |
| HDMI ×2 | OUT only | Audio out to a display. Not useful here. |
| USB-A ×4 | Host | Can host a USB sound card, which is how an input gets added. |
| USB-C | Power in, **or** USB 2.0 peripheral | Both, but not usefully both at once. See option B. |
| GPIO | I2S both ways | An I2S HAT can carry a codec with line-in. Occupies the header. |

**There is no such thing as plugging a phone into the 3.5 mm jack.** Two
outputs facing each other pass no signal, and it is the single most common way
this idea gets tried first. The jack is not the input.

## Why metadata is the whole problem

Today, one Bluetooth connection carries four separate things, and the product
uses all four:

| What the phone sends over BT | Where it lands | What breaks without it |
|---|---|---|
| A2DP audio | `bluealsa-aplay` → 3.5 mm | Nothing — a cord replaces this cleanly |
| AVRCP title / artist / album | `bluez_watcher.py` → `tracks` row, artwork lookup | The song is unidentifiable |
| AVRCP status + position | `lifecycle.py` play open/close, pause, skip detection | No play boundaries, no 30 s skip rule, no vote window |
| The device MAC | `SHA-256(mac + MAC_SALT)` → `devices.mac_hash` | Nobody can be credited or claim a phone |

**A cord carries the first row and none of the others.** This is not a Linux
limitation, it is what the physical layer is: analog line-in is a voltage, and
USB Audio Class 2 is a PCM stream with a sample rate. Neither specification has
a field for a song title, because neither was ever meant to.

### What that does to this codebase, specifically

Not hypothetical — this is traceable through the existing code:

- `POST /api/plays` (`backend/src/index.ts:91`) requires only `play_id` and
  `started_at`. A metadata-less play is accepted. It then computes
  `trackKey("", "")`, which `backend/src/trackKey.ts` evaluates to the string
  `"|"` — **one shared key.** Every wired play for the entire season would
  dedupe onto a single `tracks` row titled `(unknown)`, and that row would sit
  on the track leaderboard accumulating every vote anyone cast on any wired
  song. The artwork lookup would fire once on an empty query and cache `none`
  forever (spec 6.4).
- `plays.device_hash` is nullable, so a wired play stores cleanly as
  `Unclaimed`. But claiming works by picking your phone off the device list
  (`web/src/screens/Claim.tsx`), and a cord produces no device row to pick.
  Those plays are **permanently** unattributable — not "unclaimed for now".
- The vote window needs `duration_ms` or `keepalive_at`
  (`backend/src/voteWindow.ts`, and STATE.md "Now on aux outlived the song by
  four days"). A wired source supplies neither, so every wired play falls to the
  wall-clock fallback and `presentablePlay()` has nothing honest to show.

So a wired play is not a degraded play. It is a row that actively corrupts the
leaderboard the product is built around.

### The one thing a cord genuinely does better

Stated fairly, because it is the real argument in favour: **a cord enforces one
DJ physically.** All of `pi/lockerroom/aux.py`, `AUX_GRACE`, `PAUSE_COOLDOWN`,
`PAUSE_GRACE`, `AUX_SETTLE`, the MAC allowlist and the whole "iOS resumes on its
own after an external AVRCP pause" fight exist only because A2DP is not
exclusive and two phones can stream at once. One cord, one DJ, and the handoff
is someone physically passing a cable — which is also how every locker room
already handles this, and it needs no explaining to a fifteen-year-old.

That is a real benefit. It is not worth losing song identity for, but it is
worth remembering if the aux-routing code ever becomes a maintenance problem.

## The three wired paths

### A. Analog line-in through a USB sound card

The literal answer to "physical in and out". Phone → USB-C-to-3.5 mm dongle →
3.5 mm male-male cable → line-in on a USB audio adapter in one of the Pi's
USB-A ports → software loop → the Pi's 3.5 mm out → speaker.

- **Cost**: ~$12–20 for a USB adapter with a true line-in (many cheap ones are
  mic-in only — mono, biased, and it will clip a line-level phone output). Each
  player also needs their own dongle, which is the practical killer below.
- **Software**: `alsaloop -C hw:CARD,0 -P hw:0,0`, or a `.asoundrc` route. No
  kernel work, no gadget mode, no power hackery.
- **Quality**: DAC in the phone → ADC in the adapter → DAC in the Pi → the Pi's
  PWM jack, which STATE.md already calls "genuinely mediocre". Three conversions
  for something that is currently one. Acceptable in a loud room; it is not an
  audio-quality upgrade, and anyone proposing this for fidelity has it backwards.
- **Latency**: an `alsaloop` buffer, tens of ms. Irrelevant for playback.
- **Metadata**: none.

### B. USB Audio Class gadget — the Pi becomes the phone's headphones

The most elegant of the three, and the only one needing no added hardware. The
Pi 4B's USB-C port can be put into USB 2.0 **peripheral** mode
(`dtoverlay=dwc2,dr_mode=peripheral` — the `dr_mode` is mandatory on the 4B,
which has no OTG_ID pin to auto-select). With the `f_uac2`/`g_audio` gadget
function loaded, the phone enumerates the Pi as a class-compliant USB audio
output — indistinguishable, to the phone, from a pair of USB-C headphones — and
sends **digital PCM**. No extra ADC/DAC round trip; audio arrives as an ALSA
capture device and is played straight out the 3.5 mm jack.

Three hard constraints, in order of how much they hurt:

1. **The USB-C port stops being the power port.** OTG works only on USB-C on the
   4B, so the board has to be powered through the GPIO 5 V header instead. That
   route **bypasses the board's input protection and the 4.63 V supervisor** the
   official supply feeds — the same supervisor STATE.md leaned on to exonerate
   power during the 2026-08-12 post-mortem. Given that a board just died of
   something never explained, deliberately removing a protection circuit from
   the replacement is a poor trade. And the phone cannot power the Pi: a Pi 4B
   under load wants several watts and an iPhone will not source it.
2. **Mixed phone fleet.** USB-C-native iPhones are 15 and later; anything older
   is Lightning and needs a Camera Adapter, and Android varies. A team has all
   of these.
3. **iOS behaviour is not guaranteed.** iOS and iPadOS do speak UAC1/UAC2 to
   class-compliant devices, and iOS 17.4 broadened USB-C audio support — but the
   Linux `f_uac2` gadget's descriptors are reported to work with some hosts and
   not others, with iPadOS specifically cited as troublesome. **This is
   measurable in an afternoon and must be measured before anything is designed
   around it.**

Metadata: still none. USB Audio Class has no metadata channel. The protocol that
*does* carry track title from an iPhone over a cable is **iAP2**, which is how
car head units do it — and iAP2 requires Apple MFi licensing and an
authentication coprocessor. It is closed to this project. There is no clever way
around this.

### C. Cord for audio, Bluetooth for metadata — the hybrid

The only wired option that could keep the product intact: the phone stays paired
over Bluetooth so AVRCP keeps flowing, while audio goes over the cord.

It rests on one unverified assumption: **does iOS keep pushing AVRCP metadata to
a connected Bluetooth device while its audio route is a wired output?** Nothing
authoritative was found either way, and it is exactly the kind of question this
project has repeatedly answered by measuring rather than reasoning. Two outcomes:

- **It does** → the hybrid works, `bluealsa-aplay` is replaced by the wired
  source, and everything from `lifecycle.py` upward is untouched. That would be
  a genuinely good outcome.
- **It does not** (the likelier one — AVRCP metadata notification is normally
  tied to the rendering device) → the hybrid is dead and so is the whole idea.

Even if it works, the UX is bad: the player pairs Bluetooth **and** plugs in a
cord, and must not let the phone route audio back to Bluetooth. That is two
correct actions from someone doing this once, in a hurry, in a loud room — and
STATE.md's own UX walkthrough is a record of how badly single-step flows already
went.

### The honest alternative: non-Bluetooth does not have to mean wired

If the actual goal is "an option that is not Bluetooth", **AirPlay is strictly
better than any cord**, because it is the only option that keeps the product
whole. `shairport-sync` on the Pi exposes an AirPlay receiver *and* a metadata
pipe carrying artist, title, album and cover art — the same fields
`bluez_watcher.py` harvests from AVRCP, from a source that already knows them.

Its cost is different, not smaller: it needs the phone and the Pi on the same
network with mDNS reachable between them, and HCGuest's client isolation is
exactly the sort of thing that blocks it — the same category of problem as the
SNI filter in STATE.md. **Measurable in ten minutes on campus** with
`avahi-browse -a` from the Pi and a phone on the same SSID, and worth measuring
before any cord is bought, because a positive result makes this whole document
moot. It also only covers Apple devices.

## Recommendation

**Do not build a wired input as the primary path.** It trades the entire product
for a convenience Bluetooth already provides, and the convenience is not even
clearly better once every player needs to carry a dongle — a cord requires the
DJ to have the right adapter for their specific phone, where Bluetooth requires
them to have nothing.

In order of what is worth actually doing:

1. **Measure the two cheap unknowns first** (below). Either result changes the
   answer, and both are afternoon experiments, not projects.
2. **If a wired option is wanted regardless of the cost** — for a phone that
   will not pair, a guest, a coach's laptop — build **option A** and treat it as
   an explicitly unattributed "line in" mode: audible, never written to `plays`.
   That is a small, honest feature. It is not the DJ product.
3. **Do not build option B** until the board that will run it is alive, proven,
   and the GPIO-power question has been answered by someone comfortable losing
   the supervisor circuit. It is the technically nicest option and the one with
   the worst failure story on hardware that has already died once unexplained.

**Nothing here should be started before there is a working Pi in the room.**
STATE.md's own ordering is right: the speaker is dead, nobody has used this
product for real even once, the reveal has never fired for anyone. A second
input path for a product with zero sessions is optimising the wrong end.

## The two experiments to run first

Both are cheap, both are decisive, and neither needs new hardware:

**1. Does AVRCP survive a wired audio route?** (settles option C, and with it
the only version of this idea that preserves the product)

Pair a phone to the Pi as normal, start a song, confirm the listener logs the
track. Then, still paired, plug wired headphones into the phone so iOS moves the
audio route off Bluetooth, and change tracks. Watch:

```bash
journalctl -u lockerroom-listener -f | grep -i "play opened"
```

A new `play opened` line means AVRCP kept flowing and option C is live.
Silence means every wired variant is metadata-blind, permanently.

**2. Does AirPlay work on the school network?** (settles whether any of this is
needed)

From the Pi on HCGuest, with a phone on the same SSID:

```bash
avahi-browse -a -t          # does the phone see anything, does anything see the Pi
```

If mDNS crosses between guest clients, `shairport-sync` gives a non-Bluetooth
path *with* metadata and this document is moot for Apple devices. If it does
not — the likelier outcome on a guest network with client isolation, and the
same failure family as the SNI filter — that is worth writing down once so it is
never re-investigated.

## If it is built anyway, the minimum that must change

Not a design, just the boundaries a wired path must respect so it cannot damage
what already works:

- **A metadata-less source must never write a `plays` row.** The `"|"` track key
  above is the specific harm: one poisoned `tracks` row silently aggregating a
  season of anonymous plays onto the leaderboard. Rejecting it server-side is
  *not* the right fix, because the Pi legitimately sends sparse metadata today
  during AVRCP transitional states — that is what the `incomplete` flag is for.
  The gate belongs on the Pi, at the source, where the difference between "a
  Bluetooth session whose metadata has not arrived yet" and "a cord that will
  never have any" is actually known.
- **The aux router must keep its failure shape.** `aux.py` and
  `bluealsa-aplay-aux.conf` are built so that every failure path lands on plain
  `bluealsa-aplay -S`, which plays anything: the failure mode is the old mixing
  behaviour, never a silent speaker. A wired source added to that chain must
  inherit the same property. A cord unplugged mid-session, or an `alsaloop` that
  dies, must leave a speaker that still makes sound.
- **The site needs a third source state.** The header today says Speaker
  online/offline, and `/api/now` already cannot distinguish "connected but
  playing nothing" from "nobody connected" (STATE.md, "The speaker still does
  not report who is connected"). "Someone is playing over the cord and we cannot
  see what" is a *fourth* state on top of a gap that is already open. Close the
  existing one first.
- **It needs a Pi deploy, which is expensive.** SSH is reachable only by
  physical access over USB-C ethernet on campus. Bundle any of this with a
  physical visit; do not plan a trip around it.

## Sources

- [Using OTG mode on Raspberry Pi SBCs (Raspberry Pi white paper)](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009276-WP/Using-OTG-mode-on-Raspberry-Pi-SBCs)
- [Power RPi 4B through header to use USB-C as an OTG device](https://forums.raspberrypi.com/viewtopic.php?t=362132)
- [Using a Raspberry Pi 4B USB-C OTG port to simulate wired headphones for Android and iOS](https://forums.raspberrypi.com/viewtopic.php?p=2350451)
- [linux `f_uac2` USB audio gadget function](https://github.com/torvalds/linux/blob/master/drivers/usb/gadget/function/f_uac2.c)
- [TN3190: USB audio device design considerations (Apple)](https://developer.apple.com/documentation/technotes/tn3190-usb-audio-device-design-considerations)
- [MFi Program — how it works (iAP2 licensing)](https://mfi.apple.com/en/how-it-works.html)
- [Exploring Apple's MFi protocol iAP2](https://wiomoc.de/misc/posts/mfi_iap.html)
- [shairport-sync — AirPlay receiver with a metadata pipe](https://github.com/mikebrady/shairport-sync)
