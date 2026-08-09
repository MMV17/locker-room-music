# Consumer first-run provisioning — design

Date: 2026-08-07. Status: **design only.** Nothing here is built, and it should
not be started before the landing page ships.

How a non-technical person takes a sealed AuxGoat box out of a case and gets it
onto a network and bound to their team, with nothing but a phone.

## The problem, stated honestly

Today a box is set up by editing `/etc/lockerroom/config.toml` over SSH — two
values, `api_base_url` and `device_key` — and by configuring wifi with `nmcli`.
Both require a laptop, a terminal, and knowing the shared device key. STATE.md
records the full incantation. That is fine for one box owned by the person who
built it and impossible for anyone else.

A fresh box needs three things, and they are genuinely separate:

| | What | Today | Consumer version |
|---|---|---|---|
| 1 | **Network** | `nmcli` over SSH | Phone-driven, on-device portal |
| 2 | **Identity** | Shared `device_key` in a file | Per-unit secret burned at manufacture |
| 3 | **Team binding** | `api_base_url` hand-typed | QR on the case, claimed with a team code |

They fail independently and have to be debuggable independently. A box that is
on wifi but unbound is a completely different problem from one that is bound
but offline, and the status LED has to be able to say which.

## Hardware: CM4 on a custom carrier

The strong recommendation, because it makes this design a carrier-board project
rather than a software rewrite.

Everything in `pi/` depends on BlueZ doing A2DP sink and AVRCP metadata, driven
from Python via D-Bus. That is a Linux stack. An ESP32 can be an A2DP sink but
cannot carry the AVRCP property-change plumbing in `bluez_watcher.py`, the local
SQLite outbox, or the HTTPS sync — porting to it means rewriting the product.

**Compute Module 4 (wifi variant) on a custom carrier PCB** is designed for
exactly this: it is the Pi 4B silicon in a form factor meant to be mounted on a
board you lay out yourself. The existing image, services, and Python run
unchanged. `pi/scripts/deploy.sh` keeps working.

Two CM4 specifics that matter here:

- **Take the external-antenna variant.** The Pi 4B's `hci0` is `Bus: UART` —
  the built-in radio, sharing its antenna with wifi. In this product BT and wifi
  are both busy *simultaneously and constantly*: A2DP streaming audio while the
  outbox syncs and the beacon fires. STATE.md defers the range question until it
  causes a problem, which is right for a box on a desk and wrong for a product.
  A carrier board is the one moment this is cheap to fix.
- **eMMC, not SD.** SD cards die, and a consumer cannot reflash one. The failure
  mode of an SD card in an always-on appliance is a support ticket that ends in
  a replacement unit.

## Network: SoftAP captive portal, not BLE

The box broadcasts its own wifi network. The phone joins it, a browser opens
automatically, the user picks their network and enters credentials, and the box
switches over.

**BLE provisioning would be more elegant here and cannot be used.** The
temptation is real and worth writing down so it is not re-litigated: this box is
*already a Bluetooth speaker*. `bt-agent` and `keep-discoverable` already run,
the phone is going to pair with it anyway, and for most products BLE setup means
"install our app first" while here it would not.

It does not work because **iOS has no Web Bluetooth.** Safari has never shipped
it, and every other iOS browser is WebKit underneath, so it is absent there too.
Driving BLE from a web page is Android-only. Doing it on iPhone requires a
native app, and there is no app — and the existing testing is all iPhone, with
STATE.md noting Android was skipped by decision.

So: SoftAP, which works from any phone's browser with nothing installed.
Revisit BLE if a native app is ever built, as an *addition*, never a
replacement — the browser path has to keep working for someone whose phone
cannot install anything.

### The flow

1. Box boots with no known network. Scans, caches the result, then starts an
   access point named **`AuxGoat-A7F3K2`** using the serial printed on the case,
   so someone holding two boxes can tell them apart.
2. Phone joins it. Both iOS and Android probe for a captive portal on join —
   iOS against `captive.apple.com`, which `netwatch.py` already uses as its
   neutral host — and a portal responder on the box makes the setup page open by
   itself. No typed URL, no app.
3. Page lists the cached scan, strongest first. User taps their network.
4. The form shown depends on what the scan reported for that network. This is
   the part that carries the whole design; see below.
5. Box writes the connection with `nmcli`, drops the AP, and joins.
6. Box verifies real egress — not association. `netwatch.py` already draws this
   distinction and it is the whole reason it exists: the Pi has been seen
   holding an IP while unable to reach its own gateway.
7. On success the LED goes solid and the box registers itself. **On failure the
   AP comes back up**, which is the design's answer to the reporting problem
   below.

### Security types, and why the form has to branch

The scan tells us what the network wants, and guessing wrong is what makes
consumer setup fail. Three cases, all of which are real for this product:

**Open, no credentials — and this is production today.** `HCGuest` is
`Security: None`, no PSK, no 802.1X. A portal that requires a password field
cannot connect the box to the network the live deployment actually runs on. The
form has to accept "nothing to enter" and say so, rather than looking broken.

**WPA2-PSK.** The ordinary home, gym, and team-bus case. One password. Nothing
interesting.

**WPA2-Enterprise / 802.1X — the likely case for schools, and the hard one.**
A correct connection needs EAP method, inner authentication, identity, often an
anonymous identity, and a CA certificate. No consumer fills that in correctly
from a phone, and plenty of IT departments will not permit an unmanaged device
on the 802.1X SSID at all.

The design does not pretend otherwise. It offers three paths in this order:

1. **PEAP/MSCHAPv2 with username and password**, which is what most schools
   actually run. CA validation is attempted; if it fails, the box says the
   certificate could not be verified and requires an explicit tap to continue
   rather than silently disabling validation.
2. **MAC registration on a guest or IoT SSID**, which is what IT departments
   usually prefer anyway. The portal displays the wifi MAC in large type,
   copyable, with a line explaining what to hand over. STATE.md already
   identifies this as the number to give out — `wlan0` is
   `e4:5f:01:c2:6e:ab`, deliberately not randomised, because
   `wifi.cloned-mac-address permanent` is set so a network metering by MAC does
   not see a new device on every reconnect.
3. **Say it plainly and stop.** If neither works, the box says so and stays in
   AP mode instead of dropping into a state nobody can diagnose.

**Guest networks with a click-through captive portal cannot be solved and must
not be silently attempted.** A headless box cannot accept terms of service. The
egress check in step 6 already detects this — the probe returns a page that is
not what was asked for — and the portal must name the problem rather than
reporting a generic failure. `HCGuest` happens to have no portal; the next
school's guest network probably will.

### Reporting success, after the phone has disconnected

The classic SoftAP failure. The moment the box leaves AP mode to join the real
network, the phone loses the connection and the setup page dies mid-request. It
cannot report its own outcome over the channel it was using.

Three answers, layered, none sufficient alone:

- **The status LED is the primary channel.** This is why it is a hardware
  requirement and not a nicety.
- **Failure brings the AP back.** If `AuxGoat-A7F3K2` reappears, it did not
  work; rejoin and the portal explains what went wrong. Absence of the AP is
  itself the success signal.
- **The page says what to look for before it disconnects** — which light, what
  colour, how long to wait — because the user is about to be staring at a piece
  of plastic with no other information.

### Re-provisioning, and where it hooks in

Wifi passwords change. Boxes move. A box that can only ever be set up once is a
box that becomes e-waste on the day the school rotates its PSK.

`netwatch.py` already runs the ladder: **5 failed probes → bounce the
connection, 10 → restart NetworkManager, 15 → reboot**, rate-limited to one
reboot per six hours and persisted across restarts. It is enabled, survives
unattended reboots, runs under system Python with no third-party imports
specifically so a broken venv cannot take it down, and its probe is bound to
`wlan0` so an ethernet cable cannot make it report false health.

Provisioning becomes **the last rung of that existing ladder**: after the reboot
rung has been reached and the box still has no egress, re-enter AP mode. The
watchdog was already built to survive exactly the states this needs to recover
from, so this is an addition to a proven mechanism rather than a new one.

Plus a **physical button, long-pressed**, to force it — because the automatic
path takes fifteen minutes by design and someone standing in front of a box that
moved buildings should not have to wait.

Two things the button must get right: a long press, never a short one, so a box
in a gym bag cannot factory-reset itself; and it must clear network credentials
**without** clearing the device identity or team binding. Re-joining a network is
not the same event as changing owner, and conflating them turns "the wifi
changed" into "set the whole thing up again."

## Identity and team binding

### Per-unit secrets, replacing the shared key

Today every box for a school would share one `device_key`, hand-copied into a
config file. For consumer hardware that is wrong in both directions: the secret
is readable by anyone who has any box, and one leak forces a rotation across
every unit.

At manufacture each unit gets a **serial** (`A7F3K2`, printed on the case and
encoded in the QR) and a **unique random device secret**, recorded in a central
registry. The box authenticates as itself, and a compromised unit is revoked
alone.

For v1 the secret is a file on disk with restrictive permissions, matching how
`/etc/lockerroom/config.toml` is already handled at mode 600. **This is worth
naming as a real limitation:** anyone with physical access and the ability to
read the eMMC can extract it. An ATECC608 or equivalent on the carrier board
would fix it properly, and the decision belongs to the PCB design, not to the
software — which is the point of raising it now.

### Binding, via the QR

From the landing page design: the QR is printed at manufacture and encodes a
**device serial, not a team**, so units stay anonymous in inventory and can be
re-bound when a box changes hands.

```
Scan QR   ->  auxgoat.com/d/A7F3K2
Bound     ->  302 to https://hc.auxgoat.com/
Unbound   ->  "This speaker isn't set up yet." + team code field
```

Claiming a box means entering a team code on that page. The team code is
validated by the school's own Worker, which is where it has always been checked
and where a wrong answer leaks nothing across teams — this is the mechanism that
retires the brute-force exposure the apex code box introduces.

Once bound, the box learns its `api_base_url` from the registry on its next
registration call and writes it into config. **`api_base_url` stops being a
hand-edited value**, which also removes the standing hazard that the Pi names
exactly one API host, has no allowlisted command to change it, and cannot be
reached over SSH on a filtered guest network.

### First-boot ordering

Network first, binding second. They are independent and the box cannot register
before it has egress, so a box on wifi but unbound is a normal, expected,
resumable state — not an error. The LED must distinguish it, because the fix is
completely different: one needs the network re-done, the other needs someone to
scan a sticker.

## What this requires of the PCB and case

**This section is the time-sensitive part of the document.** These are
consequences of the setup flow, and a board laid out before they are decided
will have to be laid out again.

| Requirement | Why |
|---|---|
| **Status LED**, addressable RGB or two discrete | The only feedback channel with no screen. Must distinguish: provisioning / connecting / online-unbound / online-bound / error. Five states is the floor. |
| **Button**, reachable in the case, long-press | Forces re-provisioning without waiting out the fifteen-minute ladder. Recessed or stiff enough to survive a gym bag. |
| **Serial + QR on the case**, readable without disassembly | The binding path is a scan. A sticker on the underside of a board inside a sealed case is not a sticker. |
| **External wifi antenna** | BT and wifi are both continuously active in this product. The shared-antenna arrangement is already the known suspect for range. |
| **eMMC over SD** | A consumer cannot reflash a dead card. |
| **Secure element (ATECC608 or similar)** | Optional for v1, but only addable at board design time. Without it the per-unit secret is a readable file. |

## Testing

The provisioning logic must be testable without hardware, following the
precedent set by `pi/tests/test_netwatch.py` — 18 pure tests covering the whole
escalation ladder with no Pi, no radio, and no fifteen-minute wait.

- **State machine, pure.** unprovisioned → AP up → credentials received →
  joining → verified → registered, plus every failure edge back to AP mode.
- **Security-type branching.** Given a scan result, assert the right form and
  the right `nmcli` argv. Open-with-no-password is a required case, because it
  is what production runs on.
- **`nmcli` invocations are argv lists, never shell strings.** The pi control
  channel already set this rule and the reason is stronger here: these arguments
  contain a user-supplied wifi password.
- **The fake must be able to yield.** STATE.md records that `FakeStore.enqueue`
  was `async def` with no `await`, so it never suspended, so no test could
  observe an interleaving and a real duplicate-play race went undetected. A fake
  that cannot yield cannot model a concurrency bug — and this flow is all
  concurrency.
- **On hardware, once:** a real join to an open network, a PSK network, and a
  PEAP network; a wrong password; and a power-cut mid-write, which must not
  leave a box that neither connects nor returns to AP mode.

## Open decisions

Not blocking the spec, but each changes real work and none should be decided by
default:

1. **Is the AP open or password-protected?** Open is one less step; a printed
   PSK stops a neighbour from opening your setup page. The window is short and
   the page can only write wifi credentials, but it is a decision.
2. **Where does the device registry live?** The apex Worker's D1 is the obvious
   home, but that D1 currently belongs to Holy Cross. A cross-team registry is
   the first thing that genuinely does not fit "one Worker and one D1 per
   school," and it may be what forces the apex onto its own Worker.
3. **Who does manufacture-time provisioning, and how are secrets loaded?** A
   flashing jig writing serial + secret per unit is a real piece of tooling.
4. **Does the box need to work with no internet at all?** It is a Bluetooth
   speaker first. Playing music while unprovisioned, and syncing later off the
   existing outbox, is plausible and is a much larger change than it sounds.

## Out of scope

- BLE provisioning and any native app.
- Multi-box-per-team. One speaker, one room, one binding.
- Cellular fallback.
- OTA firmware updates — which this design will eventually require and which
  is a project of its own.
