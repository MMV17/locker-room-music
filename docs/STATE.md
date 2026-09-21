# Project state — resume here

Last worked: **2026-09-21**. Spec is `docs/spec.md`. Repo lives at
`~/Desktop/Home_Projects/locker-room-music.nosync` — the `.nosync` is
deliberate, see "Why `.nosync`" below.

**THE SPEAKER IS BEING REBUILT.** The old Pi 4B stopped booting on 2026-08-12
and **the BOARD was the failure, not the SD card** — read "The Pi 4B died"
below before diagnosing anything, because the obvious reading of that event is
wrong twice over. Replacement hardware arrived 2026-08-19: **Pi 4B + SanDisk
High Endurance 64GB + Argon ONE V2 case + CP2102 serial adapter.** See "What
was actually bought" and "The Argon ONE V2 case" below.

Nothing server-side was ever affected: both Workers, D1, and every player, play
and vote are untouched. What was gone is only the box in the room.

**THE CAMPUS FILTER IS BACK, AND IT BLOCKS THE WHOLE `auxgoat.com` ZONE** —
including `hc.auxgoat.com`, not just the apex. Re-measured 2026-08-08; see
"auxgoat.com is filtered" below. What works on campus right now:

| Hostname | Use |
|---|---|
| `https://locker-room-music.mmvinton17.workers.dev` | **the voting app** |
| `https://auxgoat.mmvinton17.workers.dev` | **the front door** (apex Worker) |
| `https://lockerroom.finestkindfarms.com` | also unfiltered; what the Pi points at |
| `https://hc.auxgoat.com` | **filtered on campus**, fine off it |

All seven build-order phases are done and deployed. Code is backed up to a
**private GitHub repo**, `git@github.com:MMV17/locker-room-music.git`, branch
`phase5-voting-site`.

**There are TWO Workers now** (since 2026-08-08). `auxgoat.com` is a real
landing page on its own Worker rather than a redirect to Holy Cross. See "The
apex is its own Worker" below — it explains why it could not stay on the team
Worker, which is not obvious and cost a deploy to discover.

**2026-08-05 was the first day it met real use, and everything below the
"first real UX walkthrough" heading came out of that.** The product now works
end to end with real songs, real artwork and real voting. What remains is a
session with actual teammates, not plumbing.

**Deploys take up to ~2 minutes to propagate — verifying immediately after
`wrangler deploy` tests the OLD worker.** This wasted real time twice; see the
section on it below before concluding a fix failed.

Build order status (spec section 10):

| # | Phase | Status |
|---|---|---|
| 1 | Pi is a working Bluetooth speaker | **Done, verified on hardware** |
| 2 | Listener logs to local SQLite | **Done, verified on hardware** |
| 3 | Worker + D1 + schema, deployed | **Done — deployed and verified in production** |
| 4 | Pi syncs to the Worker | **Done — 1,261 rows drained to production, 0 lost** |
| 5 | Voting site: join + now-playing | **Done — deployed, one real play recorded end to end** |
| 6 | Results reveal, leaderboards, rating math | **Done — deployed, not yet exercised with real votes** |
| 7 | Admin and device claiming | **Done — deployed; claiming exercised once** |

---

## The remote escape hatch (2026-09-21) — BUILT AND MERGED, NOT YET DEPLOYED

**On 2026-09-20 the speaker stopped accepting Bluetooth pairings and it could
not be fixed from off-site at all.** The box was online and beaconing, the
controller was healthy, the listener took commands and nobody was connected —
the adapter simply was not ADVERTISING, so no phone could see `AuxGoat 0001`.
Almost certainly `keep-discoverable` and/or `bt-agent` not running.

Everything about that was invisible from the Admin screen, and each reason is
worth keeping because each one is a separate hole:

- `report-status` checks `lockerroom-listener`, `bluetooth`, `bluealsa`. **None
  of those were the broken units**, and it never looks at `bt-agent`,
  `keep-discoverable`, `lockerroom-btwatch` or `hciconfig hci0` — whose
  PSCAN/ISCAN flags ARE the answer.
- No allowlisted command could restart the Bluetooth units.
- `lockerroom-btwatch` only fires when the controller is not `UP RUNNING`, so a
  healthy-but-silent adapter is exactly its blind spot.
- Admin.tsx rendered `result.split("\n")[0].slice(0, 40)`, so even the service
  states that WERE collected never reached a human.

**Two new allowlisted commands**, on both gates (`PI_COMMANDS` in
`backend/src/piControl.ts`, `ALLOWED` in `pi/lockerroom/control.py`), each with
its own timeout, and still nothing anywhere that takes a parameter:

| command | what it does |
|---|---|
| `report-full` | Read-only dump: `is-active` AND `is-enabled` for all nine units, `hciconfig hci0`, `audio-check.sh`, `nmcli`, `ip route`, `/etc/resolv.conf`, dmesg and a journal tail per unit. **Allowed mid-song** — it writes nothing. |
| `run-repair` | Pulls the repo on the Pi and runs the committed `pi/scripts/remote-repair.sh`. **Refused mid-song**, like a scan. |

**`is-enabled` is in there deliberately.** Units coming up disabled after a
reboot has bitten this project three times — bt-agent and keep-discoverable
missing from every deploy until 2026-08-19, the listener never enabled until
the same day, netwatch deploys silent no-ops until 2026-08-09. An
active-but-disabled unit works perfectly until the next power cut.

**HOW `run-repair` TAKES A "PARAMETER" WITHOUT TAKING ONE.** What varies is the
COMMIT YOU PUSHED. Write the fix into `pi/scripts/remote-repair.sh`, commit,
push, press the button. The allowlist still maps a fixed name to a fixed argv
on both ends and there is still no "run this string" command.

**RUN-REPAIR MUST NEVER MODIFY THE LISTENER PACKAGE, and this is enforced
rather than asserted.** The listener IS the control channel; a mechanism that
can replace it can destroy remote access while using it. `run-repair.sh`
snapshots `/opt/lockerroom/lockerroom` before the repair and, if the repair
changed it, RESTORES the snapshot and restarts the listener.
`pi/tests/test_run_repair_guard.py` drives the real script and proves an edit,
a deletion and an added file are each undone. Listener code changes still need
a shell — that is the point.

**The dump does not travel in `pi_commands.result`**, which the beacon handler
cuts to 2000 characters. It rides its own beacon payload into a new
`pi_reports` table (migration 007), following the `bt_devices` precedent from
005 exactly. Keyed by kind, so a repair log does not overwrite the diagnostic
that justified running it. Capped at 64 KiB on both ends, and **a cut is
ANNOUNCED inside the body** — silent truncation is the failure this exists to
stop repeating.

### Deploy state, 2026-09-21

| piece | status |
|---|---|
| Code | **Merged to `main`** and pushed to origin. 275 pi tests, 109 backend, clean build. |
| Migrations 006 + 007 on prod D1 | **APPLIED 2026-09-21**, after a verified backup (92,891 bytes, 244 INSERTs, at `~/lockerroom-backups/`). Both are a single additive `CREATE TABLE IF NOT EXISTS`; 127 plays confirmed intact afterwards. |
| Worker | **DEPLOYED 2026-09-21**, version `c8ab305d-968a-4273-94d8-6c138693024b`. |
| Pi | **DEPLOYED 2026-09-21 OVER THE SERIAL CONSOLE.** It was not reachable by any network path - nothing answered on `auxgoat`, `192.168.2.3`, `192.168.2.2` or `192.168.1.6`, no `192.168.2.x` interface was up, Internet Sharing was off, no Pi MAC in the ARP table, and this Mac was on `10.6.14.79` rather than the home LAN. `pi/scripts/serial-deploy.py` shipped it anyway. |

**ORDER MATTERS AND IT WAS FOLLOWED: migrations BEFORE the Worker.**
`throttle.ts` queries `auth_attempts` on every failed admin auth, so deploying
the Worker first would have 500'd the admin login until the table existed.

Verified live after propagation (which takes ~2 minutes — checking sooner tests
the OLD worker):

- the new build is served (`index-EthrsOHQ.js`), `/api/theme` returns JSON on
  both hostnames
- **the throttle works end to end**: one deliberately wrong admin password
  returned `401 application/json`, not a 500, and wrote
  `admin:<ip> count=1` to `auth_attempts`. That test row was then deleted, so
  the table is empty and the budget is full.
- `.DS_Store` is still not served — both paths answer `200 text/html`, which is
  the app shell. **Check the content-type, never the status**, or this looks
  like a leak that is not there.

### THE ADMIN SCREEN IS NOW AHEAD OF THE BOX

The `report full` and `run repair` buttons are live on the deployed site, and
**the Pi will refuse both until it is deployed** — its `ALLOWED` dict does not
have those names yet, so it answers `refused: 'report-full' is not an allowed
command` and the row goes red. That is harmless and self-correcting, but it
will look like the feature is broken. It is not; the box is simply behind.

To finish, from a network that can reach it:

```bash
pi/scripts/deploy.sh pi@auxgoat          # home wifi
pi/scripts/deploy.sh pi@192.168.2.3      # USB-C ethernet + Internet Sharing
```

### OR OVER THE SERIAL CONSOLE, WITH NO NETWORK AT ALL

`pi/scripts/serial-deploy.py` ships the listener modules and the scripts over
the CP2102 console. Written 2026-09-21 because the box was powered and healthy
with its console answering, and no IP path existed to it — which is exactly the
situation the escape hatch is for, and it could not be installed.

```bash
python3 pi/scripts/serial-deploy.py --dry-run   # plan; opens no port
python3 pi/scripts/serial-deploy.py             # prompts for the password
```

39 KB gzip+base64, about 150 chunked writes, roughly a minute. It is NOT a
replacement for deploy.sh — no systemd units, no udev rules, no audio
verification — so use deploy.sh whenever an IP path exists.

**Every file is sha256-verified ON THE BOX before it is installed**, and
nothing is restarted if any hash disagrees. A serial line has no flow control
and drops bytes; a deploy that cannot prove what landed is not a deploy. The
far side also gets `stty -echo` (restored afterwards), which halves the traffic
and is what makes the output parseable at all.

**The serial console works.** Verified 2026-09-21 at 115200 on
`/dev/cu.usbserial-0001` — a bare CR returned `auxgoat login:`. So the box is
powered and the CP2102 is attached; what is missing is an IP path, which is
what `deploy.sh` needs. Plug in the USB-C cable and turn on Internet Sharing,
or use home wifi.

**`deploy.sh` now installs the escape hatch** — `report-full.sh` and
`run-repair.sh` into `/usr/local/bin`, seeds `remote-repair.sh` into
`/opt/lockerroom/repo` when no git clone is there yet, prints the clone command
when it is missing, and verifies all three landed. **No new systemd units**, so
there is nothing new to enable.

**`run-repair` works before that clone exists** — it reports loudly that it
could not pull and runs the script already on disk. Refusing to run the
last-known repair because the network is also unwell would make the button
useless exactly when it is needed. To finish the job properly:

```bash
sudo git clone ssh://git@ssh.github.com:443/MMV17/locker-room-music.git \
  /opt/lockerroom/repo && sudo chown -R pi:pi /opt/lockerroom/repo
```

---

## The first real report found the box DEAF — and two bugs in the tooling (2026-09-21)

The escape hatch was deployed over serial and exercised the same hour. It
worked: `report-full` round-tripped **20,732 bytes in 1.2 seconds**, which
under the old path would have been cut to 2000 characters and displayed forty
at a time. Then it immediately earned itself back three times over.

### The box could not be paired with, and every unit was green

`hci0` was **DOWN**, `Powered: no`. Not the 2026-09-20 fault (up but not
advertising) — the adapter was not up at all. The beacon was perfectly
healthy the entire time, which is exactly why nobody had noticed.

The cause, and it is the thing to check first from now on:

```
933: hci0: Bluetooth
	Soft blocked: yes
	Hard blocked: no
```

**An rfkill SOFT BLOCK.** The radio is switched off in software. `systemctl
restart bluetooth`, `bt-agent`, `keep-discoverable` — none of it does anything,
because none of it is the problem. `rfkill unblock bluetooth` is.

**`report-full.sh` did not collect `rfkill`.** The one diagnostic built to
explain a dead adapter showed the symptom and withheld the cause. It leads the
adapter section now, and `remote-repair.sh` unblocks before it tries anything
else.

### THE REPAIR RESTARTED THE LISTENER AND LOST ITS OWN LOG

Worse, and worth understanding properly:

```
lockerroom-listener.service:  Requires=bluetooth.service
```

systemd **propagates a restart across `Requires=`**. So `systemctl restart
bluetooth` inside the repair restarted `lockerroom-listener` — the control
channel — in the middle of the command it was running. The first run-repair,
the one that diagnosed the rfkill block, **never reported at all**: dispatched,
never completed, and the listener journal shows it stopped and started while
the command was in flight.

This is the "a mechanism that can replace the listener can destroy remote
access while using it" rule arriving by a road that was not guarded. The
package was protected from being MODIFIED and left wide open to being
RESTARTED out from under itself. Restoring a snapshot does nothing about that.

**So `bluetooth` is out of the repair's restart list.** If the adapter is still
down after unblocking, it is restarted as a last resort with
`--job-mode=ignore-dependencies`, which is the exact flag that suppresses the
propagation. Five regression tests in `pi/tests/test_run_repair_guard.py` read
the shipped scripts as text and hold this — including one asserting the
`Requires=` line still exists, so if that ever changes the rule gets
re-examined rather than silently kept or silently dropped.

**The general lesson, which is bigger than this script:** before restarting
ANY unit from a remote repair, check what `Requires=` it. A unit test of Python
would not have caught this and did not. Running it against the real box did,
within minutes.

### ROOT CAUSE: btwatch rebound into the block, 212 times

Established from the box's own journal, and worth reading before touching the
watchdog.

**09:59:22** — the adapter became unpowerable. `bluetoothd` began logging
`Failed to set mode: Failed (0x03)` every five seconds, and the box had been up
since 09-20 with none before that. That is `MGMT_STATUS_NOT_POWERED`: an rfkill
soft block.

**What set it is NOT established.** Nothing precedes it in the journal — no
kernel error, no command, no reboot. Do not let anyone tell you it was the
relay: the first `relay speaker ... did not connect` is at **09:59:43**,
twenty-one seconds AFTER, and all 1,270 of them follow it. That was a
consequence.

**Why it never recovered is fully established, and is the fixable part:**

1. `btwatch` saw `hci0` was not `UP RUNNING` and rebound `hci_uart_bcm`.
2. A rebind **destroys the rfkill device and creates a new one** — the index
   climbed 933 → 934 → 935 across three observations an hour apart.
3. `systemd-rfkill` keys its saved state by the device's platform name and
   faithfully **restored the block onto the new device**.
4. So every recovery re-applied the fault it was recovering from. **212
   rebinds over nine hours.** The kernel reloaded the BCM4345C0 firmware
   perfectly every single time.

**It would have survived a reboot**, for exactly the same reason. That is the
part worth remembering: this was not a transient, and power-cycling the box
would not have cleared it.

`provision.sh` ALREADY KNEW a fresh registration can come up blocked — it
documents it from 2026-08-19 on a stock Trixie flash, and unblocks once at
provision time. What nobody noticed is that **every rebind is a fresh
registration.**

`btwatch.sh` now unblocks before tearing the driver down (and if that is all
that was wrong it recovers without restarting anything) and again after
rebinding. It also backs off after five failed recoveries: the loop was not
free — 44s of CPU, `bt-agent` SIGKILLed on stop timeouts repeatedly, and
`lockerroom-listener` restarted every couple of minutes, **which is what lost
the first run-repair's log.**

**Two traps for whoever touches the watchdog next:**

- `btwatch.sh` restarts `lockerroom-listener` by design, so the control channel
  dies on every recovery and in-flight commands lose their result. That is
  deliberate — handles have to re-bind to the new adapter — but it means a
  wedge and a remote command at the same moment will not report.
- A rebind cannot clear a soft block. If `hciconfig` says DOWN, check
  `rfkill list bluetooth` BEFORE anything else.

### RESOLVED, entirely over the 443 beacon

With both fixes deployed, `run-repair` cleared the block and the box came back:

```
    before:  935: hci0: Bluetooth   Soft blocked: yes
    after:   935: hci0: Bluetooth   Soft blocked: no
    adapter is up - leaving bluetooth.service alone.
```

and the confirming `report-full` reports the line this whole feature exists
for:

```
hci0:  Type: Primary  Bus: UART
       UP RUNNING PSCAN ISCAN
```

**The listener beaconed straight through it** — 19:13:32 and 19:13:37, no
restart. Diagnosed, fixed and confirmed without touching the box, which is
precisely what could not be done on 2026-09-20.

**Two things in that report that are NOT faults, so nobody chases them:**

- `lockerroom-audio-route  inactive  enabled` is correct. It is `Type=oneshot`
  with no `RemainAfterExit`, so it runs at boot, exits, and reports inactive
  forever after. Green would be the surprising answer.
- `relay_connected = 0`, `relay_error = connect failed`, output on
  `jack:Headphones`. The configured JBL (`5C:AD:BA:F0:B2:61`) is not answering
  — almost certainly powered off. Worth retrying now the radio is unblocked,
  since before this it could not have connected under any circumstances.

## Six holes closed (2026-09-08, committed 2026-09-21)

This sat uncommitted in the working tree for thirteen days. Two of the six are
security holes and one is a data leak, so it is worth knowing they were ever
open in case anything from that window looks wrong.

- **No rate limiting anywhere.** `/api/admin/*` took unlimited `ADMIN_PASSWORD`
  guesses with no lockout and no record that anyone had tried. The counter is a
  D1 table rather than a Cloudflare binding because `apex/wrangler.toml` holds
  the measurement proving the binding never bound: `[[unsafe.bindings]]`
  deploys cleanly and does nothing — 72 wrong codes from one IP, zero 429s —
  and `[[ratelimits]]` is ignored outright by wrangler 3.114. **Only FAILURES
  are counted**, which is what makes a limit this low safe behind one school
  NAT. Admin 10 per 5 min; team code 30 per 10 min.
- **The leaderboards leaked live vote tallies.** They filtered on
  `counted = 1 AND voided = 0`, and **`counted` DEFAULTS to 1 at INSERT**, so a
  play still on the speaker already qualified. Not a hint — the board returns
  `voters` and `score`, so `up - down = score * (voters + TRACK_K)`, and with
  `up + down` known both fall out. On a track's first play the board row IS
  that open play.
- **Membership was checked only at sign-in.** Deactivating a player left every
  session they already held fully authorized; they kept voting until they chose
  to sign out.
- **A paused song was closed on wall-clock time.** The duration watchdog slept
  for duration + buffer from the song's start, and pausing never touched it —
  so a song paused a few seconds in had its play record ended, its vote window
  shut and aux ownership released with the audio still on the speaker. A 200ms
  fixture closed at `played_ms=61`. Measured in PLAYED ms now.
- **Claiming a phone had a race.** `AND user_id IS NULL` is what settles it, and
  it must stay OUTSIDE the batch — a batch's later statements run whether or not
  the first matched, so the loser would still have backfilled the play history
  to itself.
- **No sign out / switch user** in Settings. There is now.

---

## styles.css has an ordering rule now — read before appending (2026-09-21)

`web/src/styles.css` ends with the short-screen overrides, and **they must stay
last**. They used to sit above the base rules they override, and since both
sides had the same specificity the later base rule simply won — four of them
were dead, and `.vote` kept a 96px target instead of shrinking to 84px at
375x667.

The block says so itself: *"Anything added below this block will silently
defeat it again."* This already caused the one merge conflict between the two
2026-09-21 branches, and the resolution is not arbitrary — new rules go ABOVE
that block. Check the order after any merge that touches this file.

---

## The ethernet cable POISONS DNS and makes wifi look dead (2026-08-31)

**The USB-C ethernet cable does not just hijack the default route — it breaks
name resolution for the whole box, and the result looks exactly like dead
wifi.** This nearly caused a spurious reboot tonight and probably caused a real
one earlier in the evening.

`deploy.sh`'s header already warns that the cable creates a
`default via ... dev eth0 metric 100` route that beats wlan0. **This is the
second, worse half of that trap, and it was not written down.**

With the cable in, `/etc/resolv.conf` becomes:

```
nameserver 192.168.2.1              <- the Mac. Dead. FIRST.
nameserver fe80::...%eth0           <- the Mac again. Dead.
nameserver 10.104.116.10            <- campus. WORKS. Third.
nameserver 1.1.1.2                  <- past the limit
# NOTE: the libc resolver may not support more than 3 nameservers.
```

**The Mac answers DNS queries and fails them.** glibc takes that as an
authoritative answer and never falls through to the campus resolver, so every
lookup dies in ~7ms. Not a timeout — an instant bad answer, which is why it
does not look like a network problem.

### What it looks like, and why that is dangerous

Every symptom points at the wifi:

- `curl https://lockerroom.finestkindfarms.com` -> `000 in 0.007s`
- the netwatch probe fails, logging `offline — no egress on wlan0`
- **netwatch then escalates: bounce at 5 min, restart NetworkManager at 10,
  REBOOT at 15** — for a fault that is entirely caused by the cable
- pinging the wifi gateway also fails, which seems to confirm it (campus simply
  blocks ICMP to the gateway; this is normal and not a fault)

### The proof that wifi was fine all along

Bypass DNS and the link is healthy:

```
curl --interface wlan0 https://1.1.1.1/      -> 301 in 0.090s
DoH resolve -> 172.67.176.87
curl --interface wlan0 --resolve ...         -> 200 in 0.068s
```

**67 milliseconds to production, on the wifi that every other check called
dead.**

### FIXED PERMANENTLY (2026-08-31)

The cable no longer does either harmful thing. On the Pi:

```bash
sudo nmcli connection modify "Wired connection 1" ipv4.ignore-auto-dns yes
sudo nmcli connection modify "Wired connection 1" ipv6.ignore-auto-dns yes
sudo nmcli connection modify "Wired connection 1" ipv4.never-default yes
sudo nmcli connection up "Wired connection 1"
```

Result, verified:

```
resolv.conf:    nameserver 10.104.116.10    <- campus only, the Mac is gone
default route:  via 10.104.224.1 dev wlan0  <- the cable no longer wins
production:     200                          <- was 000
ssh over cable: still 192.168.2.3            <- access retained
```

**This kills the documented route-hijack trap in `deploy.sh`'s header as well as
the DNS one.** The cable is now purely an access path: it carries ssh and
nothing else, and cannot make a healthy box look broken. Settings persist, so
this holds across reboots and future sessions.

The warnings below are kept because they describe what the symptom looks like
if this ever regresses, or on a box that has not had these settings applied.

### How to apply

- **Unplug the ethernet cable when finished.** This is not housekeeping; leaving
  it in gives a box with no DNS and a watchdog counting toward a reboot.
- **Never diagnose wifi with the cable plugged in.** The diagnostic tool
  manufactures the symptom.
- Test egress with `--interface wlan0` **and** an IP address, never a hostname,
  or you are testing the Mac's DNS.
- `iw` is NOT installed on this box. `iw dev wlan0 link` returns
  `command not found`, and a naive `|| echo "not associated"` fallback then
  reports the wifi as down when it is up. Use `nmcli` and `ip route`.

## Wifi is now locked to 5GHz (2026-08-31)

```bash
nmcli connection modify HCGuest 802-11-wireless.band a
```

**HCGuest on channel 52 (5260 MHz), signal 43, negotiated at 270 Mbit/s.**
Compare the 2026-08-23 relay test, which ran on **channel 11 (2462 MHz) at 5.5
Mbit/s** — an 802.11b rate burning enormous airtime in the same band, on the
same chip and antenna, that Bluetooth hops through.

That is roughly a **50x better link on a band Bluetooth does not use**, and it
frees 2.4 GHz entirely. **This answers the go/no-go in the Bluetooth relay
spec**: the airtime problem that killed the relay has a free fix and it works.
The relay still needs its stuttering re-tested on hardware, but the premise
holds.

Signal is weaker than 2.4 GHz was, which is the correct trade here: the audio
path does not use wifi at all, and the outbox is store-and-forward, so a weaker
link means plays sync late rather than music stopping. Watch that netwatch does
not start bouncing a merely-weak link.

## USB to the Charge 6 works, CONDITIONALLY (2026-08-31) — cable AND charge

**Two variables, both real, and they stack. Charge is the dominant one.**
An earlier version of this section said "IT WAS THE CABLE — RESOLVED." That was
half the answer and is corrected here.

| cable | charge | port | result |
|---|---|---|---|
| A | same as B's run, 13 min apart | `1-1.3` and `1-1.1` | dies ~5s, 8 over-current events |
| B | same as A's run | `1-1.1` | **ran indefinitely** |
| B | ~90% | `1-1.1` (blue) | dies ~4s, 24 events |
| B | full | `1-1.3` (black) | stable |
| B | full | `1-1.1` (blue) | **stable, music playing, 0 events** |

**The working combination is cable B plus a topped-up speaker.**

### The port is NOT a variable — tested, ruled out

The speaker was moved to a black USB2 port and came up; the obvious reading was
that the port fixed it. It did not. Moved back to the **same blue port that had
killed it at 90%**, at full charge, it plays fine with zero over-current. All
four ports share one budget behind the VL805 hub, which is why over-current is
reported on all of them in the same instant. Do not chase the port again.

### Why charge is a cliff and not a slope

Li-ion charging runs at full constant current until the cell is nearly full,
then tapers hard to almost nothing. So there is no gradual middle:

- **full** — charger tapered to ~0, only the harmless 100mA USB load remains
- **90%** — charger back at full constant current, hub trips in ~4 seconds

Ten percent is enough to cross it. This is why the same cable in the same port
can look perfect one hour and hopeless the next.

### The draw is INVISIBLE to USB — this is why nothing in software saw it

There are two separate power stories in one cable, and only one of them is USB:

- **The USB one.** `bMaxPower` reads **100mA**, captured live from the
  descriptor. Granted, honoured, never a problem. Linux logs `rejecting
  insufficient power` when a device declares more than a port can give, and
  **that message has never appeared on this box, for any device.** The speaker
  never asked for more.
- **The charging one.** The battery charger, governed by the **CC resistor in
  the USB-C cable**, entirely outside the USB protocol. Nothing enumerates it,
  nothing declares it, and the kernel cannot see it coming.

The compliant CC value for a USB-A host is **56kΩ = 500mA**; cheap cables often
ship **10kΩ (3A)** or **22kΩ (1.5A)**. A USB-A host has no CC pin, so **this is
not diagnosable in software** — only by swapping cables or metering the plug.

Corollary: `bMaxPower` is useless as a diagnostic here. It describes the audio
function, not the charger.

### Audio load is NOT a factor

Ruled out cleanly. Every early failure happened with the PCM state `closed` —
the amp never drew a watt. And at full charge the PCM ran for minutes:

```
  0s  yes  yes  closed    OC 0   usb:J6
 28s  yes  yes  RUNNING   OC 0   usb:J6   <- music started
260s  yes  yes  RUNNING   OC 0   usb:J6   <- still clean, on the blue port
```

### Practical rule for a session

**Use the known-good cable and charge the speaker beforehand.** If it drops a
few seconds after plugging in, that is not a fault — it is telling you the
battery is low.

One unproven observation worth knowing: after failing, the speaker was left
plugged in and came back on its own about two minutes later, apparently having
trickled up through the hub's retry cycle. **Confounded** — the port was moved
at the same moment — so treat it as a lead, not a fact. If it holds, "leave it
plugged in for two minutes" is a free workaround.

### The harness

`/tmp/usbmon.sh` logged one line per second (device present, card present, PCM
state, over-current delta, routing) and is what made all of the above
separable; `/tmp/cable-test.sh` did the single-shot A/B. **`/tmp` is cleared on
reboot** — rewrite them from this section if needed. Run them with
`systemd-run --unit=... --collect`, not `nohup ... &` over ssh, which does not
survive the session closing.

### What this means for the product

USB to this speaker is **conditional, not dependable**. It needs one specific
cable and a battery that will be draining during exactly the use it is needed
for. That is the reason the Bluetooth relay is worth speccing after all — see
the relay design doc — because it removes the cable, the CC resistor and the
charging current from the problem entirely.

## The box now follows the cable (2026-08-28) — USB if present, else the jack

**Written, tested, committed on branch `audio-output-routing`. NOT YET DEPLOYED
to hardware.** Design doc:
`docs/superpowers/specs/2026-08-28-audio-output-routing-design.md`.

The two sections below leave the speaker problem in an awkward place: some
speakers take only a 3.5mm aux jack, the Charge 6 takes only USB-C digital
audio, and choosing between them meant hand-editing `/etc/asound.conf` on a box
campus makes hard to reach. `audio-route.sh` now does it automatically, from
udev on every cable plug and at boot.

**The rule is one-sided, and that is not a design choice.** The Pi 4's 3.5mm
jack has **no jack-detect pin** and exposes no jack kcontrol, so nothing on this
box can tell whether a cable is in it. Do not go looking for a way; there isn't
one. USB is completely detectable — the speaker enumerates as its own ALSA card
and udev fires on plug and unplug. So:

> **USB playback card present → use it. Otherwise → the analog jack.**

The jack is a *fallback*, not a detection, which is also the safe direction.

**Three things here contradict what is written further down this file, and the
code is what is now true:**

| Older note | Now |
|---|---|
| "`provision.sh` writes `/etc/asound.conf`" | **`audio-route.sh` is the ONLY writer.** `provision.sh` calls it; the duplicate heredoc is gone so the two cannot drift. |
| "deploy is READ-ONLY, it never writes `asound.conf`" | Deploy now runs `audio-route.sh`. The *reason* for the old rule still holds and is still honoured: an unmarked, hand-written config is left strictly alone. |
| "never pass `-D` to `bluealsa-aplay`" | **Still true, and now load-bearing for a second reason.** Routing rides the ALSA *default*, so `audio-check.sh --tone` follows it automatically. Under `-D` the tone would test the jack while real audio went to USB — blinding the one diagnostic this project has. |

**Two ideas that look right and are not:**

- **Send audio to both outputs at once.** ALSA's `multi` opens *all* of its
  slaves or none, so an unplugged USB cable takes the working jack down with
  it — silence on every output with all units green, this project's signature
  failure. Two free-running card clocks also drift into xruns. And it saves
  nothing: building the config needs the same USB detection anyway.
- **A pure `asound.conf` that falls back on its own.** There is no such thing.
  ALSA config has no runtime conditional and cannot test whether a card exists.

**What to check when the room is silent:** `cat /run/lockerroom/audio-out` says
which output was chosen (`usb:Charge` or `jack:Headphones`). `/run` is tmpfs, so
that file missing on a box that has the script means the unit did not run —
`systemctl status lockerroom-audio-route`. `audio-check.sh` reports all of this
and now asserts against the **selected** card rather than the analog one.

**`deploy.sh`'s audio verification had to change and it was not optional.** It
hard-checked the *analog* card's PCM status, so a correctly-selected USB speaker
would have made every deploy print **"THIS BOX WILL BE SILENT"** on a healthy
box — lying in the most alarming direction, on the one check that exists because
nobody can tell silence from health by looking at the units.

**Deliberately deferred:** reporting the selected output in the heartbeat, so
the admin screen shows it. The failure this feature introduces is "it picked the
wrong output," which is invisible from the room. `/run/lockerroom/audio-out`
exists as the hook for that work.

## The speaker side: the JBL Charge 6 has NO analog input (2026-08-21)

A 3.5mm-to-USB-C cable was tried into a **JBL Charge 6** and produced nothing.
That is not a fault to diagnose — **it cannot work, and no cable will make it
work.**

- **The Charge 6 has no 3.5mm aux input.** JBL dropped aux from the Charge line
  at the Charge 5 and did not bring it back.
- **Its USB-C port is USB *digital* audio**, not analog. It enumerates as a USB
  Audio Class device on a USB *host*. A passive 3.5mm-to-USB-C adapter assumes
  the sink implements analog Audio Adapter Accessory Mode. The Charge 6 does
  not, so the adapter connects the Pi's output to nothing at all.

**Nothing was damaged, and this is worth being explicit about because the
instinct is to assume it was.** That adapter is a passive wire into a port that
never asserted anything: no VBUS, no signal, an open circuit. Even in the bad
case, VBUS does not route to the analog pins in a passive adapter, the Pi's
headphone output is AC-coupled so series capacitors block DC anyway, and the
output stage is short-circuit tolerant. **Two audio outputs facing each other
across a dead adapter is the most boring possible failure.** Prove it in 30
seconds with wired headphones in the case's rear jack and `audio-check.sh
--tone`.

### A second speaker, WITH an aux input, was also silent

**This is the important half of the evidence and it arrived after the Charge 6
finding.** A different speaker that does have a 3.5mm aux input produced
nothing either. So the Charge 6's missing analog input explains that one
attempt and **does not explain the fault** — no audio reaches *any* speaker,
which puts the fault upstream of every speaker: the Pi, its ALSA config, the
case's rear jack, or the cable.

That was entirely consistent with "the ALSA default was never set" below, which
was then the leading hypothesis — every attempt so far had swapped speakers and
cables rather than looking at what the Pi was doing. Two speakers is not two
data points about the Pi; it is one.

**CONFIRMED 2026-08-22 over the serial console, and fixed. The audio works.**
See "CONFIRMED (2026-08-22): the ALSA default was an unopenable HDMI card"
below. The relay workaround for the Charge 6's missing aux input was tested
on 2026-08-23 and rejected — see the next section.

## THE RELAY IS BUILT AND RUNNING (2026-08-31)

**Plan 1 is done, deployed, and verified on hardware.** The Pi now plays
through a Bluetooth speaker it connects to itself. No cable, no CC resistor, no
charging current, no per-speaker input type.

Plan: `docs/superpowers/plans/2026-08-31-bluetooth-relay-pi-side.md`.
Design: `docs/superpowers/specs/2026-08-31-bluetooth-relay-output-design.md`.

### The log line that matters

The 08-23 blocker was the listener granting the far speaker the aux. Fixed:

```
19:25:42  lifecycle: relay speaker connected: JBL Charge 6  - not a session
19:26:03  relay:     relay speaker connected: 78:66:F3:1C:9D:B6
19:26:53  lifecycle: session open: Mack's iPhone
19:26:53  lifecycle: aux granted to Mack's iPhone
19:26:59  play opened: Treaty Oak Revival - One Time Thing
```

The speaker is excluded by identity; the phone is a DJ and gets the aux.
Measured under playback: **0 underruns, 0 relay disconnects, controller
`UP RUNNING`, plays recorded and synced.**

### How output is chosen now

```
USB audio card present?       -> USB speaker   (ALSA default)
else relay speaker connected? -> BT relay      (-D on the player)
else                          -> 3.5mm jack    (ALSA default)
```

`audio-route.sh` is still the only arbiter. The wired paths are unchanged.

### The one rule that had to bend, and how it was made safe

The wired outputs are chosen by the ALSA default and `bluealsa-aplay` gets no
`-D`. **The relay cannot work that way** — its output is a bluealsa PCM. So the
drop-in gained `$AUX_DEV` from a second `EnvironmentFile`, using the same
unbracketed-variable trick as `$AUX_MAC`: unset, systemd drops the argument
entirely and the player runs bare on the wired default.

**Verified on the box with the speaker switched off:**

```
audio-out:      jack:Headphones
relay-target:   (absent)
output.env:     (absent - player runs bare)
ALSA default:   opens OK
```

A configured relay whose speaker is missing degrades to a working wired
speaker, never to silence.

**THE COST, and it is real:** while relaying, `audio-check.sh --tone` tests the
ANALOG DEFAULT, which is *not* the live path. The script now says so loudly and
points at the relay checks instead. Do not trust a tone in relay mode.

### Configuration

Off by default. With no `[relay]` table every path behaves exactly as before,
and there is a test asserting that specifically.

```toml
[relay]
speaker_mac = "78:66:F3:1C:9D:B6"
```

Pair once by hand first (`bluetoothctl pair` + `trust`). A malformed MAC stops
the listener with a clear message rather than silently disabling the relay.

### Known: one idle disconnect

The speaker dropped once ~30s after power-on, before any music, and the
reconnect loop recovered it unattended. Zero drops once playback started.
Leading theory: `bluealsa-aplay` opens the output PCM lazily, so with no phone
streaming the A2DP transport has no user and idles out. Not chased further
because the reconnect loop makes it invisible — but if it ever becomes a
symptom, that is the first place to look.

### New pieces

| File | Role |
|---|---|
| `pi/lockerroom/macaddr.py` | The one place that decides what a MAC is. Dependency-free **on purpose**: `config.py` imports `tomllib` (3.11+) and is unimportable in the laptop's 3.9 venv, so validation living there would be testable nowhere. |
| `pi/lockerroom/relay.py` | Owns the outbound link and nothing else. |
| `pi/scripts/btwatch.sh` | Recovers a wedged controller without a reboot. Worth having even without the relay. |

**Still to do — Plan 2:** the admin UI to scan for speakers and pick one, over
the existing `pi_commands` channel. Until then the speaker is set by the config
key above.

## THE RELAY WORKS (2026-08-31) — the 08-23 NO-GO is overturned

**Tested on hardware, on 5GHz, and it is clean.** The section below this one
concluded NO-GO on 2026-08-23. That conclusion was wrong, and the reason is
worth understanding: it was never a Bluetooth problem. It was **wifi crawling
at an 802.11b rate inside Bluetooth's own band.**

Same one command as before — nothing built, nothing on disk:

```bash
sudo systemctl stop bluealsa-aplay
bluealsa-aplay -D bluealsa:DEV=78:66:F3:1C:9D:B6,PROFILE=a2dp
```

| Measure | 2026-08-23 (2.4GHz) | 2026-08-31 (5GHz) |
|---|---|---|
| Stuttering | persistent, with dropouts | **none, audibly clean** |
| ALSA underruns | 5 | **0** |
| Controller | **WEDGED**, `HCI_Reset` -110 | `UP RUNNING`, **0 failures** |
| wifi link | ch 11, **5.5 Mbit/s** | ch 161, **270 Mbit/s** |

Both links ran simultaneously on the one radio — `JBL Charge 6` and the phone —
and the rate mismatch resolved itself exactly as documented before:
`48000 Hz -> 44100 Hz`, no resampling, no `plug:` wrapper.

**The single change that did it was `nmcli connection modify HCGuest
802-11-wireless.band a`.** Nothing else. See the 5GHz section above.

### Anti-bypass: VERIFIED on the relay path too

**While the Pi holds the JBL over Bluetooth, nothing else can connect to it.**
Tested directly. The speaker accepts one A2DP connection and the Pi owns it, so
`spec.md` §2's enforcement premise holds on this path as well.

This is the **strongest** of the three enforcement mechanisms:

- **aux jack** — defeated by pulling a cable
- **USB audio mode** — defeated by a Play/Pause hold and a replug
- **relay** — the Pi holds the slot, and can *actively reconnect* if displaced.
  There is no physical action that frees the speaker while the Pi is running.

### What this means

The relay is now the best output path, not the fallback: it needs no cable, no
CC resistor, no charging current, and no per-speaker input type — and it works
with any Bluetooth speaker, which is nearly all of them.

The design is specced at
`docs/superpowers/specs/2026-08-31-bluetooth-relay-output-design.md`. Its
go/no-go (step 2 of the hardware test plan) is the test recorded here, and it
passed. **The remaining work is software only**: teaching `lifecycle.py` that
the far speaker is a sink and not a DJ, the output-mode plumbing, reconnect
logic, and a Bluetooth watchdog.

**Longevity is not yet proven.** This was a run of minutes, and the 08-23 wedge
happened "shortly after" rather than immediately. Run a full session before
trusting it unattended.

## The Bluetooth relay to the JBL: tested 2026-08-23, NO-GO — SUPERSEDED, see above

Because the Charge 6 has no analog input (above) and the USB-A-to-USB-C cable
its wired mode needs was not on hand, the obvious idea is to make the Pi relay:
accept the phone as an A2DP **sink**, then re-transmit to the JBL as an A2DP
**source**, both on the one radio. **It works, and it is not usable.** Tested
end to end over the serial console; nothing was left behind.

**JBL Charge 6 MAC: `78:66:F3:1C:9D:B6`** (pairing has since been removed).

Two things were easier than expected, and are worth knowing if this ever comes
back up:

- **`bluealsa` already runs `-p a2dp-source -p a2dp-sink`.** No drop-in is
  needed and `/etc/systemd/system/bluealsa.service.d/` does not exist. Any
  instructions telling you to add one are working from a wrong assumption.
- **The rate mismatch resolves itself.** The phone captures SBC at 44100 and
  the JBL advertises 48000, but bluealsa renegotiates the sink down
  (`Changing BlueALSA PCM configuration: 2 ch, 48000 Hz -> 2 ch, 44100 Hz`), so
  the plain `-D bluealsa:DEV=...` form works and **no `plug:` wrapper and no
  resampling are involved.** The whole relay is one command that touches no
  file on disk:

```bash
sudo systemctl stop bluealsa-aplay
bluealsa-aplay -D bluealsa:DEV=78:66:F3:1C:9D:B6,PROFILE=a2dp
```

### Why it is a no-go: airtime, not tuning

Audio arrived, latency was tolerable, and there was persistent stuttering with
brief dropouts. The instinct is to tune buffers. **The evidence says do not
bother**, because nothing on the Pi was struggling:

| suspect | measurement | verdict |
|---|---|---|
| CPU / double SBC transcode | `top`: **97.9% idle** | not it — the transcode is free on a Pi 4 |
| ALSA buffering | **5 underruns** in the whole run | not it — our side kept up |
| the air | see below | **this is it** |

Samples were being lost *between radios*, not inside the box. wifi was
associated to HCGuest on **channel 11 (2462 MHz) at -64 dBm, negotiated down to
5.5 Mbit/s** — an 802.11b rate, burning enormous airtime to move almost
nothing, on the same antenna and the same 2.4 GHz band Bluetooth hops through.
Add two simultaneous A2DP links to that one radio and there is no headroom
left. A bigger buffer cannot manufacture airtime.

### It wedged the controller

Killing inquiry/page scan (`systemctl stop keep-discoverable` plus
`bluetoothctl discoverable off` / `pairable off`, leaving `hciconfig hci0`
showing bare `UP RUNNING`) did **not** help. Shortly after, the controller hard
hung: both devices dropped in the same instant, and `dmesg` filled with

```
Bluetooth: hci0: Opcode 0x0c03 failed: -110
```

`0x0c03` is **HCI_Reset**. The controller was not answering a reset. **Be
honest about causation: this is correlation in time.** The scan change and the
sink+source load are equally good suspects and the test did not separate them.
Either way, a speaker that can wedge its own radio does not belong in a locker
room.

### The recovery move — worth knowing regardless of the relay

**When the controller wedges, the three obvious commands all fail:**
`systemctl restart bluetooth`, `sudo hciconfig hci0 up` (`Can't init device
hci0: Connection timed out (110)`), and `btmgmt power on`
(`org.bluez.Error.Failed`). Every service still reports `active` while the
radio is dead — the everything-green-and-silent failure class again.

This box has **no `hciuart.service`**; the adapter is serdev-based, with
`hci_uart_bcm` bound to `serial0-0`. Unbinding and rebinding re-runs the
firmware download and brings it back:

```bash
echo serial0-0 | sudo tee /sys/bus/serial/drivers/hci_uart_bcm/unbind
sleep 3
echo serial0-0 | sudo tee /sys/bus/serial/drivers/hci_uart_bcm/bind
```

Six seconds, and `hciconfig hci0` goes back to `UP RUNNING PSCAN ISCAN`. That
turned a reboot into nothing on a box whose only access is a serial cable.
Restart `bluealsa`, `bluealsa-aplay`, `keep-discoverable`, `bt-agent` and
`lockerroom-listener` afterwards so they re-bind to the new adapter.

### The blocker no tuning fixes: the listener treats the far speaker as a DJ

**This is the finding that actually kills the idea**, and it is a code problem,
not a config one. While the JBL was connected, `lifecycle.py` saw it as just
another connected device and gave it the aux:

```
lockerroom.bluez: device disconnected: /org/bluez/hci0/dev_78_66_F3_1C_9D_B6
lockerroom.lifecycle: aux granted to JBL Charge 6 (78:66:F3:1C:9D:B6)
lockerroom.lifecycle: session closed: JBL Charge 6 (78:66:F3:1C:9D:B6)
```

A relay target opens and closes **play sessions**, competes for the aux against
a real phone, and lands in the play data. Any future attempt at this has to
teach the lifecycle the difference between a phone that is a source and a
speaker that is a sink. Weigh that against simply buying the USB-A-to-USB-C
cable the Charge 6 wants.

### What the test left behind

Nothing. No file on the Pi was created or edited at any point — no drop-in was
needed and **`/etc/asound.conf` was never touched** (md5 `74a8969d…`, 920
bytes, verified identical before and after). The JBL pairing was removed, all
seven services are `active`, the adapter is `UP RUNNING PSCAN ISCAN`, and the
ALSA default still opens card 2 and runs.

One gap in the written procedure, for whoever writes the next one:
**`audio-check.sh` is not on this box.** It is shipped by `deploy.sh`, and this
Pi was provisioned before that line existed, so `sudo audio-check.sh` returns
`command not found`. The equivalent checks were run inline instead. A deploy
would install it.

## CONFIRMED (2026-08-22): the ALSA default was an unopenable HDMI card

The hypothesis below was right, and it took no speaker, no headphones and no
physical access to prove — the whole diagnosis ran over the stage 6 serial
console, which is the first time that console has paid for itself.

**The single decisive command, and its answer:**

```
$ speaker-test -D default
Playback open error: -524,Unknown error 524
```

**−524 is `ENOTSUPP`, from `vc4-hdmi` refusing to open with no display
attached.** So the ALSA default was not merely inaudible — it could not be
opened at all. Anything that tried to play through it got an error and stopped,
which is why swapping speakers could never have worked.

The chain, every link read off the running box rather than inferred:

| link | evidence |
|---|---|
| `bluealsa-aplay` uses the ALSA default | running process was `/usr/bin/bluealsa-aplay -S` — **no `-D`** |
| default = card 0 | `/usr/share/alsa/alsa.conf:105-106` → `defaults.pcm.card 0` |
| card 0 = `vc4hdmi0` | `/proc/asound/cards`; `Headphones` was card **2** |
| nothing overrode it | no `/etc/asound.conf`, no `~/.asoundrc`, no `/root/.asoundrc`, `/etc/alsa/conf.d/` held only the bluealsa plugin |
| card 0 unopenable | `-524` |
| card 2 healthy | `speaker-test -D plughw:Headphones` → `state: RUNNING` |

**The fix was exactly what `provision.sh` already writes** — `/etc/asound.conf`
pinning the default to `card "Headphones"` by ID, mixer to 0dB, `alsactl
store`. Applied by hand over serial because this branch had never been deployed
to that box (`audio-check.sh` was not installed on it, which is how we know).
Afterwards:

```
$ speaker-test -D default
/proc/asound/card2/pcm0p/sub0/status:  state: RUNNING
```

Same command, same box, no reboot. **Sound confirmed at the speaker.**

Two things learned that were not in the original write-up:

- **The mixer was at −19.88dB**, unmuted. Not the fault, but it would have made
  the fix sound half-broken on first listen. `provision.sh` sets 0dB for this
  reason; it is not cosmetic.
- **`bluealsa-aplay` opens the ALSA device lazily**, only when audio actually
  arrives. Across a 17-minute phone connection it logged no open and no error,
  because no A2DP stream ever reached it. So *silence in that log is not
  evidence of health* — it can equally mean nothing was ever streamed.

### The check that would have caught this in provisioning

`provision.sh` wrote all three layers of config and then **trusted them**.
Nothing asserted the result, so a wrong default stayed invisible until a room
full of people heard nothing. It now runs `aplay -D default /dev/zero` and
fails loudly (`== audio out: verify ==`). Two details are load-bearing:

- **`/dev/zero` is silence**, so the check makes no sound and is safe to run
  during provisioning with people around. A check that plays a tone is a check
  that gets skipped.
- **It asserts WHICH card ran**, not merely that the open succeeded. Provision
  a box with a monitor plugged in and card 0 opens perfectly cleanly — the bug
  would sail through a naive open test while the audio still went to HDMI.

`deploy.sh` runs the same check, with one deliberate difference: **it never
writes anything.** Deploy *diagnoses*, `provision.sh` *fixes*. A deploy that
silently rewrote `/etc/asound.conf` would also silently stomp a hand-written one
on a box with a DAC. It belongs in deploy as well as provision because card
numbers renumber across kernel updates — that silences a box that has worked
for months with nothing on disk having changed, and **that box gets deploys,
not provisions.**

One refinement worth keeping: our `asound.conf` is `plug` → `hw`, which does
not mix, so a live `bluealsa-aplay` legitimately holds the device during a
deploy done while a song is playing. The check treats a **busy** default as
*evidence the path is wired up*, not as a fault. Without that it would cry wolf
on every deploy performed during a practice.

### Both checks verified on the box, in both states (2026-08-22)

Not just written — *exercised*, over serial, against the real hardware:

| | healthy box | `/etc/asound.conf` removed |
|---|---|---|
| `provision.sh` block | `VERIFIED: ... card 2 ("Headphones") and ran` | `ERROR ... 524`, `AUDIO_FAIL=1` |
| `deploy.sh` block | `VERIFIED: ... card 2 ("Headphones") and ran` | `ERROR ... 524`, `AUDIO_OK=0` + `THIS BOX WILL BE SILENT` |

The broken state was produced by moving the real file aside under a `trap`
that guaranteed restore, with the backup on `/` rather than `/tmp` so a power
cut mid-test could not lose it. Restored MD5 matched the original exactly.

**A first attempt to fake the broken state with `ALSA_CONFIG_PATH` silently did
not work** — the system `alsa.conf` includes `/etc/asound.conf` itself, so the
real default won and the check correctly reported `VERIFIED`. That looked like
the check failing to catch the fault when it was the *test* that was wrong. If
you ever need to simulate this, move the file; do not override the config path.

### Running the tests

`pi/requirements-dev.txt` now exists, and it is worth reading before you doubt
a test run. **Without `pytest-asyncio`, 52 tests FAIL rather than skip**, and
the only clue is a `PytestUnknownMarkWarning` buried in the warning summary.
With it: **100 passed** (Python 3.14, 2026-08-22).

The stage 6 serial console is what made all of this possible with the box
inaccessible. It is no longer "parked" — see the runbook note.

### Drive it over USB instead — this is better than the jack was

The Pi 4 has USB-A host ports and the Charge 6 is a USB audio *device*, so the
right cable is **USB-A (Pi) to USB-C (speaker)**, under 1.2m. JBL's procedure:
**hold the speaker's Play/Pause button while plugging the cable in, and wait
for the chime.** Without the button-hold it enters charge mode and stays
silent, which is almost certainly what a first attempt looks like.

It then appears as its own ALSA card. Point the system default at it **by ID,
never by index, and never with `-D`** — the existing DAC rule, unchanged:

```
pcm.!default { type plug; slave.pcm { type hw; card "<id>"; device 0 } }
ctl.!default { type hw; card "<id>" }
```

Three things this wins outright:

1. **It is a fully digital path.** No PWM jack, no daughterboard, no analog
   cable. This is the "consider an I2S DAC HAT" item from the v2 hardware list,
   obtained for the price of a USB cable and without occupying the GPIO header.
2. **It makes the daughterboard question moot** — the case's 3.5mm extension
   stops being in the signal path at all.
3. **It PRESERVES the anti-bypass enforcement**, which is the part that
   actually matters for this product. `spec.md` §2 relies on an occupied aux
   jack disabling the speaker's own Bluetooth radio, so nobody can pair
   straight to the speaker and skip the voting. The Charge 6 has no aux jack to
   occupy — but **in USB audio mode it shuts its Bluetooth section off
   entirely**, which is the same guarantee by a different mechanism, and a
   harder one to defeat than unplugging a cable.

**VERIFIED ON THE UNIT, 2026-08-31: #3 HOLDS.** With the Charge 6 playing in
USB audio mode, a phone **cannot connect to it over Bluetooth.** The speaker's
Bluetooth section really is unavailable while USB audio is active, exactly as
predicted above.

This was the go/no-go for the whole design and it passed. `spec.md` §2's
enforcement premise — nobody can pair straight to the speaker and skip the
voting — is intact on the USB path, by a different mechanism than the aux jack
but the same guarantee. It is also **harder to defeat than the jack version**:
an aux cable can be pulled out in a second, whereas defeating this requires
taking the speaker out of USB audio mode, which needs the Play/Pause hold and a
replug.

**This is a per-speaker property, not a general one.** It was verified on the
Charge 6 and says nothing about any other speaker. Re-test it on any unit
before relying on it.

### What this means for buying a speaker

`spec.md` §2 says "3.5mm-to-3.5mm cable, Pi audio out → speaker aux in" and
assumes every Bluetooth speaker has an aux jack. **That assumption expired.**
Aux inputs are being removed across the category. When choosing a speaker for a
box, the requirement is now:

- a **3.5mm aux input** that disables its Bluetooth while occupied, **or**
- a **USB audio input** that disables its Bluetooth while active.

Either satisfies the design. A speaker with neither cannot host this product at
all, however good it sounds, because the bypass is unclosable.

### If the analog jack is wanted anyway

Nothing above breaks the analog path; it is still what `provision.sh` asserts
and still correct for a speaker that has an aux jack. The hardware ladder when
the jack is silent, cheapest first, is in stage 9 of the runbook — and the
first rung is wired headphones, not a screwdriver.

## A fresh provision came up silent (2026-08-21) — the ALSA default was never set

**Symptom: the site works, the phone pairs, AVRCP track metadata shows up as
now-playing — and nothing comes out of the jack.** Every unit green. That
combination is diagnostic all by itself: it means the *Bluetooth* half is
completely healthy and the *ALSA* half is pointed somewhere that is not the
3.5mm jack. No amount of `systemctl status` can show it, because no service is
failing. This is the same failure shape as the soft-blocked adapter in stage 7
and the un-`enable`d listener in stage 8, arriving by a third road.

**Root cause: nothing has ever asserted the audio output.** `spec.md` §4.1 has
said since phase 1 — "enable analog audio in `config.txt`, confirm the
headphone jack is the default ALSA card" — and neither `provision.sh` nor
`deploy.sh` did either half. Whether a provisioned box made a sound was
entirely down to what the flashed image happened to default to. The first box
got lucky. A later one did not, and *nothing changed in this repo between
them*, which is what made it look like hardware.

The mechanism, which is worth understanding rather than pattern-matching:

- `bluealsa-aplay` runs with **no `-D`** (deliberately — see the DAC note
  below), so the ALSA **`default`** device *is* the whole audio path.
- With no `/etc/asound.conf`, `default` means **card 0**.
- **Card 0 is whichever card the kernel enumerated first**, not the analog one.
  With the KMS video driver loaded, the `vc4-hdmi` cards routinely come up
  first and `bcm2835 Headphones` lands at card 1 or 2.
- So a perfectly healthy box plays the entire set into an HDMI port with
  nothing plugged into it.

Card *numbers* are not stable across images, kernels or firmware updates, so
this can also break a box that has been working for months with nothing on
disk having changed. **Never pin audio by card index.**

**Fixed in `provision.sh`**, which now asserts all three layers:

1. `dtparam=audio=on` in `/boot/firmware/config.txt`, appended under an
   explicit `[all]` so it cannot land inside a `[pi5]`/`[cm4]` section where it
   would pass a grep and do nothing. **This one needs a reboot** — the firmware
   reads that file only at boot, and until then the jack does not exist as a
   card at all.
2. `/etc/asound.conf` pinning `pcm.!default` and `ctl.!default` to the analog
   card **by ID** (`card "Headphones"`), never by index. Written as the
   *default* rather than passed as `-D`, because every failure path in `aux.py`
   and the systemd drop-in lands on a bare `bluealsa-aplay` — only the default
   is inherited by all of them. This is the same rule the DAC note already
   states, now applied to the case where there is no DAC.
3. Mixer unmuted, set to **0dB (unity, not maximum** — +4dB clips a PWM-driven
   jack, and loudness belongs to the powered speaker's own knob), then
   `alsactl store` so a reboot keeps it. A fresh image has no
   `/var/lib/alsa/asound.state` and nothing restores a level at boot.

An existing hand-written `/etc/asound.conf` is left alone — that is the right
answer if a DAC was added later.

`alsa-utils` was added to the package list. `bluez-alsa-utils` pulls in
`libasound` but **not** `amixer`, `alsactl`, `speaker-test` or
`alsa-restore.service`, so a Lite image could come up with no way to set a
level, nothing to restore one, and no way to prove the jack independently of
Bluetooth.

### `pi/scripts/audio-check.sh` — run this when the room is silent

New, read-only, changes nothing, installed to `/usr/local/bin` by both
`provision.sh` and `deploy.sh`:

```bash
sudo audio-check.sh          # report the whole path, ending in a verdict
sudo audio-check.sh --tone   # plus 3s of 440Hz straight at the ALSA default
```

`--tone` is the test that matters most, because it **splits the problem in
half**: if you hear it, the analog side is fine and the fault is in Bluetooth;
if you do not, Bluetooth is innocent and the fault is everything above it. Do
not run `--tone` in a room with people in it.

It also catches two silences that are *not* this bug and look identical from
the doorway: an `/etc/asound.conf` naming a card that does not exist, and
`/run/lockerroom/aux.env` filtering the speaker to a phone that has gone home.

## The v2 box is built and beaconing (2026-08-19)

Stages 1–5, 7 and 8 of `docs/runbook-v2-build.md` are done. The box pairs,
plays audio out of the case's 3.5mm jack, and beacons 200 OK to production as
**`AuxGoat 0001`**. Stage 6 (serial console) is still parked and stage 9 (a
real end-to-end session) has not been run.

**Three latent bugs surfaced while provisioning it, all fixed in the scripts:**

- **`deploy.sh` never enabled `lockerroom-listener`.** Third instance of the
  by-hand-on-the-first-box bug that `deploy.sh`'s own comment describes, and
  the worst one: the listener is the service that does the job. A deployed box
  that is not `enable`d plays audio perfectly and records **nothing** after the
  next power cut, with every unit anyone checks still green.
- **`provision.sh` ran `systemctl start bluetooth`, a no-op on a running
  service.** The pretty hostname and `Class` landed on disk and never reached
  the adapter, so the speaker advertised its old name. Now `restart`.
- **No passwordless sudo on the Trixie image.** No
  `/etc/sudoers.d/010_pi-nopasswd`, so `deploy.sh` dies partway. And because
  `010_global-tty` turns off `tty_tickets`, one interactive `sudo` silently
  makes everything work for 15 minutes — which reads as flaky SSH rather than
  as a sudo policy. See the runbook's stage 8 for the one-line fix.

**A fourth thing, not a bug but an ordering trap: reboot between `provision.sh`
and `deploy.sh`.** Skipping it wedged systemd mid-deploy and the BCM2835
hardware watchdog (1-minute timeout) reset the board. And because stage 7 sets
`journald` to `Storage=volatile`, the previous boot's log was gone — so the
cause had to be inferred rather than read. That is the second time the parked
serial console has cost something real.

**Still open on this box:** the serial console, a DHCP reservation for
`98:fe:54:34:14:12` to settle the hostname flakiness, and SSH password auth is
still enabled — which now means root, since sudo is passwordless. Turn it off
before stage 10.

## The Pi 4B died (2026-08-12) — the board, not the card

**The speaker does not boot from anything.** Diagnosed across a full session,
the evidence is complete, and there is no field repair. Buy a replacement.

Symptom: red PWR LED solid, green ACT LED gives **one flicker and then
nothing**. It never reaches the firmware stage, so it never loads a kernel,
never brings up a network, and **cannot be SSHed into — there is no operating
system running on it.** `/var/db/dhcpd_leases` on the Mac still held only the
Aug 9 lease and was never touched again, which is what "it did not boot" looks
like from the other end. Do not go hunting for a networking fix.

Everything tried, all producing the identical one-flicker stop:

| boot device | result |
|---|---|
| original SD card (flashed 2026-08-02) | one flicker, stop |
| SD card provisioned 2026-08-11 | one flicker, stop |
| Imager **Bootloader / SD Card Boot** recovery image | one flicker, stop |
| USB flash drive, SD slot empty | one flicker, stop |

Power was the official Raspberry Pi 5.1V/3A USB-C supply throughout and the red
LED stayed solid, so the 5V rail held above the 4.63V supervisor threshold the
whole time. **Power is not implicated.**

### The card was never the problem — and neither was the 08-11 card

**This matters, because it means 2026-08-11 was misdiagnosed.** The original
card, pulled from the dead Pi, measured on the Mac:

- `diskutil list` — both partitions present and correctly typed: `bootfs`
  (FAT32, 537MB) and `Linux` (63.3GB)
- `diskutil info` — **`Media Read-Only: No`**. It has NOT flipped to hardware
  write-protect
- `dd if=/dev/rdisk4 of=/dev/null bs=1m` — **91.5 MB/s, clean, zero I/O errors**
- macOS wrote `.fseventsd` to it mid-session, so it demonstrably accepts writes
- `bootfs` holds every file a Pi 4B needs at sane sizes: `start4.elf`,
  `fixup4.dat`, `config.txt`, `cmdline.txt`, `kernel8.img`, `initramfs8`,
  `bcm2711-rpi-4-b.dtb`, `overlays/`

That card is healthy. And `cmdline.txt` carries `fsck.repair=yes`, so even a
genuinely corrupt ext4 root would have auto-repaired on the next boot rather
than persisting.

So the 08-11 event recorded in `provision.sh`'s header — *"a card stopped
accepting writes"* — was **most likely the board failing gradually, not a worn
card.** Linux mounts ext4 with `errors=remount-ro` by default: on any I/O error
the kernel remounts the root filesystem read-only, and to a human that is
indistinguishable from "the card stopped accepting writes." An hour went into a
rebuild that probably fixed nothing. `provision.sh` is still worth having — but
the reason it gives for existing is wrong.

### The trap: a recovery card CANNOT exonerate the board

Counter-intuitive, and it cost part of the session. `recovery.bin` is the Pi 4's
mask-ROM fallback for a corrupt SPI EEPROM — but **it is loaded from the SD
card.** A recovery card that does nothing therefore proves only that nothing
reaches the SoC through the SD slot. It says nothing whatever about the EEPROM
or the board.

**USB boot is the test that uses an independent channel.** It does not touch the
SD interface at all. Run it with the SD slot EMPTY before concluding anything —
a card left in can hang the bootloader before it ever falls through to USB. Here
it failed too, which is what makes this verdict conclusive rather than merely
likely.

### Any replacement needs ANALOG AUDIO OUT — this excludes the Pi 5

`pi/systemd/bluealsa-aplay-aux.conf` runs `bluealsa-aplay -S $AUX_MAC` with
**no `-D` flag**, so audio goes to the ALSA *default* device. With
`dtparam=audio=on` in `config.txt` that is `snd_bcm2835` — the **3.5mm jack**.

**The Pi 5 has no 3.5mm jack**, and no Pi 5 variant has one; Raspberry Pi
removed analog output entirely. Putting this product on a Pi 5 means a USB DAC
or an I2S HAT, a 5V/5A supply, and a `-D` flag or `/etc/asound.conf` to name a
non-default device. The Pi 5 on the home network (see "There are TWO Raspberry
Pis") is **not** a drop-in, for this reason.

**Buy a Pi 4B.** It has the jack, and every AVRCP quirk in this document was
found and fixed against this exact BlueZ-on-Pi-4B stack.

### v2 hardware, in order of value

- **Pi 4B**, 2GB is ample. The workload is one asyncio listener and a SQLite
  outbox.
- **Boot from a USB SSD, not an SD card and not a flash drive.** Cheap USB
  flash drives are *worse* than SD cards here — SD is required to ship a
  wear-levelling controller, cheap thumb drives frequently are not. A 120–240GB
  SATA SSD in a USB3 enclosure has a real controller and SMART, so it can warn
  before it dies. Check the bridge chipset: some JMicron/ASMedia revisions have
  UAS bugs on the Pi 4, fixed with `usb-storage.quirks=<vid>:<pid>:u` in
  `cmdline.txt`.
- **A USB-to-TTL serial adapter (~$10). Highest operational value of anything
  on this list.** `cmdline.txt` already carries `console=serial0,115200`, so an
  adapter on GPIO 14/15 gives full firmware and kernel boot output. This whole
  session was spent inferring machine state from one blinking LED; a serial
  console would have made it ten minutes. For a box with no SSH on campus by
  design, it is the only console that works when the network does not.
- **A pre-provisioned spare boot device on a shelf.** Turns a mid-season death
  into a swap instead of a rebuild.
- **Consider an I2S DAC HAT.** The Pi 4's onboard jack is PWM-driven and
  genuinely mediocre. This is the only item here that improves the *product*
  rather than its reliability. Needs `-D` or `/etc/asound.conf`, and it
  occupies the GPIO header.
- **Think about the environment.** Nothing ever explained *why* this board
  died. A locker room is humid, and an always-on box in a sealed case is hot.
  Ventilation, heatsinks, and where it physically sits are all unexamined.
- **Do NOT jump to a custom PCB yet.** See
  `docs/superpowers/specs/2026-08-07-device-provisioning-design.md`, which
  recommends CM4-on-a-carrier with eMMC and is right *for the product it
  describes* — a sealed box a stranger sets up. That product does not exist
  yet, and nobody has used this one even once. A USB SSD gets most of eMMC's
  benefit this week. The trigger for the PCB is a **second school wanting a
  box**, not this failure.

### What was actually bought (2026-08-17, arrived 2026-08-19)

The list above got narrowed to a real order. **The v2 box is a Pi 4B, a SanDisk
High Endurance 64GB card, and an Argon ONE V2 case**, plus a CP2102 USB-serial
adapter. No SSD, no DAC. The reasoning, because it is not obvious from the
parts list:

- **The endurance tier does not matter, and neither does SSD-vs-card, at this
  write volume.** The box writes roughly 27 GB/year against endurance budgets
  measured in tens of terabytes. High Endurance vs Max Endurance is ~10,000 vs
  ~15,000 rated hours at 32GB and both are absurd overkill here. The SSD
  recommendation above is still correct in principle; it is just not what was
  killing this box, and the card was never the failure (see the correction
  above). **Do not re-litigate the card.**
- **Buy A1, not A2. A2 is actively worse on a Pi.** A2 depends on command
  queuing, which the Pi's SD host controller does not implement, so A2 cards
  fall back to A1-ish behaviour and some measure *slower* than a good A1 card.
  The endurance rating measures large sequential writes — dashcam behaviour. A
  Linux root filesystem does small random writes, which is what the A1 App
  Performance Class (500 random write IOPS) actually covers.
- **Where you buy matters far more than which you buy.** SanDisk is the most
  counterfeited storage brand there is, and a fake card fails exactly the way
  you are trying to avoid: works when flashed, dies in weeks. Bought first-party
  from Best Buy, not a marketplace seller. 64GB over 32GB purely because
  wear-levelling gets more blocks to spread across, for a couple of dollars.
- **The DAC was deliberately deferred.** The chain is `phone -> Bluetooth A2DP
  (lossy SBC, ~328 kbps) -> Pi -> amp -> tiled room`. The source is already
  compressed and the room is hard and reflective; both cap the benefit long
  before the DAC does. **Revisit only if somebody actually complains about
  hiss** after a real session — that is a trigger, speculation is not.
  - **If a DAC is ever added, set it as the system default in
    `/etc/asound.conf`. Do NOT pass `-D` to `bluealsa-aplay`.** Every failure
    path in `aux.py` and the systemd drop-in lands on plain `bluealsa-aplay -S`,
    which plays to the ALSA default. Naming the DAC on the main path only leaves
    the fallback pointing at a default device that no longer exists — which
    silently converts the "never a silent speaker" invariant into a silent
    speaker. Setting it as the default means every path inherits it, including
    the ones nobody thought about.

### The serial adapter (CP2102) — wiring, once, here

CP2102 rather than CH340: it enumerates on modern macOS with no driver hunting.
`cmdline.txt` already carries `console=serial0,115200`, so the only missing
piece is `enable_uart=1` — **and the Argon setup script sets that for you**
(see below), so on this box it is already handled.

| adapter | Pi 40-pin header |
|---|---|
| GND | **pin 6** (GND) |
| TX | **pin 10** (GPIO15 / RXD) |
| RX | **pin 8** (GPIO14 / TXD) |

TX and RX are **crossed** — that is correct, not a typo.

- **Leave VCC/5V disconnected.** Power the Pi from its own supply. Connecting
  both backfeeds power and is a good way to create a second dead Pi.
- **3.3V logic**, if the board has a jumper.
- **Do NOT use `dtoverlay=disable-bt`**, which every serial-console guide
  recommends. It frees the good PL011 UART by turning off Bluetooth, which is
  the entire product. `enable_uart=1` alone is enough: it pins the core clock so
  the mini-UART's 115200 stays 115200 as the CPU scales.
- **In the Argon case, pin 8 is shared with the case's power-cut monitor.**
  Harmless as long as i2c code `0xff` is never sent — see "The case and the
  serial adapter share pin 8" below.

On the Mac: `ls /dev/cu.usbserial-*`, then `screen /dev/cu.usbserial-XXXX
115200`. Exit with `Ctrl-A` then `K`.

**Test it on the bench while the box is working.** The whole 2026-08-12 session
was spent inferring machine state from one blinking LED. Finding a wiring
mistake during the next outage is the failure this part exists to prevent.

### A fresh image can boot with Bluetooth soft-blocked (2026-08-19)

Found on the v2 box's first bare boot, on a stock Trixie flash. `rfkill` had
`hci0` **soft blocked: yes** while wifi was clear.

What it looks like, and why it is nasty: **every green light stays green.**
`bluetooth.service` is active, the adapter enumerates, `bluetoothctl show`
lists the right controller and advertises exactly the profiles this product
needs (`Audio Sink`, `A/V Remote Control Target`). The only tells are
`PowerState: off-blocked` in `show`, `power on` failing with
`org.bluez.Error.Failed`, and any scan then failing `org.bluez.Error.NotReady`.
No phone can see the speaker, and nothing anywhere says why.

```bash
rfkill list                      # look for "Soft blocked: yes" on hci0
sudo rfkill unblock bluetooth
```

`provision.sh` now checks and unblocks this. systemd-rfkill persists the state,
so it is a one-time fix — but **re-check it after any reboot during a build**,
because a speaker that comes up blocked on campus is indistinguishable from a
speaker that broke, and there is no SSH there to tell the difference.

### The v2 box's addresses

Recorded because `raspberrypi.local` ambiguity has cost a session before, and
because these are how you identify the box on a LAN or in a Bluetooth list.
Note these are **different interfaces** — do not confuse them, and do not
confuse either with the old dead box's `e4:5f:01:c2:6e:a9`.

| | address |
|---|---|
| static hostname | `auxgoat` (so `auxgoat.local`, not `raspberrypi.local`) |
| wlan0 | `98:fe:54:34:14:12` |
| Bluetooth controller | `98:fe:54:34:14:13` |

The two are **consecutive**, and share the `98:FE:54` Raspberry Pi OUI. That is
normal on a Pi 4 — wifi and Bluetooth get adjacent addresses — and it is
convenient: sweeping a LAN for `98:fe:54:34:14:12` finds the box, and the
Bluetooth address is that number plus one. The old dead board was
`e4:5f:01:c2:6e:a9`, a different Raspberry Pi OUI entirely, so there is no way
to confuse the two.

**Mack's iPhone, for range testing:** `5C:AD:BA:F0:B2:61` (classic BR/EDR,
stable — not the rotating BLE address it also advertises).

## The Argon ONE V2 case (2026-08-19)

Researched before assembly, because several things about it are load-bearing
for *this* product specifically and are not obvious from the box.

### The audio path survives, unchanged

**This was the thing worth checking first, and it is fine.** The V2 ships a
daughterboard that converts the micro-HDMI ports to full-size *and extends the
Pi's own 3.5mm analog jack* to the rear of the case. So the rear jack is the
Pi's `snd_bcm2835` output, and `bluealsa-aplay -S $AUX_MAC` with no `-D` still
lands on it exactly as `bluealsa-aplay-aux.conf` assumes. Nothing in the audio
config changes.

**Ignore every "the 3.5mm jack needs the BLSTR DAC" result you will find.**
That is the **V3/V5 (Pi 5)** case, where the Pi itself has no analog audio at
all so the case has to supply a DAC. It does not apply to a V2 on a Pi 4B.

### The setup script does more than advertised

```bash
curl https://download.argon40.com/argon1.sh | bash
```

Read the script before running it (2026-08-19, 822 lines). What it actually
does, beyond the fan and button:

- `raspi-config nonint do_i2c 0` — enables i2c, which the fan needs. Without it
  the button works and **the fan silently does not.**
- `do_serial_hw 0` — **sets `enable_uart=1`.** This is the serial-console
  prerequisite, done for free. Note it enables the serial *hardware*, not a
  getty; the kernel boot log arrives because `cmdline.txt` already names
  `console=serial0,115200`.
- `apt-get update && apt-get upgrade -y` **and `rpi-eeprom-update`.** This is
  why the script must run on a blank image, before `provision.sh`, not on top
  of a working listener.
- Installs `argononed.service` plus a python daemon fetched at runtime.

**Trixie:** older forum reports say the script fails on Trixie. The current
version defaults to `CHECKGPIOMODE="libgpiod"` and installs `python3-libgpiod`
rather than the `RPi.GPIO` path that broke on newer kernels, so those reports
are probably stale — but this is **unverified on hardware**, so confirm the fan
actually spins before trusting it. If it does fail, the fallback is a small i2c
fan loop; that is a far cheaper problem than the alternative (see OS choice
below).

Default fan curve after install: 55°C -> 10%, 60°C -> 55%, 65°C -> 100%.

### It does NOT come back after a power cut — fix this before it ships

**Default Argon behaviour: power returns and the Pi stays OFF until a human
presses the button.** For a box in a locker room, behind a filter, with no SSH,
that is a silent end of season. Nothing in this repo can detect it, because
nothing is running.

Mode 2 ("Always ON"), device address `0x1a`:

```bash
sudo i2cdetect -y 1          # expect 1a to appear once the case is assembled
sudo i2cset -y 1 0x01a 0xfe  # Mode 2 / Always ON   (0xfd = Mode 1 / default)
```

**The i2c code alone is reported not to stick.** Multiple users on Argon's own
forum set Mode 2 and still had to press the button; the answer from Argon was
that **an internal jumper also has to be moved.** Treat the i2c write and the
jumper as one change, not two options.

### The jumper: 3-pin header on the Argon board, 1-2 → 2-3

**It is a dedicated 3-pin header on the Argon's own board. It is NOT the Pi's
40-pin GPIO header.** Getting that wrong is expensive: on the Pi's header pin 2
is **5V** and pin 3 is **GPIO2/SDA**, a 3.3V input that is also an i2c data
line. Bridging those feeds 5V into a 3.3V GPIO and shorts an i2c bus.

| jumper position | behaviour after a power cut |
|---|---|
| **1-2** (factory default) | Pi stays **off** until the button is pressed |
| **2-3** | **Always ON** — power returns, the Pi boots by itself |

**2-3 is what this box wants.** A speaker in a locker room that needs a human to
press a button after every power blip is not a product.

**Expect the fan to run at 100% while the jumper is on 2-3 and the Argon
software is not yet installed.** That is normal, not a fault: with no daemon
feeding it temperature the MCU defaults to full. It drops to the temperature
curve as soon as `argon1.sh` has run and `argononed` is driving it — so do not
chase a roaring fan between assembly and stage 3.

**Then pull the wall plug on the bench and confirm it boots by itself.** Do not
take this on trust; it is the single most expensive thing on this page to get
wrong, and it is trivial to test while the box is on a desk.

### The real risk to the product: 2.4GHz

An aluminium shell plus copper ground pours around the Pi makes a partial
Faraday cage. On the **M.2** variant this was severe enough to be measurable —
PCB revisions before V2.2 could not hold a 2.4GHz connection 3.7m from an
access point, while 5GHz was fine; Argon fixed it by clearing copper from both
sides of the board over the antenna area. The plain V2 has no M.2 board and is
the milder case, but the mechanism is the same and the Pi 4's antenna is etched
into the PCB **right next to the micro-SD slot**, which is where case metal
sits.

**Why this matters here more than for a normal Pi project: Bluetooth is 2.4GHz
exclusively.** Every other Pi-in-a-metal-case story ends "just use 5GHz." This
product cannot. The speaker's entire job is holding an A2DP link to phones
across a room, and HCGuest is 2.4GHz-capable but the *aux link* has no
alternative band at all.

**So range-test it, cased vs uncased, before it goes in the room.** Pair a phone
at the far side of a room, watch for dropouts, and compare. If the case costs
real range, the case loses — it is a cooling and tidiness upgrade, and the
product is the radio.

### The case and the serial adapter share pin 8 — know this before wiring

The fan board extends the header up under the magnetic top cover, so the serial
console does work with the case shut. But the Argon MCU uses **more of the
header than a fan and a button would suggest**, and one of those pins is one
the serial adapter needs. From Argon's own i2c-codes repo:

| Argon function | GPIO | Physical pin |
|---|---|---|
| Power button | GPIO17 | 11 |
| Shutdown monitor | GPIO4 | 7 |
| IR receive / transmit | GPIO23 / GPIO22 | 16 / 15 |
| Fan control (i2c) | GPIO0 / GPIO1 | 27 / 28 (ID EEPROM pins) |
| **Monitor for power cut (TXD)** | **GPIO14** | **8** |

**Pin 8 is the serial adapter's RX pin and the Argon's power-cut monitor at the
same time.** In practice this is fine: the Pi drives pin 8 as an output, and
both the adapter and the Argon are passive listeners on it — multiple listeners
on one output line is normal. Pin 6 (GND) and pin 10 (GPIO15/RXD) are genuinely
unused by the case.

**But do NOT send i2c code `0xff`.** That puts the MCU into "watch UART TX
voltage and cut power when it goes low" mode. With a serial console attached
and pin 8 toggling constantly during boot logging, that is asking the case to
cut power to a healthy Pi at an arbitrary moment. Only `0xfd` (Mode 1) and
`0xfe` (Mode 2) should ever be sent to this box.

Note also that the fan i2c is listed on **GPIO0/GPIO1 (pins 27/28)**, the ID
EEPROM pins — not the usual pins 3/5. Users nonetheless find the MCU at `0x1a`
on **bus 1**; if `i2cdetect -y 1` comes up empty, try `i2cdetect -y 0` before
concluding the board is dead.

### Other small things

- **Assembly order matters**: SD card **out**, Pi into the bottom plate, seat
  the daughterboard firmly onto *both* micro-HDMI ports and the 3.5mm jack,
  thermal pads (peel *both* sides), then mate the GPIO header to the fan board.
  A partly-seated daughterboard is the usual cause of "no HDMI" and would also
  mean no audio here.
- **The fan pulls room air through the box.** A locker room is humid, and
  "environment" is still the only untested theory for why the first board died.
  This case does not resolve that question — it changes it, and arguably makes
  it worse. Worth revisiting if a second board dies.

## Production deployment (as of 2026-08-03)

| Thing | Value |
|---|---|
| Worker (team app) | `locker-room-music`, deployed from `backend/` |
| Worker (front door) | `auxgoat`, deployed from `apex/` — **added 2026-08-08** |
| Product URL | `https://hc.auxgoat.com` — **filtered on campus again as of 2026-08-08**; see "auxgoat.com is filtered" below |
| Always-worked fallback | `https://lockerroom.finestkindfarms.com` — what the Pi points at. Keep it bound |
| Fallback | `https://locker-room-music.mmvinton17.workers.dev` — unfiltered, and currently where the front door sends players |
| Front door | `https://auxgoat.mmvinton17.workers.dev` and `auxgoat.com` / `www` (the latter two filtered on campus) |
| D1 database | `lockerroom` / `d8e68dc0-5eab-42a3-b54c-441b1f79627c`, region ENAM |
| Cloudflare account | `7db3c13ee0073570030cac33d8c9f0dc` |
| Secrets | `DEVICE_KEY`, `MAC_SALT`, `TEAM_CODE` (=`CRUSADERS`), `ADMIN_PASSWORD` |

For local work, `backend/.dev.vars` (gitignored) holds the placeholder values
`test/e2e.sh` authenticates with: `dev-device-key` / `dev-team` / `dev-admin`.
It is not in the repo — recreate it if the checkout is fresh, or every local
request 401s.

**Secrets live in `backend/.secrets.local`** (mode 600, gitignored). Cloudflare
secrets are write-only — that file is the ONLY copy. `MAC_SALT` especially:
regenerating it orphans every device row. Back it up off this laptop.

Verified in production: unauthenticated `/api/now` 401, play write rejected
without and with a wrong device key, wrong team code 403, admin gate 401,
**heartbeat with the real `DEVICE_KEY` 200** (proves the Pi's credential path
and D1 writes), custom domain reachable.

`finestkindfarms.com` was migrated from Namecheap DNS to Cloudflare to host
this. Its Private Email is being abandoned — the old records are preserved in
`docs/dns-snapshot-finestkindfarms.md`, and the Namecheap subscription must be
set to not auto-renew separately (DNS changes do not stop billing).

## The apex is its own Worker (2026-08-08)

`auxgoat.com` is a landing page with a team-code box, not a redirect to Holy
Cross. It lives in **`apex/`** as a separate Worker named `auxgoat`. Design is
`docs/superpowers/specs/2026-08-07-auxgoat-landing-page-design.md`.

**Why it could not stay on the team Worker — this is the part worth reading.**

Cloudflare serves any asset matching the request path **without invoking the
Worker at all**. The team Worker has an `[assets]` binding containing
`index.html`, so `auxgoat.com/` was answered with the voting app and the apex
middleware never ran. Deployed and measured 2026-08-08:

| request | result |
|---|---|
| `auxgoat.com/go?code=CRUSADERS` | 302 → correct ✅ |
| `auxgoat.com/api/now` | 404 ✅ |
| `auxgoat.com/songs` | 302 → `/` ✅ |
| **`auxgoat.com/`** | **the team app — Worker never invoked** ❌ |

Everything that did not collide with a filename worked. Retroactively this was
always true: **the old bare-domain 302 never fired for `/` either**, so
`auxgoat.com` has been silently serving Holy Cross's app directly all along.

The only fix on the shared Worker is `run_worker_first = true`, which is
all-or-nothing in wrangler 3.x — every JS, CSS and font request would pay a
Worker invocation, on the campus wifi this product already loses.

So the apex Worker has **no `index.html` in `apex/public/`**. `/` matches no
asset, falls through to the Worker, and the page is rendered in code with its
CSS inlined. **Do not add an `index.html` there** — it would be served directly
and the error state would silently stop working. Its only asset is a vendored
Outfit woff2, committed, so it deploys from a clean checkout with no build step.

The Worker has **no bindings at all** — no D1, no secrets, no cron, no R2. It
cannot read a school's data because it has no handle to any.

**Its name is load-bearing.** `name = "auxgoat"` produces
`auxgoat.mmvinton17.workers.dev`, which is the only front door that opens on
campus. Renaming the Worker mints a new hostname and abandons the old one.

**Route ownership is exclusive.** A custom domain belongs to exactly one
Worker, so `auxgoat.com` and `www` had to be removed from `backend/wrangler.toml`
and that Worker redeployed *before* `apex` could claim them. Removing them
deleted their DNS records, so between the two deploys the apex resolved to
nothing — which looks alarming and is expected.

### The code is only typed once

`/go` hands the code to the team site in the **URL fragment**
(`...#code=CRUSADERS`), and `Join.tsx` reads it, strips it with
`replaceState`, and skips to the name step.

A fragment, never `?code=` — a fragment is not sent to the server and never
appears in a `Referer`. The app loads artwork via `<img>` straight from Deezer
and iTunes, so a query param would hand the team code to Apple and Deezer with
every cover. That code is the only gate on the team's data.

It still calls `check-code` before skipping. The apex's map and the school's
`TEAM_CODE` secret are independent, so a rotated code would otherwise be waved
through and fail at the final submit — the exact "sent back three fields later"
confusion `check-code` exists to prevent.

### Still open

- **THE `/go` THROTTLE DOES NOT WORK. It is written, deployed, and inert.**

  **In plain terms:** anyone can sit and guess team codes at the front door as
  fast as they like, and nothing stops them. A correct guess lets them sign up
  as anybody on that team. Not urgent — nobody is attacking a high-school aux
  cord — but do not believe the code comments that say it is protected.

  Measured 2026-08-09: 72 wrong codes from one IP in three minutes, zero 429s.
  The code is live (committed 14 hours before the deploy), it just never runs,
  because `env.RATE_LIMITER` is never populated. `wrangler deploy --dry-run`
  calls it "Unsafe Metadata" instead of a binding and the runtime does not turn
  that into one.

  It looked healthy for a day because the binding was made *optional*, so a
  missing one degraded silently. That was the wrong trade for a security
  control. `src/index.ts` now logs an error on every unthrottled miss, so
  `cd apex && npx wrangler tail` answers it in one request.

  **Do not try `[[ratelimits]]` on wrangler 3.** It is the correct modern form
  and is worse here — 3.114 ignores it silently, giving neither a throttle nor
  a warning ("No bindings found"). It needs wrangler 4, which needs a
  `@cloudflare/workers-types` bump.

  **Three options, in the order to try them:**
  1. `wrangler tail` while hitting `/go` with a wrong code — 30 seconds,
     confirms the binding is truly absent rather than misbehaving.
  2. Upgrade wrangler to 4 **in `apex/` only** and switch to `[[ratelimits]]`.
     Contained: apex has no D1, no cron, and one font.
  3. Skip it and do the QR path instead, which removes the apex's need to
     validate codes at all. That was always the real fix; the throttle was a
     holding action.

  The design itself is right and worth keeping: **only WRONG codes count**
  against the limit. A whole school shares one public IP on campus wifi, so
  throttling every `/go` would let players arriving at the start of practice
  lock each other out. Legitimate players type a code that works; a
  brute-forcer generates misses by definition.
- The teams map has one hardcoded entry in `apex/src/teams.ts`. `resolveTeam`
  is async and takes `env` specifically so it can become a D1 query without a
  signature change.

### When IT unblocks the domain, flip one line

`Team.url` in `apex/src/teams.ts` currently points at
`https://locker-room-music.mmvinton17.workers.dev/` because the pretty
hostname is filtered on campus. Once IT recategorises the domain:

```ts
url: "https://hc.auxgoat.com/",
```

**Nothing else needs testing.** Every apex behaviour was verified against the
real `auxgoat.com` hostname on 2026-08-09 from an unfiltered network — landing
page, `www` canonicalisation with path and query preserved, `/go` both ways,
`/api/*` 404, stray-path redirect, the font, and the whole flow end to end in a
browser typing a lowercase code.

Two things to know before flipping:

- **Everyone gets signed out.** The session cookie is host-only, so players who
  joined on `workers.dev` land on Join at `hc.auxgoat.com`. Re-joining recovers
  their history rather than forking it (signup is idempotent on
  `identity_key`), but they retype their name. Flip between sessions, never
  mid-practice.
- **Ask IT for the whole zone**, `auxgoat.com` *and* `*.auxgoat.com`. The block
  hit `hc.auxgoat.com` too, which is what made the team's own site unreachable.

## "Now on aux" outlived the song by four days (2026-08-09)

Reported as: the site says I am on aux when I am not even connected to the
speaker.

`/api/now` selected `ORDER BY started_at DESC LIMIT 1` with **no liveness
condition at all** — not `ended_at`, not recency, nothing. So the last song
ever played stayed on screen forever. The row it was showing:

```
started 2026-08-05T20:17:11   ended 2026-08-05T20:19:03   Drake - Hoe Phase
```

Started and ended four days earlier, and **closed correctly** — this was not a
Pi lifecycle bug. Nothing was ever going to take it off the screen.

Fixed with `presentablePlay()` in `voteWindow.ts`: the newest row is only a
*candidate*, and it is shown only while its vote window is open. Reusing that
rule rather than inventing one is the point — the screen exists so someone can
rate what is on the speaker, so when voting closes there is nothing to say. It
also inherits everything that logic already gets right: the 30s grace stays
votable, a PAUSED song stays up because the Pi keeps stamping `keepalive_at`,
and the two plays the Pi opened and never closed fall out on the wall-clock
fallback instead of haunting the screen forever.

Eight tests in `backend/test/nowPlaying.test.ts`, including the exact
production timestamps above.

### The speaker still does not report who is connected

**This is a real gap and the fix above does not close it.** It makes the screen
stop lying about a stale song; it does not let the product say "someone is
connected but not playing" or "nobody is connected".

The Pi already knows all of it. `SessionManager` in `pi/lockerroom/lifecycle.py`
holds a `Session` per connected device with `mac`, `alias` and `connected_at`;
`bluez_watcher.py` watches `Connected` on `org.bluez.Device1` and fires
`on_device_connected` / `on_device_disconnected`, and a disconnect already
closes the open play with `reason="disconnect"`.

**That state simply never leaves the Pi.** The beacon payload in `control.py`
carries `speaker_name`, `at`, `current_play` and `result` — nothing about
connections. So a connected phone playing nothing is indistinguishable from no
phone at all.

Closing it means: add connection state to the beacon, store it (a column on
`heartbeats` is probably enough — one speaker, one connection), return it from
`/api/now`, and give the header a third state alongside Speaker online/offline.

**It needs a Pi deploy, which is currently expensive.** SSH is reachable only
by physical access over USB-C ethernet — HCGuest filters TCP/22 between guest
clients, and there is no allowlisted command to push code. Bundle it with the
next physical visit rather than making a trip for it.

## Phase 4 result (2026-08-03)

The Pi's config now points at the production Worker. On restart it drained
**1,261 queued outbox rows with zero lost**, across roughly five hours of
accumulated outage against the old placeholder URL. That is non-negotiable #4
demonstrated on real hardware rather than simulated.

What landed in production D1, from real AVRCP sessions on a real iPhone:

```
Paramore      | Decode                | counted=1 | 46616ms
Gwen Stefani  | What You Waiting For? | counted=1 | 37443ms
Gwen Stefani  | What You Waiting For? | counted=0 | 27786ms
Paramore      | Decode                | counted=0 |   583ms
```

The 30-second skip rule (spec §5.2) is enforced correctly on real data — 27.8s
scored `counted=0`, 37.4s scored `counted=1`. Device privacy holds too:
`mac_hint=B2:61`, `hashlen=64`, raw MAC absent.

## Speaker selection is a DJ control, not a coach one (2026-09-01)

Built it in the Admin screen first, and that was a design error caught
immediately: *"are you suggesting I give every DJ the admin code?"* Every DJ
needs to pick a speaker — they walk into a room with whatever is there — so
gating it behind the coach password means either handing out the admin code or
making every DJ find the coach. Neither is the product.

**The permission already existed in the data.** A phone connected to the
AuxGoat over Bluetooth is standing within about ten metres of it. That is a
proof of presence nobody can fake from home, it needs no new code to hand out,
and the beacon already reports the whole connected set (the aux holder plus
everyone waiting). Phones are already tied to players by the Claim screen.

**The rule, in `backend/src/speakerAccess.ts`:**

- You may change the speaker if **one of your claimed phones is currently
  connected to the box**. Unclaimed phones grant nobody anything.
- **Not while somebody else's song is playing.** Moving the output mid-song is
  taking the speaker away from whoever is DJing — the same courtesy the aux rule
  already encodes. Your own song is fine.
- The speaker must be **in the last scan**. Not an injection concern (the MAC is
  validated and passed as an argv element either way) but a usability one: a
  selection nobody scanned can never connect and cannot be explained.
- **Every refusal returns a reason that says what to DO.** The likeliest failure
  here is a DJ tapping a speaker and nothing happening; "connect your phone
  first" is the whole fix, and a dead button is a bug report.

**The Admin endpoints stay ungated** — a coach can always take the speaker back,
including when nobody is connected at all, which is the one state the presence
rule cannot help with.

**Two deliberate differences from the Admin screen:**

- **The team list leads with audio-class devices and hides the rest behind a
  toggle.** In Admin nothing is filtered, because hiding a speaker is the worse
  failure there. Here the tradeoff flips: that list is every nearby device NAME,
  and left visible to all 75 players it becomes a record of who was in the room.
- **A scan is only shown for ten minutes** (`SCAN_VISIBLE_MS`). Long enough to
  pick a speaker, short enough not to be a roster.

Who last changed it is recorded in `settings.relay_speaker_set_by`. Not
enforcement — anyone connected may do this by design — but so that "the music
went to the wrong speaker" has an answer other than a shrug in a room where 75
people can all reach the control.

**It lives on a Settings screen** (`/settings`), reached from the jersey button
in the Now Playing header — already the "you" control. It was briefly on the
speaker icon in that same header, which was discoverable but wrong: Now Playing
is the screen you look at while music is on, and a control touched once a season
does not belong in it. A settings page is also where somebody goes LOOKING for
this, which a status icon that turns out to be a button is not.

Settings also carries the two account actions that already existed as routes but
had no home — claim your phone, and sign in as someone else.

## Choosing the speaker from the Admin screen (2026-08-31) — BUILT, NOT YET ON HARDWARE

The relay works; choosing what it relays to needed SSH, and on campus there is
no SSH. This is the fix: scan from the Admin screen, pick a speaker, done.

**The one design decision worth defending.** The obvious shape is a
`set-relay-speaker <MAC>` command — and it would be **the first parameterised
command** in a channel deliberately built without any. `pi_commands` maps a
fixed name to a fixed argv on both ends, and its schema comment says why: *"that
would be remote code execution on a device sitting in a locker room."* An
argument column is the first crack in that, and it does not close again.

It is also unnecessary, because the two halves are different kinds of thing:

| half | kind | how it travels |
|---|---|---|
| **scan** | an action, no parameters | a fourth allowlisted name — no schema change at all |
| **select** | a fact about the box | a `settings` row, carried on the beacon response |

`pi_commands` is unchanged. A MAC does still reach the Pi, but as **data on the
beacon response**, validated on arrival by `macaddr.normalise` — exactly how
`config.toml` values are already handled. New capability: none.

**Three states, and collapsing any two breaks something real.**

| `settings.relay_speaker_mac` | meaning |
|---|---|
| **row absent** | never chosen — the Pi falls back to `config.toml`, behaving exactly as before |
| **a MAC** | relay to this speaker |
| **`""`** | explicitly cleared — the "Use wired output" button |

Absent vs empty is not pedantry. Empty has to **override** `config.toml`, or
that button silently does nothing on a box with a speaker in its file. Clearing
therefore stores `""` rather than deleting the row.

**Precedence on the Pi:** server → local cache → `config.toml`. The cache is
`/var/lib/lockerroom/relay-target-mac`, and it is on `/var/lib` rather than
`/run` on purpose: it must survive a power cut, unlike
`/run/lockerroom/relay-target`, whose entire meaning is "a relay is live right
now" and which must not.

**Timing, stated honestly.** The beacon idles at 60s, so unchanged this would be
~60s to pick the command up, ~20s to scan, ~60s to report — about two and a half
minutes, against a pairing window that times out in two. Two changes:

- **A pending result now beacons at once** instead of sleeping a full cycle
  first. That was half the round trip and should always have been there.
- **Attentive mode:** 5s polling for 3 minutes after any command.

**The first press still waits up to 60s and nothing can fix that** — no message
reaches the Pi until it checks in. The UI solves it by ordering the
instructions: *press Scan, wait for it to say scanning, THEN put the speaker in
pairing mode.* The wait moves in front of the pairing window instead of eating
it. A wording fix for a timing problem, chosen over a code fix that costs more
and buys less.

**Devices are sorted, never filtered.** Class of Device is self-reported and
some speakers report it wrongly or not at all, so a filter can hide the exact
speaker somebody is holding — the one failure that would make the screen
untrustworthy. Audio class sorts first, then strongest signal. Nameless devices
show their MAC rather than a blank row.

**Scan results ride the beacon, not `pi_commands.result`,** which is truncated
to 2000 chars — a room with thirty phones overflows it, and a truncated list is
worse than none because the speaker you want goes missing for no visible reason.
They replace `bt_devices` wholesale: a device list is a snapshot, not a log, and
an empty scan still clears it because "I looked and found nothing" is a real
answer.

**Scanning is refused while a song is playing.** Discovery shares one antenna
with the phone's A2DP sink and the outbound relay. Refused on the Pi, where the
play state lives, and it **fails open** — a stutter costs less than a feature
that never works.

**The guard that matters most.** `SessionManager` excludes the relay MAC from
aux arbitration by identity. That MAC used to be fixed at construction, so
nothing had to keep it current. A speaker chosen at runtime that did **not**
update the guard would be granted the aux and written into the play data —
**the exact 2026-08-23 failure, reintroduced by the feature built to make the
relay usable.** `RelayManager` therefore announces every target change from
inside `set_target`, and `main.py` wires that to `set_relay_mac`. Both derived
forms move together: the MAC guards connect, the BlueZ path spelling guards
disconnect.

**Also folded in:** the long-deferred heartbeat output report
(`output_kind`, `output_card`, `relay_connected`, `relay_error`). A selection
screen that cannot show the current selection is half a feature — and what was
*chosen* and what is *playing* disagree exactly when something is wrong.

**Migration 005** adds `bt_devices` and those four heartbeat columns.

**DEPLOYED AND VERIFIED ON HARDWARE 2026-08-31.** Migration 005 applied to prod
D1, Worker deployed, Pi deployed.

| step | result |
|---|---|
| scan over the real command channel | **PASS** — dispatched in 2s, 18s to run, 28 devices stored |
| the JBL sorts to the top | **PASS** — the only device reporting Audio/Video class, above the phone, iPad and MacBook |
| "Use wired output" at runtime | **PASS** — disconnected, `output.env` removed, box on the jack, `""` cached |
| selecting a speaker at runtime | **PASS** — pair/trust/connect, `output.env` correct, MAC cached |
| the aux exclusion holds | **PASS** — `relay speaker connected: JBL Charge 6 — not a session` |
| a phone plays a song through it | **NOT YET RUN** |
| reboot reconnects unattended | **NOT YET RUN** |

Scan timing measured: **17.5s** against a 45s timeout, comfortable.

**Two faults found on the box that no test caught**, both worth knowing because
both would have shipped looking fine:

- **`bluetoothctl` prints Class as `0x00240414 (2360340)`** — hex AND decimal on
  one line. Reading the whole field returned `None` for every device, so nothing
  sorted as audio and the picker's only ordering was silently dead. The list
  still rendered; it was just wrong, with no error anywhere. Fixed in the script
  (first token) and the parser, and the round-trip fixture now uses the real
  format.
- **`deploy.sh` called a healthy relaying box silent.** The verifier strips the
  kind off `audio-out` and looks for an ALSA card; when relaying, what is left is
  a MAC, nothing matches, and it printed **"THIS BOX WILL BE SILENT"** at a box
  that was connected and correctly routed. That is exactly the lie the comment
  three lines above it warns about, on the one check that exists because nobody
  can tell silence from health by looking. Relay mode now verifies the four
  things that can be verified and says plainly that no tone was played.

**A trap for whoever debugs this next:** `/var/lib/lockerroom/relay-target-mac`
is mode 600 root. Reading it as `pi` with `2>/dev/null` prints nothing and looks
exactly like an empty file — which is itself a meaningful state here ("wired
output, deliberately"). Use `sudo cat`, or you will misread the cache.

Spec: `docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md`.
Plan: `docs/superpowers/plans/2026-08-31-speaker-selection-ui.md`.

## Pick up here

**THE SPEAKER IS BUILT, DEPLOYED AND PLAYING MUSIC.** Everything in the chain
works: box, Workers, D1, voting site. As of 2026-08-31 it also routes its own
audio output automatically and can relay to a Bluetooth speaker.

The v2 build is **finished** — all stages of `docs/runbook-v2-build.md`,
including stage 6 (serial console), which that document still describes as
"parked unfinished". It is not: `console=serial0,115200` and `enable_uart=1`
are both set on the box. Ignore any instruction below or in the runbook to
"resume at stage 7"; there is nothing left to build.

Box as built: hostname `auxgoat`, pretty name `AuxGoat 0001`. Two ways in:

| path | address | when |
|---|---|---|
| home wifi | `pi@auxgoat` | at home, 5GHz `HCGuest` |
| USB-C ethernet | `pi@192.168.2.3` | anywhere, incl. campus, needs macOS Internet Sharing |

**`auxgoat.local` does not resolve** — use the bare name or the IP. **`iw` is
not installed**; use `nmcli` and `ip route` or you will misdiagnose healthy
wifi as dead.

**Wifi is pinned to 5GHz on purpose** (`802-11-wireless.band a`). That is
load-bearing, not tidiness: it clears 2.4GHz for Bluetooth and is the single
change that made the relay work. Do not "fix" it back to automatic.

Audio output picks itself, arbitrated by `pi/scripts/audio-route.sh`:
**USB audio if a USB card is present, else the Bluetooth relay if a speaker is
configured and connected, else the 3.5mm jack.** The Pi 4's jack has no detect
pin, so the jack is the fallback by construction and cannot be sensed.

Leave `api_base_url` at `lockerroom.finestkindfarms.com` — it has survived both
campus filter episodes untouched.

**If another box is ever built, flash Raspberry Pi OS Trixie (Debian 13)
64-bit, not Bookworm.** Trixie is both newer *and* the proven one here: **every
one of the eight AVRCP quirks documented below was found and fixed against that
stack.** Bookworm ships **BlueZ 5.66 against Trixie's 5.82** — dropping back
sixteen versions under code tuned on 5.82 reintroduces the exact variable that
cost the most to eliminate. The only thing Bookworm buys is a better-tested
Argon fan script, and a fan script is a ten-line fallback; the AVRCP behaviour
is not.

Server-side, true since 2026-08-10 and still true: one phone on the aux
enforced and verified on two real iPhones, the site says whose turn it is,
admin can delete players and phones and clear history. All 75 test plays are
voided, so the first real session starts from zero.

Open the front door at **`https://auxgoat.mmvinton17.workers.dev`**, type
`CRUSADERS`. (That hostname, not `auxgoat.com`, anywhere the school filter is
active.)

**Nothing here blocks a session. In rough order of what is worth doing:**

- **Nobody has used this for real yet.** The reveal has never fired for
  anyone, no leaderboard has rendered from real votes, and vote volume is
  untested — the 7.5s poll is sized for 75 players × 2 hours and nothing has
  stressed it. Everything below is smaller than this.
- **The new aux screens have never been seen on a phone.** Built and deployed
  2026-08-09, verified only by e2e. Two phones and two minutes settles it:
  "Someone else has the aux" on the idle screen, and the waiting banner for the
  person who is actually waiting.
- **Orphaned plays will keep happening.** A listener restart mid-song leaves a
  play open forever: no `ended_at`, so invisible in history, but `counted`
  defaults to 1 so it silently counts on every leaderboard. Six had built up by
  2026-08-09. Clearing history now reaches them, but that is the cleanup, not
  the cause — nothing closes a play the Pi forgot. A sweep on the server (close
  anything whose window expired with no `ended_at`) would end it.
- **The `/go` throttle is inert** (see above): unlimited team-code guesses at
  the front door.
- **netwatch misdiagnoses a poisoned resolver.** Measured 2026-08-09: a dead
  ethernet cable put itself first in `resolv.conf`, so netwatch's DNS-dependent
  probe reported "no egress on wlan0" while wlan0 was perfectly healthy. It
  bounced the wifi and would have rebooted the box at 15 failures, into the
  same state. This is exactly the ROUTE_TRAP case it has a DROP_ROUTE action
  for; it just cannot see it. Matters most on campus, where there is no SSH.
  Fix: resolve once and probe by IP, so another interface cannot poison it.
- **Naming for more than one box** — **DECIDED 2026-08-19: serial numbers.**
  The v2 box advertises as **`AuxGoat 0001`** (pretty hostname and
  `speaker_name` both). Every speaker called `AuxGoat` collides in a Bluetooth
  list and a phone paired to one auto-connects to another, so the next box is
  `0002`.

  **This did not have to wait for the QR sticker, and the note above was wrong
  to couple them.** The QR has two halves and only one is contested: the
  *hostname* is blocked on the campus filter (see the filter section — a QR
  encoding `auxgoat.com/d/<serial>` is filtered), but the *serial* is not. The
  `0001` in the Bluetooth name is the same serial a `/d/<serial>` QR would
  carry once a permitted hostname is settled. Nothing is foreclosed; nothing
  has been printed.

  Still open, and genuinely blocked: **which hostname goes on a printed
  sticker.**

### The speaker is called AuxGoat now (2026-08-09)

Renamed from "Locker Room Speaker". Three separate settings had to change, and
they only look like one thing:

| what | where | what it actually does |
|---|---|---|
| **pretty hostname** | `hostnamectl set-hostname --pretty` | the name phones see |
| `speaker_name` | `/etc/lockerroom/config.toml` | the `heartbeats` key |
| `Name` | `/etc/bluetooth/main.conf` | **nothing** |

**`Name` in main.conf does nothing on BlueZ 5.x.** Measured on the Pi: changed
it, restarted bluetoothd, advertised name unchanged — and there was no stored
`Alias` in `/var/lib/bluetooth/<adapter>/settings` to explain it. BlueZ takes
the name from systemd's pretty hostname. `docs/spec.md` said to set main.conf
`Name` and had been wrong about that since phase 1; it is corrected now. The
change is NOT picked up live — `systemctl restart bluetooth` is required.

Two follow-ons:

- **Already-paired phones cache the old name** and may keep showing "Locker
  Room Speaker" until they forget and re-pair. Nothing is broken if they do.
- **The `heartbeats` row is keyed on the name**, so there is now a stale
  "Locker Room Speaker" row. Harmless — `speaker_online` reads
  `ORDER BY last_seen_at DESC LIMIT 1`, so the newest row always wins — and it
  is left in place rather than deleting production data for tidiness.

**Superseded 2026-08-19:** boxes are serial-numbered now, and this one is
`AuxGoat 0001`. `provision.sh` takes `SPEAKER_NAME` and sets both the pretty
hostname and `speaker_name` from it — **pass it, or a re-run silently renames
the box back to the bare default.**

Third stale `heartbeats` row incoming, alongside the `Locker Room Speaker` one:
`speaker_online` reads `ORDER BY last_seen_at DESC LIMIT 1`, so the newest row
still wins and this stays harmless. Worth knowing before two real boxes beacon
at once, when the newest-wins read stops being obviously correct.

### One phone on the aux (2026-08-09) — VERIFIED ON HARDWARE

Two real iPhones, 15:59–16:03 on 2026-08-09. A waiting phone connected fine,
was inaudible, was not recorded, and took the aux cleanly once the holder went
quiet — in both directions. The router's no-restart guard also proved itself:
it re-granted the aux to the same phone and correctly skipped the service
restart.

Enforcement is **routing, not refusal**. A newcomer connects normally and
simply is not audible: `bluealsa-aplay` gets a MAC allowlist naming one phone.
See `pi/lockerroom/aux.py` and the comment block in
`pi/systemd/bluealsa-aplay-aux.conf` — every failure path there lands on plain
`bluealsa-aplay -S`, which plays anything. The failure mode is the old
mixing behaviour, never a silent speaker. Do not "simplify" that away.

Two things the hardware taught that no unit test would have:

- **iOS resumes on its own after an external AVRCP pause.** 12 pauses in 41
  seconds before `PAUSE_COOLDOWN` was added. The pause is a courtesy, not the
  enforcement, so it now backs off for 10s rather than fighting.
- **After a listener restart the aux goes to whichever phone BlueZ announces
  first**, not to whoever held it before. With two phones connected, a deploy
  can land it on the wrong one and the right one waits out AUX_GRACE. Known,
  self-correcting in 45 seconds, deliberately not fixed — but do not deploy
  mid-session and expect the aux to stay put.

The rule, in `SessionManager`:

- **A song is playing → a second phone connects but is not routed.** Its audio
  goes nowhere and its songs are not recorded: a song the room could not hear
  did not play to the room.
- **A song was playing within the last 45 seconds → same.** That is `AUX_GRACE`,
  and it exists for the gap between songs. Without it the aux is briefly
  unowned every time a track ends, which is exactly when someone would take it.
- **Nothing has played for 45 seconds → whoever presses play next gets it.**
  Nobody has to disconnect, and a phone left in somebody's pocket does not hold
  the room hostage until it leaves Bluetooth range.
- A pause holds the aux for as long as the play stays open (`PAUSE_GRACE`, 60s),
  because a paused play is still open. So pausing to talk does not lose it.

Handing off is therefore: stop your music, wait, next person presses play.

### Deleting players and phones (2026-08-09)

Admin can now delete, not just deactivate. Deactivate is still right for
someone who left the team; delete is for rows that should never have existed,
which accumulate because players sign themselves up with only the team code.

**The songs always survive.** A play is a thing that happened in the room.
Deleting a player nulls `plays.user_id` (the song reads "Unclaimed"), unclaims
their phones, and signs them out. Deleting a phone nulls `plays.device_hash`.

Two consequences the UI states before asking, both irreversible:

- **A deleted player's votes are DELETED, not voided.** `votes.user_id` is NOT
  NULL and references `users(id)`, so there is no row to leave behind. Visible
  effect is identical — those votes stop counting.
- **Deleting a phone that has unclaimed songs strands them.** Claiming works by
  picking your phone off the list; with the phone gone there is nothing left
  tying those plays to a person.

Deleting a phone does not stop it being tracked — the Pi re-creates the row from
its MAC hash the next time it plays. Covered by 15 checks in `backend/test/e2e.sh`.

**First, though: verify the three lifecycle fixes on real hardware.** They
landed late on 2026-08-05 and have only been proven by unit test. Play three
songs, pause one mid-track for over a minute, and let one run to its natural
end. Then check that D1 holds exactly three plays, all with a non-null
`ended_at`, and that the site showed **Paused** rather than jumping to Ended.
See "Three lifecycle bugs found from one screenshot".

Still never exercised with a real audience, and the highest-value thing to do
next:

- **The results reveal has never fired for anyone.** It is the one moment the
  product is built around and nobody has seen it land.
- **No leaderboard has rendered from a real session's votes.** The AuxGoat card
  and the damped scores have only ever been checked against seeded data.
- **Vote volume is untested.** Production holds a handful of votes from one
  person. The 7.5s poll is sized for 75 players × 2 hours; nothing has stressed
  it.

Answered on 2026-08-05, so do not re-litigate these:

- *Is the vote control usable one-handed?* Yes — ~96px thumbs, low on screen,
  optimistic fill. Checked at 393×852.
- *What does the screen look like between songs and when the speaker is off?*
  Both states exist and read correctly; "Speaker offline" is now unambiguous.
- *Does the join flow confuse someone doing it once, fast?* It did, badly, in
  three separate ways. All three are fixed — see the walkthrough section.

### Smaller things still open

- **Tab switches flash a spinner every time.** Songs/DJs/History refetch on
  mount with no client cache, so going back and forth re-spins on data that is
  seconds old. Measured but not fixed; the fix is keeping the last result and
  revalidating behind it.
- **No Time Machine destination.** Git covers the source now, but not
  `backend/.secrets.local`. Mack confirmed `MAC_SALT` is saved off-laptop.
- **`TEAM_CODE` is still `CRUSADERS`** and is still the only gate.
- ~~**A routing artifact got in as a real play.**~~ RESOLVED 2026-08-10, not by
  a fix but by Clear history voiding every play on record. The signature below
  is kept because the quirk itself is still live and will recur.

  Seen 2026-08-05 20:12 from a
  MacBook: artist `Listening on MacBook Pro`, title `sdp interlude • Travis
  Scott`, 187s, `counted = 1`. This is the transitional metadata quirk in
  "AVRCP quirks found on a real iPhone" #4 — but the 2s create-grace only
  catches it when it *passes through*, and here the output routing sat in that
  state for over three minutes, so the artifact was written and will show on
  the track leaderboard.

  Deliberately not fixed: Mack called it a weird one-off and it came from a
  laptop, not a phone. If it recurs, the signature is an artist beginning
  `Listening on` with the real title and artist joined by ` • ` in the title
  field — but hardcoding an Apple string is fragile, and inverting the title
  is a better discriminator than matching the vendor text. One row to clean
  up if it is ever addressed.

### Beta pre-flight — all closed as of 2026-08-04

- Team told before switch-on (spec §13) — **done**
- Cloudflare billing alert — **done**
- `MAC_SALT` and the other three secrets backed up off-laptop — **done**
- `TEAM_CODE` stays `CRUSADERS` for beta — **conscious decision**, it is now
  the only gate since signup is self-service

## Artwork — verified 2026-08-03, and rebuilt

Previously flagged unverified because the dev container could not reach the
iTunes API. It reaches fine from Mack's laptop, and the path is now confirmed
end to end: a real `POST /api/plays` stores a real cover URL and the track
lands on `artwork_state = 'found'`.

Verifying it surfaced a genuine problem. iTunes only accepts a **free-text**
search, and the result set around a popular song is full of traps — searching
"Paramore Decode" also returns *Lullaby Versions of Paramore*, *Karaoke
Night*, a Mary Sammer cover, and three unrelated songs called "decode". The
old code took `limit=1` on that list and was right only by luck of ranking.

`artwork.ts` now tries **Deezer first**, because it supports *field-scoped*
queries (`artist:"X" track:"Y"`) and iTunes does not. That scoping is what
structurally prevents a karaoke record from becoming a track's cover. iTunes
stays as a fallback so a Deezer outage or an edge-IP rate limit (~50 req/5s,
and from a Worker that IP is Cloudflare's shared edge) degrades to a second
source rather than straight to a colour block. Both providers request 10
results, filter by artist, and prefer the release whose album matches.

`POST /api/plays` now passes the AVRCP **album** into the lookup. The Pi was
already sending it and it was being dropped. It is what disambiguates a song
that exists on a single, an album, a soundtrack, and three compilations —
Deezer + album resolves "Decode" to the Atlantic 45, where iTunes alone
returned the Twilight soundtrack.

`pick()` returns null rather than a weak match on purpose: a colour block is
a better outcome than confidently showing the wrong cover.

**Two things to know.** The album hint only applies the *first* time a track
is seen — tracks dedupe on `track_key` and artwork is cached forever per spec
6.4, so the first phone to play a song fixes its cover for the season. And
neither provider fixes catalog rock: Journey still resolves to a compilation
rather than *Escape*, because no free API has a "canonical release" concept.

## Remote control over 443 (added 2026-08-04)

Since nothing can connect *to* the Pi, the direction is inverted: the Pi
beacons out on 443 — the one route HCGuest leaves open — and the response
carries any pending command.

- Pi side: `pi/lockerroom/control.py`, `beacon_loop`, every 60s.
- Server: `POST /api/pi/beacon` (device key). Doubles as the liveness
  heartbeat, which is why the queued one was retired.
- Queue a command: `POST /api/admin/pi/commands`, or the **Speaker** section
  of `/admin`. History and results show there too.

**The command set is a fixed allowlist** — `restart-listener`, `reboot`,
`report-status` — enforced at the API boundary *and* again on the Pi, which
does not trust the server to be the only gate. Commands run as an argv list,
never through a shell. **There is deliberately no "run arbitrary command".**
Adding one would turn a locker room speaker into remote code execution; the
pressure to add it will come the first time the allowlist does not cover a
problem, and the answer is to add a specific named command instead.

Only one command may be outstanding at a time, so three impatient clicks
cannot reboot the Pi three times. Expect up to ~2 minutes end to end: one
beacon to collect, one to report back.

Verified in production: queued 16:47:53, dispatched 16:48:41, completed
16:49:41 with `ok=1`.

## Clean slate, 2026-08-04

Production data was deliberately wiped so the first real session is a genuine
first-time experience — for voting *and* for DJing. Cleared: `users`,
`devices`, `tracks`, `plays`, `votes`, `device_tokens`, `pi_commands`.
**Kept: `settings`** (team colour `#8f00ff`, name "Holy Cross") — a first-timer
should see the configured team, not defaults.

Because `device_tokens` was cleared, every phone is signed out and lands on
Join. Because `devices` was cleared, the first phone to DJ shows up unclaimed
and gets the "Whose phone is this?" prompt. `MAC_SALT` was NOT rotated, so the
same phone still hashes to the same device row.

A full pre-wipe snapshot is in the session scratchpad
(`prod-full-snapshot.json`), which will not survive indefinitely — copy it
somewhere durable if that history ever matters.

## Backups (spec 13)

Two independent paths, because a season of data is not reproducible.

**Automatic — daily to R2.** Cron `0 8 * * *` (≈03:00 US Eastern, never
mid-practice) runs `src/backup.ts`, which dumps every table to gzipped JSON in
the `lockerroom-backups` bucket. It reads table names from `sqlite_master`
rather than a hardcoded list, so a table added later cannot silently go
missing. Trigger one by hand or check it is running from `/admin`, or:

```bash
curl -X POST https://hc.auxgoat.com/api/admin/backups -H "X-Admin-Password: ..."
curl      https://hc.auxgoat.com/api/admin/backups -H "X-Admin-Password: ..."
```

**Cost guardrails.** Cloudflare has **no hard spend cap for R2** — no setting
says "never bill me" — so the guardrails are structural and live in
`backup.ts`: one write per day (~31 Class A ops/month against 1,000,000 free),
`MAX_BACKUPS = 30` retained, `MAX_DUMP_BYTES = 25 MB` per object, and
`MAX_TOTAL_BYTES = 1 GB` for the whole bucket. Breaching any of them makes the
job **refuse and log** rather than write. Worst case storage is 750 MB, 7.5% of
the free 10 GB; the first real backup was **271 bytes**. Egress on R2 is always
free. Set a billing alert in the dashboard as a backstop — that is the one
guardrail that cannot live in code.

**Manual — `./backend/scripts/backup.sh`.** Dumps to `~/lockerroom-backups`,
outside the repo deliberately. Use before anything risky.

**Restoring.** Reach for **Time Travel first** — it covers 30 days, needs no
file, and is far harder to get wrong:

```bash
npx wrangler d1 time-travel info lockerroom
npx wrangler d1 time-travel restore lockerroom --timestamp=<ISO8601>
```

For older damage, the `.sql` dump imports directly. The R2 objects are JSON,
so they restore by script rather than by `d1 execute`:

```bash
npx wrangler r2 object get lockerroom-backups/d1/<key> --file=out.json.gz --remote
gunzip -c out.json.gz | python3 -m json.tool | less
```

Both paths were tested, not assumed: the `.sql` dump round-tripped into local
D1 with all 9 tables intact, and the R2 object decompressed with correct
content.

**A restore does not bring back `MAC_SALT`.** Device rows are keyed on
`SHA-256(mac + salt)`, so restoring against a different salt orphans every
claim and every DJ attribution. It exists only in `backend/.secrets.local`.
Back it up separately, off this laptop.

## auxgoat.com is filtered on the school network (2026-08-04, BACK 2026-08-08)

**The product domain is unusable on campus.** `hc.auxgoat.com` and
`auxgoat.com` are blocked by the school's web filter **by SNI** — the same
mechanism that blocks Tailscale. Measured: DNS resolves correctly to the right
Cloudflare IPs, TCP connects, then the TLS handshake dies with `no peer
certificate available`. Meanwhile github.com and captive.apple.com return 200
from the same machine, and `lockerroom.finestkindfarms.com` and the
`workers.dev` host both return 200.

Almost certainly because the domain was registered that morning — filters
routinely block newly-registered, uncategorised domains. It worked for about
4½ hours after cutover, then the filter caught up.

### It lapsed on 08-05 and returned by 08-08. Re-measured, same signature

Against one Cloudflare IP (`104.21.96.77`), on the wired campus network:

| SNI presented | result |
|---|---|
| `hc.auxgoat.com` | CONNECTED, then **no peer certificate available** |
| `auxgoat.com` | same |
| `example.com` | `subject=CN=example.com` |
| `lockerroom.finestkindfarms.com` | `subject=CN=finestkindfarms.com` |

From a phone hotspot, minutes later, every one of those returns 200 with a
valid `CN=auxgoat.com`. So the certificate is fine and Cloudflare is fine —
this is the filter, not an SSL problem, and **treating it as an SSL problem
wastes an hour.** The one-line check:

```bash
echo | openssl s_client -connect 104.21.96.77:443 -servername hc.auxgoat.com 2>&1 | grep -E "no peer|subject="
```

**Do not diagnose this as a deploy breaking something.** SNI rejection happens
before a route or a Worker is consulted. If `workers.dev` and
`finestkindfarms.com` still answer 200, the Worker is healthy by definition.

**The blast radius is the whole zone, not just the apex.** The team's own
voting site is unreachable on campus too. That is why `Team.url` in
`apex/src/teams.ts` points at the `workers.dev` hostname rather than
`hc.auxgoat.com` — deriving `https://<slug>.auxgoat.com/` would hand a player a
blocked destination from a front door that had just worked. Move it back when
the filter lapses; it is one line.

**It also undermines the QR plan in the provisioning design.** A QR encoding
`auxgoat.com/d/<serial>` is filtered, and so is the `hc.auxgoat.com` it would
redirect to. Whatever gets printed on a case has to be a hostname the filter
permits — which argues against a fresh subdomain of a newly-registered domain,
since that is the exact pattern filters block on sight. Settle this before
anything is printed.

**The Pi has been reverted to `lockerroom.finestkindfarms.com`** and is beaconing
normally. Keeping that hostname bound is what made the recovery a one-line
config change instead of a trip to the school; do not remove it.

To fix: ask IT which filter they run (Lightspeed, Securly, GoGuardian, Cisco
Umbrella are the usual ones) and file a recategorisation request. New-domain
blocks often lapse in a week or two, but that is not something to plan a
season around.

**This is structural, not a one-off.** Any future school onboards onto a brand
new subdomain and hits the same wall on day one. Build allowlisting into the
rollout, not into the debugging.

## Do not leave the ethernet cable plugged in

The Pi keeps two default routes and prefers the wrong one:

```
default via 192.168.2.1  dev eth0  metric 100   <-- preferred
default via 10.104.224.1 dev wlan0 metric 600
```

Lower metric wins, so all traffic goes out eth0. When macOS Internet Sharing
is off — or the Mac itself has no internet — that is a dead route the Pi will
keep using rather than failing over to working wifi. Linux does not switch away
from a route that exists but does not work.

Cable in only while actively working on the Pi, out afterwards.

## HCGuest reliability — watch this

On 2026-08-04 the Pi and the Mac both lost egress on HCGuest for ~15 minutes on
a weekday evening. Separately the Pi was seen **associated with an IP but unable
to reach its own gateway** — zombie wifi that a `nmcli` reconnect did not fix.
A headless box sits in that state indefinitely.

**Built 2026-08-05 — `lockerroom-netwatch`.** See below.

## The wifi egress watchdog (2026-08-05)

`pi/lockerroom/netwatch.py`, running as `lockerroom-netwatch.service`, enabled
so it comes back after an unattended reboot.

Two design points carry the whole thing:

- **The probe is bound to the wifi interface** (`curl --interface wlan0`). With
  the ethernet cable in, the Pi prefers eth0 (metric 100 vs wlan0's 600), so an
  unbound probe would leave over ethernet and cheerfully report healthy while
  wifi was dead. Verified on hardware: bound to a down interface the probe
  returns failure rather than falling back to the working route.
- **A failure needs BOTH the Worker and a neutral host to be unreachable.** The
  neutral host is `captive.apple.com`, deliberately not a Cloudflare property —
  the Worker already sits behind Cloudflare, and one incident there must not be
  able to reboot a speaker in a locker room. A Worker outage is someone else's
  problem, not a reason to power-cycle.

The ladder, on a 60s probe: **5 fails (~5 min) → bounce the connection; 10 →
restart NetworkManager; 15 (~15 min) → reboot.** The reboot rung exists because
the zombie state observed on 2026-08-04 *survived* an `nmcli` reconnect —
without it this watchdog would have watched that outage and done nothing that
helped. It is rate-limited to one reboot per 6 hours, persisted to
`/var/lib/lockerroom/netwatch-state.json`, so a Pi that comes up still broken
cannot loop. Past the top of the ladder it keeps retrying rather than giving up.

Runs under **system `python3`, not the listener's venv**, and imports nothing
third-party — a broken venv is one of the states it has to survive. It does not
depend on `lockerroom-listener` either, for the same reason. Commands are argv
lists, never a shell, matching the rule set by the pi control channel.

Every knob is optional and lives under `[netwatch]` in `config.toml`; omit the
table entirely and it still runs, because the failure it guards against is
silent. 18 tests in `pi/tests/test_netwatch.py`, all pure — the ladder is
testable without a Pi, a radio, or a fifteen-minute wait.

```bash
journalctl -u lockerroom-netwatch -f
```

### The watchdog has a blind spot, confirmed in production (2026-08-09)

**netwatch watches `wlan0`. The beacon uses the default route. When a cable is
plugged in those are different paths, and the watchdog cannot see the one that
matters.**

Measured on the Pi during a real outage:

```
default via 192.168.2.1 dev eth0   metric 100   <- wins
default via 192.168.1.1 dev wlan0  metric 600

curl worker over the default route : 000   (dead)
curl worker --interface wlan0      : 200   (fine)
```

The beacon had been silent for ~38 minutes. `journalctl -u lockerroom-netwatch`
over that whole window contained **exactly two lines** — the service starting.
Not one `no egress on wlan0`. The ladder never ran, because from where netwatch
was looking nothing was wrong. `/var/lib/lockerroom/netwatch-state.json` does
not exist, which confirms it has **never** rebooted the box.

Deleting the dead route restored egress instantly and the heartbeat returned
within one beacon interval:

```bash
sudo ip route del default via 192.168.2.1 dev eth0
```

That is a temporary fix — a DHCP renew or a reboot puts the route back. **The
real fix is to unplug the cable**, which is what "Do not leave the ethernet
cable plugged in" above has always meant. This is that failure, observed.

**The design gap, and it is worth fixing.** Binding the probe to `wlan0` was a
deliberate and correct decision for the failure it was written for — with a
cable in, an unbound probe would leave over ethernet and cheerfully report
healthy while wifi was dead. But it makes the inverse invisible, and the
inverse is what happened. The watchdog answers "is wifi healthy?" when the
question that matters is "can this box reach the server over the route it
actually uses?"

**FIXED and verified on hardware, same day.** netwatch now probes both paths —
bound to `wlan0` *and* unbound over the default route — and classifies:

| wlan0 | default route | situation | action |
|---|---|---|---|
| ✅ | ✅ | `healthy` | nothing |
| ❌ | ❌ | `offline` | the original ladder, unchanged |
| ✅ | ❌ | `route-trap` | **drop the dead non-wifi default route** |
| ❌ | ✅ | `wifi-degraded` | repair wifi, but **never reboot** |

Two subtleties that are easy to get wrong later:

- **Both probes keep the neutral-host fallback**, which is why they share one
  implementation (`_egress_via`). If the default-route probe checked only the
  Worker, a Cloudflare incident would look like `wifi ok, default route dead`
  and the watchdog would delete the box's default route over someone else's
  outage.
- **The reboot rung is gated on `offline`.** Power-cycling a speaker that is
  working and reachable, to repair wifi it is not currently using, is strictly
  worse than leaving it alone. It downgrades to `restart-nm`.
- **Do not simply unbind the probe.** That reintroduces the original bug the
  binding was added to prevent.

The default-route probe only runs when a non-wifi default route actually
exists, so with no cable in there is no extra network cost — and "no default
route at all" cannot become a phantom trap with nothing to drop.

Verified on the real Pi by manufacturing the trap with a dummy interface
(`ip link add dummy0 type dummy`, then a dead default route at metric 50).
21 seconds later:

```
ERROR netwatch: default route via 10.99.99.254 dev dummy0 is dead while wlan0
is healthy — dropping it (unplug the cable to fix this properly)
```

Route gone, egress back to 200. 33 tests in `pi/tests/test_netwatch.py`.

### `deploy.sh` never restarted the watchdog — every deploy until now

Found while verifying the above: the fix was deployed and did nothing, and the
journal still showed a PID from 49 minutes earlier.

```bash
sudo systemctl restart lockerroom-listener       # restarts
sudo systemctl enable --now lockerroom-netwatch  # does NOTHING if running
```

`--now` only *starts* a stopped unit. On any box where the watchdog was already
running — which is every box, since it is enabled and `Restart=always` — a
deploy copied new files into `/opt/lockerroom` and left the old process
running. **Every netwatch change before 2026-08-09 should be assumed never to
have taken effect** unless the Pi was rebooted afterwards.

Now `enable` and `restart` are separate lines. If a Pi-side fix ever appears to
do nothing, check `systemctl show -p MainPID lockerroom-netwatch` before
doubting the code.

## Team code is now case-insensitive (2026-08-05)

First real-world failure: `CRUSADERS` came back "incorrect team code". The
secret in Cloudflare was never wrong — probing production proved exact
`CRUSADERS` passed while `crusaders`, `Crusaders`, and any padded variant were
all rejected. `safeEqual` was comparing raw bytes.

The Join input already sets `autoCapitalize="characters"`, but that is only an
**iOS keyboard hint** — it does nothing on desktop, nothing on paste, and
nothing on many third-party keyboards. So the gate was one shift key away from
locking a player out of the whole product.

`normalizeTeamCode()` in `crypto.ts` now trims and upper-cases both sides.
Internal whitespace is deliberately preserved, so "CRUS ADERS" still fails and
the error message stays honest. **Applied only to the team code** — `DEVICE_KEY`
and `ADMIN_PASSWORD` are real secrets and remain byte-exact.

Verified live against production: every casing and padding of `CRUSADERS` is
accepted; `KNIGHTS`, `CRUSADER`, `CRUS ADERS`, and empty are still 403.
Covered by `backend/test/teamcode.test.ts` (6 tests).

## First real UX walkthrough (2026-08-05)

Done at 402×874 against a locally seeded database (6 players, 17 plays, 64
votes, one live play with an open window) — **not** against production, whose
clean slate is deliberately preserved. Seed generator lives in the session
scratchpad; regenerate rather than reuse, since the live play ages out of its
vote window in a few minutes and then the screen legitimately shows OFFLINE
next to a full progress bar.

Two things were wrong and are now fixed:

**The team code failed three fields too late.** The Join screen asks for the
code, then the name, but the code was only checked when the whole form
submitted — so a wrong code meant filling in first name, last name and number
and *then* being bounced back to step one. Reproduced on the walkthrough. New
`POST /api/session/check-code` returns 204/403, creates nothing, and Join now
validates before advancing. This compounded badly with the case bug above: the
input is `text-transform: uppercase`, so a lowercase entry *displays* as
`CRUSADERS` and looks obviously correct while being rejected.

**Disabled buttons did not look disabled.** `.btn:disabled` was only
`opacity: 0.5`, and half-strength team purple still reads as a confident,
tappable button — tapping did nothing, with no feedback. Disabled now drops the
brand colour entirely for `--hairline`/`--muted`, no shadow, `not-allowed`.

**A deactivated player was told their team code was wrong.** The real cause of
the 2026-08-05 "CRUSADERS doesn't work" report, and it was not the casing bug —
that was a separate, genuine problem fixed earlier the same day.

`POST /api/session` returns **403 for two unrelated reasons**: a wrong team
code, and a player an admin has deactivated. `Join.tsx` branched on the status
alone, so both rendered as "That team code isn't right." Mack had deactivated
two `test test` rows, then kept signing up as `test test` and being told a
correct code was wrong. Signing up as a new name worked instantly — which is
what finally identified it.

Both responses now carry a machine-readable `code` (`wrong_team_code` /
`player_removed`), `ApiError` exposes it, and Join branches on that. Only a
real code failure sends someone back to step one; a removed player is told so,
in place. Verified against production using the actual deactivated row.

**Anything reading a 403 from this route must branch on `code`, never the
status.** Two more 403 reasons would fit here naturally and the next one will
be just as invisible.

Not yet addressed, seen on the same pass:

- The **NUMBER field is unlabelled as optional** even though `ready` only
  requires first and last name.

**~~Artwork that 404s shows a broken image.~~ FIXED 2026-08-05.** There *was*
an `onError`, but it cleared the element's `src` — and an `<img>` with no src
renders its **alt text**, so a dead cover displayed the words "Artwork for
POWER" across the colour block. Worse than the torn glyph it was avoiding, and
it mutated an element React owns. `Artwork` now tracks the failure in state and
renders the colour block instead, resetting on `src` change so one dead cover
in a list cannot suppress every image after it. Verified by pointing a track at
a URL serving non-image content: clean colour block, no alt text, no glyph.

Worth knowing: a dead **Deezer** URL does not 404 — it 302s to a generic
placeholder image, which loads fine and so never triggers `onError`. The
fallback protects against a URL that stops serving an image, not against Deezer
quietly substituting one.

## Artwork: search BY album, don't just rank by it (2026-08-05)

"Imma Be" showed a colour block, then the wrong cover. Two separate faults,
both now fixed, and between them they undo the pessimism in the Artwork
section above — the album hint does work, it was just being applied too late.

**The artist filter could not see past a leading "The".** AVRCP reported
`Black Eyed Peas`; Deezer lists `The Black Eyed Peas`. `pick()` required an
exact match after `normalize()`, which does not strip articles, so all four
correct results were discarded and the track cached as `none` forever.
`artistKey()` now drops a leading article on both sides. That is the **only**
loosening — matching on "contains" or a prefix would let *Lullaby Versions of
Paramore* back in, which is what the filter exists to stop.

**The album was only used for ranking, never for searching.** Filtering after
the fact cannot help when the right release is not in the results at all:
`artist + track` for "Imma Be" returns a best-of and three remixes, and none of
them is THE E.N.D. So ranking could only pick the least wrong one — a
compilation cover. `fromDeezer` now puts the album **in the query**
(`album:"…"`), which returns exactly one result: the correct release. It falls
back to the wider artist+track search when the album is absent or the catalogue
spells it differently, because a compilation cover still beats a colour block.

Verified in production, comparing stored cover hashes against Deezer:
`POWER` → *My Beautiful Dark Twisted Fantasy*, `Imma Be` → *THE E.N.D. (THE
ENERGY NEVER DIES)*. Both exact, both 200 image/jpeg.

`POST /api/admin/artwork/retry` re-runs lookup for tracks stuck on `none`;
`{"all":true}` redoes every track, which is what a matcher improvement needs,
since spec 6.4 caches a bad result as permanently as a good one.

## Why the site felt laggy (2026-08-05)

Reported as "sooo laggy", with pauses not matching the phone and skips
arriving late. Measured first: the network is **not** the problem (105 ms
round trip to the Worker), assets are small (175 KB JS, 32 KB font), the
progress bar already ticks locally every second, and votes were already
optimistic. So none of the obvious suspects.

The real cause was **the beacon running at a flat 60 s**. It is the only way
the server learns a song was paused, resumed or skipped:

| step | was | now |
|---|---|---|
| Pi notices (AVRCP) | instant | instant |
| Pi tells the server | **up to 60 s** | **~1 s** |
| phone polls `/api/now` | up to 10 s | up to 10 s |
| **total** | **up to 70 s** | **~5–11 s** |

`beacon_loop` now waits in one-second steps and breaks early when
`play_signature()` changes — song id or play status. `open_play_state()` is an
in-memory read, so watching it costs nothing, and only a real change triggers
an extra request. Between changes it settles at 10 s while playing and 60 s
when idle. Position is deliberately excluded from the signature: it moves
every millisecond and would make a busy loop.

**Spec 8's 10-second floor on the now-playing poll was NOT changed.** That rule
is about per-player cost and multiplies by everyone in the room. The beacon is
one device, so its cost is fixed however many people are voting.

Separately, `sync_interval_s` went **15 s → 5 s**. A *new* song reaches the
site through the outbox, not the beacon, so that interval was the "skips are
late" term. It is free when idle — a drain pass with an empty outbox makes no
network call.

**The poll then went 10 s → 7.5 s (2026-08-05), and spec 8 was updated to
match.** A deliberate spend of request budget, sized against **75 players × 2
hours a day** = 150 player-hours:

| interval | polls/day | + overhead | % of the 100k/day tier |
|---|---|---|---|
| 10 s | 54,000 | 57,920 | 58% |
| **7.5 s** | **72,000** | **75,920** | **76%** |
| 7 s | 77,143 | 81,063 | 81% |
| 6 s | 90,000 | 93,920 | 94% |

Overhead is ~3,900/day — the Pi's beacon (~2,040), votes, first loads, outbox —
rounding error next to the polls. 7.5 s keeps about a quarter of the tier spare
for a longer session or a bigger squad; 6 s would spend 94%, which is not a
margin. **Redo the arithmetic before changing it:**
`polls/day = players × hours × 3600 / interval_seconds`.

Worst case for a phone to notice a pause is now ~1 s (beacon) + 7.5 s (poll)
≈ 9 s, typically half that.

**The bar then sat a steady ~6 s behind the phone.** Not drift — a constant
offset, because `played_ms` is measured on the Pi at its last beacon and the
client treated that reading as current. `/api/now` now returns
`played_ms_age_ms`, and the client adds it while playing (never while paused,
where the position is not advancing). It is in the effect's deps on purpose, so
the bar re-anchors to the Pi every poll rather than free-running on the phone's
clock for the length of a song. An age rather than a timestamp, so neither side
needs a synchronised clock.

## Featured artists were losing their artwork (2026-08-05)

"90210" and "Homecoming" showed colour blocks while single-artist tracks on the
same albums resolved fine. AVRCP reports every credited artist comma-joined —
`Travis Scott, Kacy Hill`, `Kanye West, Chris Martin` — and catalogues file the
track under the lead alone, with the guest in the title.

The search was never the problem: Deezer finds those tracks perfectly well with
the full credit string. `pick()`'s exact artist filter was discarding the
correct results afterwards.

`pick()` now tries an exact artist match **first** and only falls back to the
lead artist when nothing matched, so precision is never given up when it was
available. The reduction is applied to both sides, which is what makes it safe
for names that really do contain a separator — "Simon & Garfunkel" and "Earth,
Wind & Fire" reduce identically on the phone and in the catalogue, so they
still match themselves. Karaoke records are still excluded: "Lullaby Versions
of Paramore" reduces to itself and never equals "paramore".

All five production tracks now resolve to the exact album the phone reported,
verified by comparing cover hashes, all images HTTP 200.

## Deploys take up to ~2 minutes to propagate

Measured 2026-08-05: a `wrangler deploy` reporting success was still serving
the previous code 80 seconds later, and only flipped at ~100s. An earlier probe
during the same window returned a mix of new 204s and stale 404s from
successive requests to the same URL.

**So a verification run immediately after a deploy tests the OLD worker.** Two
different bugs looked real for several minutes because of this. Wait ~2 minutes,
or poll for a known new behaviour before concluding anything.

## Known issues, not yet addressed

**~~Heartbeats dominate the outbox.~~ FIXED 2026-08-04.** It peaked at 98.5%
(2,498 of 2,530 rows). Heartbeats no longer touch the outbox at all: they are
now a live `POST /api/pi/beacon` in `pi/lockerroom/control.py`, and the outbox
holds only plays and their PATCHes — the things spec §5.3's never-drop rule is
actually about. A missed beacon is skipped, not queued; the next one is 60s
away. `sync.heartbeat_loop` remains as a stub that raises, so an older
deployment fails loudly instead of quietly refilling the table.

The historical heartbeat rows are still on disk and still marked synced, so
they will never replay. Left alone deliberately — spec §5.3 says never delete
from the local DB.

**Two plays have `played_ms=NULL`** — 16 `POST /api/plays` against 14 `PATCH`es.
Plays that opened and never closed, most likely cut off when the Pi lost its
network mid-session. Harmless; the vote window falls back to
`started_at + duration_ms + 30s` per spec §6.3. Worth knowing that fallback has
now been exercised for real.

**Bluetooth range.** `hci0` is `Bus: UART` — the built-in radio, which shares
its antenna with wifi. The USB dongle from the spec's parts list is not plugged
in. **Deliberately deferred by Mack** until range actually causes a problem; do
not re-raise unprompted.

**How the Pi gets internet: SOLVED — `HCGuest`, verified 2026-08-04.**

`HCGuest` is a genuinely open network (`Security: None`, no PSK, no 802.1X),
with **no captive portal** and **no TLS interception** (cert chains to Google
Trust Services and verifies against the system store). It is an OWE transition
network — there is a companion `_owetm_HCGuest_*` BSS — but the plain open BSS
associates fine and that is what the Pi uses.

The Pi is configured and running on it. Wifi is managed by **NetworkManager**,
not `wpa_supplicant.conf` — there is no such file on this box, so use `nmcli`:

```bash
sudo nmcli connection add type wifi con-name HCGuest ifname wlan0 ssid HCGuest \
  connection.autoconnect yes connection.autoconnect-priority 20 ipv4.method auto
sudo nmcli connection modify HCGuest wifi.cloned-mac-address permanent
```

`cloned-mac-address permanent` matters: NetworkManager randomises by default,
and a guest network that meters or expires sessions per-MAC would see a brand
new device on every reconnect.

**The MACs below are the DEAD 2026-08-12 board's. The v2 box is different
hardware:** wlan0 `98:fe:54:34:14:12`, Bluetooth `98:fe:54:34:14:13`. That is
the pair to hand over if the school ever adds device registration, and the one
to put in a DHCP reservation. Old board, for the record: wlan0
`e4:5f:01:c2:6e:ab`, eth0 `...a9`.

**Profile re-created on the v2 box 2026-08-19, off campus.** You do not need to
be in range: `nmcli device wifi connect` scans and therefore does, but
`nmcli connection add` writes the profile offline and NetworkManager joins when
it first sees the SSID. Priority 20 against home wifi's 0.

Verified with the ethernet cable physically unplugged: the Pi holds
`10.104.239.147/19` and heartbeats reach production continuously.

Two things still unmeasured: signal in the actual locker room (it saw HCGuest
at **-71 dBm** from the desk, workable but not strong), and whether the guest
network expires sessions on a timer. A daily cut-off would show up as the Pi
going quiet at the same time each day; the outbox means no data is lost, but
live now-playing would stop.

**Remote access to the Pi is NOT solved, and cannot be from HCGuest.** Both
standard answers are blocked there, measured directly:

- **Cloudflare Tunnel is impossible.** The edge requires outbound 7844; that
  port is blocked for both TCP and UDP, while TCP 443 to the *same* edge IPs is
  open. Every cloudflared protocol uses 7844, so there is no configuration that
  works. `cloudflared` is installed and fully configured on the Pi (tunnel
  `lockerroom-pi`, `pi.finestkindfarms.com` CNAME already created) but the
  service is **disabled** — if IT ever opens 7844, enabling it is one command.
- **Tailscale is blocked by SNI.** Proven at the TLS layer, not guessed: to the
  same IP and port, SNI `controlplane.tailscale.com` gets no handshake at all
  while SNI `example.com` returns `CONNECTED` / `Verify return code: 0 (ok)`.
- **Plain 443 to anywhere else is fine** — github.com 200, cloudflare.com 301,
  the Worker 200.
- SSH between guest clients is filtered: ICMP passes (ping succeeds, 0% loss)
  but TCP/22 times out, so a laptop on HCGuest cannot reach the Pi either.
- **Outbound TCP/22 is blocked too, so `git push` does not work on campus.**
  Measured 2026-08-12 from `10.104.252.169`: `ssh -T git@github.com` times out.
  **Fixed — the remote now uses GitHub's SSH-over-443 endpoint**, which
  authenticates fine on campus with the same key:

  ```bash
  git remote set-url origin ssh://git@ssh.github.com:443/MMV17/locker-room-music.git
  ```

  Verified in both directions from campus wifi: port 22 times out, port 443
  returns `Hi MMV17! You've successfully authenticated`. So the filter is not
  blocking GitHub — it is blocking the port. Do not set this back to
  `git@github.com:...` or pushing from school silently stops working again.

So SSH is reachable **only by physical access** (USB-C ethernet + Internet
Sharing). For the common case there is now a control channel instead — see
below. One consolation: because HCGuest is open rather than
802.1X, macOS will now share it, so the iPhone-hotspot step in "Reaching the
Pi" below is no longer needed.

`sshd` was hardened while this was set up — `PasswordAuthentication no`, key
only. Note the drop-in is `/etc/ssh/sshd_config.d/01-lockerroom.conf`: it must
sort **before** `50-cloud-init.conf`, which sets `PasswordAuthentication yes`,
because OpenSSH takes the *first* value it obtains, not the last. Named `99-`
it is silently ignored.

**Remote admin access.** Campus wifi has client isolation (verified: an ARP
sweep of all 512 addresses in `10.6.14.0/23` drew replies from exactly two
hosts) and blocks Tailscale's control plane. Cloudflare Tunnel is the intended
answer and the zone is now on Cloudflare, so it is unblocked whenever you want
it. `workers.dev` is **not** blocked — an earlier claim that it was turned out
to be missing certificates on an undeployed hostname, not filtering.

---

## The repo directory ends in `.nosync` — do not rename it (2026-08-04)

The checkout lives at
`~/Desktop/Home_Projects/locker-room-music.nosync`. **The suffix is
load-bearing.** iCloud Drive skips anything whose name ends in `.nosync`, and
that is the only thing keeping this repo out of iCloud.

It matters because the Desktop is iCloud-managed on this Mac
(`com.apple.Dataclass.CloudDesktop` is active), which had two consequences:

1. **Intermittent `EPERM`.** Terminal's `kTCCServiceFileProviderDomain` is
   denied. Files are fine until iCloud *evicts* one; reading it back then goes
   through the FileProvider and fails. That is why it worked for weeks and then
   broke — it only fires on evicted files. The workaround reached for in the
   moment was granting Terminal **Full Disk Access**, which bypasses the check
   but is a far bigger grant than the problem deserves. Desktop access, granted
   back in 2022, is all this actually needs.
2. **420 MB of `node_modules` churning through iCloud sync**, next to a `.git`
   directory. A corruption and thrash hazard on its own merits.

Renaming the folder back — or moving it anywhere under Desktop or Documents
without the suffix — silently reintroduces both.

If the path ever does change, two things break and neither is obvious:

- **`.venv/` hardcodes absolute paths** (29 files). Recreate it, do not move
  it: `python3 -m venv .venv && .venv/bin/pip install httpx pytest-asyncio pytest`.
- **Claude Code keys session history off the cwd**, slugified with `/`, `.`,
  and `_` all becoming `-`. This path maps to
  `~/.claude/projects/-Users-mackvinton-Desktop-Home-Projects-locker-room-music-nosync`.
  Pre-rename history is preserved under the old `...-locker-room-music` slug;
  both were kept deliberately.

`node_modules` survived the rename untouched, and git needed nothing — it
resolves its worktree path at runtime.

## Environment

- **Repo location:** `~/Desktop/Home_Projects/locker-room-music.nosync`. The
  `.nosync` suffix is load-bearing — see "Why `.nosync`" below. Do not rename it
  back.
- **Pi:** Pi 4B, Debian 13 (trixie), Python 3.13, MAC `e4:5f:01:c2:6e:a9`,
  passwordless via `~/.ssh/id_ed25519`. **Its address is not stable** — it has
  been moved off the home network, so `192.168.1.6` is dead. See "Reaching the
  Pi" below.
- **Node:** now nvm `v24.14.0`, on PATH by default. The old `~/.local/node`
  (v22.14.0) has been deleted — ignore any `export PATH="$HOME/.local/node/..."`
  in older notes. That install was x86_64 under Rosetta, so `backend/node_modules`
  had to be rebuilt for arm64 (`rm -rf node_modules && npm install`). If tests
  ever die with a rollup `MODULE_NOT_FOUND`, that is this, recurring.
- **Local venv** for the Pi tests: `.venv/` in the repo root. Python 3.9.6 from
  CommandLineTools; only `httpx` and `pytest-asyncio` are needed. Rebuilt
  2026-08-04 after the `.nosync` rename.

## Why `.nosync` — and do not give Terminal Full Disk Access (2026-08-05)

The Desktop is iCloud-synced (`com.apple.Dataclass.CloudDesktop` is active), so
this repo used to live inside an iCloud FileProvider domain. Terminal's
`kTCCServiceFileProviderDomain` is set to **0 (denied)**. When iCloud evicts a
file and something reads it back, that read goes through the FileProvider and
fails with **EPERM** — intermittently, which is why it worked for weeks first.

Full Disk Access makes the symptom vanish because it bypasses the check
entirely. That is a sledgehammer for a laptop that holds production secrets in
`backend/.secrets.local`; it was granted 2026-08-04 21:02 and should be **off**.
Terminal has had plain Desktop access since 2022, which is all this needs.

Renaming to `locker-room-music.nosync` takes the repo out of iCloud's scope
entirely — iCloud skips anything ending in `.nosync`. That fixes the EPERM at
the source rather than papering over it, and stops 420 MB of `node_modules`
churning through sync.

Verified after the rename: git intact on `phase5-voting-site`, 19 Pi tests pass,
19 backend tests pass, no stale absolute paths in rc files, launchd, cron, or
git config. `.venv/` **had** to be rebuilt — a venv hardcodes absolute paths in
29 files. If it ever breaks again:

```bash
rm -rf .venv && python3 -m venv .venv
.venv/bin/pip install httpx pytest-asyncio pytest
```

Claude Code keys its chat history on the cwd with separators flattened to
dashes, so the history moved to
`~/.claude/projects/-Users-mackvinton-Desktop-Home-Projects-locker-room-music-nosync/`.
The pre-rename transcript is still at the old slug (same path minus `-nosync`).

## The code now has a second copy (2026-08-05)

Leaving iCloud removed the only offsite copy this repo had, so the code went to
GitHub: **`git@github.com:MMV17/locker-room-music.git`, private**. Both `main`
and `phase5-voting-site` are pushed.

Commits are authored as `Mack Vinton <MMV17@users.noreply.github.com>`, set
**repo-local** — git could not auto-detect an identity once the hostname
started resolving as `Mac.(none)`, and the noreply address keeps a real email
out of permanent history. Other repos on this machine still have no identity
set and will hit the same wall.

Still **no Time Machine destination** (`tmutil destinationinfo` → none). Git
covers the source; it does not cover `backend/.secrets.local`, which is
gitignored and remains the only copy of `MAC_SALT`. That one still needs to
live somewhere off this laptop.

## There are TWO Raspberry Pis and both answer to `raspberrypi` (2026-08-09)

**`raspberrypi.local` resolves to the WRONG box.** Cost real time on 2026-08-09
during an outage, which is exactly when you cannot afford it.

| | AuxGoat Pi | the other one |
|---|---|---|
| Model | **Pi 4B** | **Pi 5 Model B Rev 1.1** |
| `wlan0` | `e4:5f:01:c2:6e:ab` | `88:a2:9e:28:8e:e8` |
| `eth0` | `e4:5f:01:c2:6e:a9` | `88:a2:9e:28:8e:e7` |
| hostname | `raspberrypi` | `raspberrypi` ← same |
| tell-tale | `/etc/lockerroom` exists | `docker0` + `tailscale0`, no lockerroom units |

On 2026-08-09 `raspberrypi.local` resolved to **192.168.1.73**, which is the
**Pi 5 and NOT the speaker**. It answers SSH on the home network, looks
plausible, and has none of this project on it.

**Identify by MAC, never by hostname or mDNS.** The OUI is enough: the AuxGoat
Pi is `e4:5f:01:*`, the other is `88:a2:9e:*`. To find the real one:

```bash
# sweep the LAN, then look for the OUI
for i in $(seq 1 254); do ping -c1 -W200 -t1 192.168.1.$i >/dev/null 2>&1 & done; wait
arp -a | grep -i "e4:5f:1"
```

If that prints nothing, the speaker is not on that network — do not go hunting
through `raspberrypi.local`, it will hand you the Pi 5 again.

Two quick confirmations once connected:

```bash
tr -d '\0' < /proc/device-tree/model     # must say "Raspberry Pi 4 Model B"
ls /etc/lockerroom                        # must exist
```

## Reaching the Pi

Wifi is unreliable for this now — the Pi's stored credentials are for the old
home network. The dependable path is **USB-C ethernet straight to the Mac**:

1. Pi → ethernet → USB-C adapter → Mac
2. Mac must be on a **non-802.1X** network first. macOS refuses to share an
   802.1X connection, and every campus SSID is WPA2 Enterprise — use the iPhone
   hotspot.
3. System Settings → General → Sharing → Internet Sharing: from **Wi-Fi**, to
   the **USB ethernet adapter**
4. `cat /var/db/dhcpd_leases` → the Pi appears as `raspberrypi`, typically
   `192.168.2.2`. Then `ssh pi@192.168.2.2`.

Without Internet Sharing on there is no DHCP server, and the Pi cycles its
interface every ~45s on DHCP timeout — it looks like a boot loop but is not.
Symptom: it answers `ping6 ff02::1%en7` for a few seconds, then vanishes, on
repeat. Check `uptime` once you are in; it will show no reboots.

## Commands

```bash
# Pi listener tests (14)
.venv/bin/python -m pytest pi/tests/ -q --asyncio-mode=auto

# Deploy listener to the Pi and restart it
./pi/scripts/deploy.sh

# Watch the Pi live
ssh pi@192.168.1.6 "sudo tail -f /var/log/lockerroom/listener.log"

# Back up production D1 (spec 13). Writes outside the repo, verifies the dump
# is usable, keeps 30. Restore instructions are in the script's footer - read
# them before you need them. Time Travel (30 days) is the first thing to reach
# for; this dump is for damage older than that.
./backend/scripts/backup.sh

# Deploy the team Worker. The `cd backend` is NOT optional and NOT cosmetic.
# Run `npx wrangler deploy` from the repo root and wrangler finds no config,
# silently scaffolds a wrangler.jsonc, and creates a SECOND Worker named after
# the directory — locker-room-music-nosync — serving web/ as static assets.
# It does not touch the real Worker, so hc.auxgoat.com keeps serving the old
# build and it looks like slow propagation. Done by accident 2026-08-05.
# There are two Workers now, so there are two ways to get this wrong.
cd backend && npx wrangler deploy

# Deploy the front door. No build step — its only asset is a committed font.
cd apex && npx wrangler deploy

# Backend unit tests (36)
cd backend && npx vitest run

# Front door tests (35). No wrangler, no deploy — the Worker's fetch is called
# directly with absolute URLs, which is the ONLY way to cover host-based
# behaviour: `wrangler dev` rebuilds every request URL against its own bind
# address, so the Worker always sees localhost no matter what Host header or
# even `curl --resolve` hostname is presented. Measured 2026-08-08.
# It also rewrites Location headers on the way out, so /go looks like it
# redirects to hc.localhost:8788 unless you pass -H 'Host: auxgoat.com'.
cd apex && npx vitest run

# Frontend: build into backend/public/, or run a dev server on :5173 that
# proxies /api to wrangler on :8787
cd web && npm run build
cd web && npm run dev

# Backend end-to-end (35) — needs `npx wrangler dev --local` running first.
# Safe to re-run against the same local D1; fixture ids are unique per run.
cd backend && ./test/e2e.sh

# If local D1 is ever empty (or you wiped .wrangler/state), reload the schema
# or every test fails with "Not signed in":
cd backend && npx wrangler d1 execute lockerroom --local --file=./schema.sql
```

## Services on the Pi

`bluetooth`, `bluealsa`, `bluealsa-aplay`, `bt-agent`, `keep-discoverable`,
`lockerroom-listener` — all enabled, all `Restart=always`, all survive reboot.
Config lives at `/etc/lockerroom/config.toml` (mode 600, not in the repo).
Local DB at `/var/lib/lockerroom/lockerroom.db`, logs at
`/var/log/lockerroom/listener.log`.

---

## AVRCP quirks found on a real iPhone

Phase 2 was where the surprises lived, exactly as the spec predicted. Eight
bugs, none visible from reading code. The four that would have been worst:

1. **`unwrap` did not recurse into Variant payloads.** `Track` arrives as a
   Variant wrapping a dict of Variants, so `Title`/`Artist` stayed wrapped and
   crashed on `.lower()` — on *every* track change.
2. **Transport-idle killed pause/resume.** The A2DP transport goes idle a beat
   after every pause. Closing the play there defeated the 60s resume grace, and
   since phones do not re-send metadata for an unchanged track, resumed
   playback was recorded as *nothing at all*.
3. **iOS re-emits the outgoing track at every change**, ~600ms before the new
   one. A time-window debounce cannot fix this (observed re-emits 35s in);
   playback **Position** is the discriminator — a real replay resets to ~0.
4. **Transitional metadata leaks in.** When audio output routing changes, iOS
   emitted `Artist="Listening on iPhone"`, `Title="Decode • Paramore"`. The
   2-second create-grace discards it before it can become a permanent artist
   row.

**Known gap:** the position-based restart path (hitting repeat on the
*currently playing* song, back-to-back with nothing in between) is covered by
unit tests but was never exercised on real hardware. Android was skipped
entirely by decision — expect its own surprises.

---

## Three lifecycle bugs found from one screenshot (2026-08-05)

A pause at 1:00 showed on the site as **ENDED · VOTING CLOSES IN 0:07**, with
the progress bar reading 1:30. Reading the D1 `plays` table and the listener
journal together turned that one symptom into three separate bugs, all now
fixed and all with a test that fails without the fix.

The lesson worth keeping: **the journal and the D1 table disagreed**, and the
disagreement was the whole diagnosis. The Pi logged closes that D1 never
received, and D1 held plays the Pi had no record of opening. Neither source
alone showed anything wrong.

### 1. The A2DP transport idle raced the AVRCP pause, and won

BlueZ delivers the transport's `State` and the player's `Status` as two
independent `PropertiesChanged` signals, and `BluezWatcher` fires each into its
own `asyncio` task. There is no ordering guarantee between them. On a pause,
whichever lands first wins.

`on_transport_state_changed` guarded against this by checking
`play.status == "paused"` — which is useless when the idle arrives *before* the
status that would have set it. Production caught it doing exactly that:

```
14:27:55,540 play closed (transport_idle): It's Up ... played=60987ms
```

60987ms is 1:00.987 — the instant of the pause, with no `play paused` line
anywhere before it. The play went playing → closed, skipping paused entirely.
That is the screenshot.

**Fix:** transport idle no longer closes anything directly. It arms a 5s
`TRANSPORT_IDLE_GRACE` watchdog, and any AVRCP status in the meantime cancels
it (so does the transport going active again). If nothing contradicts the idle,
the play closes — dated to the *idle*, not to the decision, so the grace is
never banked as playback and can never push a play over the 30s counted
threshold it did not earn.

Note this is the same failure surface as AVRCP quirk #2 above, which was
"fixed" by checking `play.status`. That fix was correct for the case where the
signals arrive in order, and silently wrong the rest of the time.

### 2. Watchdog closes cancelled themselves before they could be written

`_close_play` cancels the play's timers. When it is called *from inside* one of
those timers, it cancels the task it is running on — and the `CancelledError`
is delivered at the next `await`, which is the outbox enqueue three lines
later. The play closed on the Pi, logged as closed, and **the PATCH was never
enqueued**. In D1 the row stays open forever: no `ended_at`, no `played_ms`,
`counted` stuck at its insert default of 1.

Two production rows were in exactly this state, and the correlation was total —
*every* play closed by a watchdog, and *only* those, was missing from D1:

```
12:47:12 play closed (pause_timeout): 90210 ... played=28341ms   -> ended_at NULL
14:23:51 play closed (pause_timeout): Circadian Rhythm ... 18240 -> ended_at NULL
```

This is not a rare path. `_duration_watchdog` fires on every song the phone
lets run out without queueing another — the last song before someone unplugs.

**Fix:** `_close_play` skips `asyncio.current_task()` when cancelling.

### 3. Two track changes in one tick opened two plays

`on_track_changed` read `session.current_play`, awaited the close of the
outgoing play, and only then wrote the new one back. Nothing serialised the
handlers, so two `Track` signals in the same tick both passed the "is this the
same track?" check and both opened a play. The loser is orphaned: never
closed, never keepalived, no `played_ms`.

It gets worse. The orphan captured `moment = now()` *before* its await, so it
carries the **later** `started_at` — and `/api/now` selects
`ORDER BY started_at DESC LIMIT 1`. **The site was showing the phantom.** It
can never pause, never end, and never receive a keepalive, and votes cast on it
land on a row the Pi has never heard of. One thumbs-up on "Recognize" did
exactly that.

Four such pairs landed in eleven minutes on 2026-08-05, 15ms apart each time.

**Fix:** a single `asyncio.Lock` in `SessionManager`. Every sink entry point
takes it and delegates to a `_`-prefixed internal that assumes it is held.
Internals call internals — calling a public method from inside one deadlocks.

### The test suite could not have caught #3, and that was fixable

`FakeStore.enqueue` was `async def` with no `await` inside, so it never
suspended, so every handler ran start to finish and no test could observe an
interleaving. The real `Store.enqueue` goes through `asyncio.to_thread` and
always yields. Adding one `await asyncio.sleep(0)` to the fake makes the
duplicate-play race reproduce on demand — verified by neutering the lock and
watching the new test fail with `['Come and See Me', 'No Face', 'No Face']`.

**A fake that cannot yield cannot model a concurrency bug.**

### Data repaired

The phantom rows are `voided = 1` rather than deleted, so the pairs stay
inspectable; the misplaced vote was re-pointed to its real twin first. The two
watchdog casualties were closed using the `played_ms` and timestamps from the
journal — recovered values, not invented ones.

**Left alone:** `ee1e30b9` (Imma Be) and `08485fa7` (POWER), both open since
2026-08-04. They are almost certainly the same watchdog bug rather than the
network loss recorded earlier in this file, but the journal does not reach back
that far and there is nothing to recover them from. Reconstructing them would
be fabrication.

### Verified on real hardware, 2026-08-05

Eight plays, three pauses. All eight carry an `ended_at`. No duplicate pairs.
Two `pause_timeout` closes reached D1 — the exact case that used to vanish.
One pause-then-resume stayed a single play. **Zero `transport_idle` closes:
the 5s grace absorbed every one of them**, which is the whole point. The site
showed **PAUSED** with the bar frozen at 0:18 against a `played_ms` of 18465.

`docs/` also holds the pre-fix evidence if any of this ever regresses.

### The bar also ran past the end of the song

Client-side, and separate: `useElapsed` froze on `paused` but not on
`ended_at`, so it kept ticking through the whole 30s vote grace. A play that
closed at 1:00 read 1:30 under an "Ended" label. `played_ms` is final once the
Pi closes a play, so the anchor is now exact and the tick stops.

---

## Frontend — the direction, now settled

The spec's §9.2 direction (scoreboard slot, condensed athletic block type,
jersey typography) was rejected by Mack up front and is **dead**. Do not
revive it.

What replaced it, from a reference screenshot Mack supplied — a light music
player UI:

- Pale cool-grey page (`#EDF0F5`), white surfaces, generous whitespace
- Rounded-square artwork as the hero, soft wide shadow
- Very large geometric-sans headings against small grey secondary text; the
  type carries the identity and the layout stays quiet
- Flat monochrome inline SVG icons. **No emoji anywhere** — explicit request
- **The accent colour appears in very few places** — the active tab underline,
  the jersey badge, the primary button, the active nav pill

That last point is the load-bearing one. Accent-only is what lets an arbitrary
school colour drop in: a pale gold that would be unreadable as a background is
fine as a 3px rule. `web/src/theme.ts` derives `--team-ink` (darkened until it
clears 4.5:1 on white), `--team-on` (readable *against* the fill), and
`--team-soft` from the single admin-set hex.

**Thumbs stay green and red regardless of team colour.** Semantic colour
outranks brand colour on the one control the product exists for. If a school
is red, the down vote is still red.

Type is Outfit Variable, self-hosted via `@fontsource-variable/outfit` — never
a Google Fonts CDN link, because campus wifi is unpredictable and the type is
the identity. `unicode-range` means the 15KB latin-ext subset only downloads if
a track title actually needs it.

### "Live" meant something much narrower than it sounded (2026-08-05)

**The header now reads "Speaker online / Speaker offline".** "Live" was being
read as "music is playing", which it never meant. `speaker_online` is only
whether the Pi has beaconed within three minutes — the box is powered up and
has a network. It says nothing about a phone being connected over Bluetooth or
about anything coming out of the speaker. Playing/paused is its own line under
the progress bar now, so the header can name its actual subject.

**The AuxGoat logo was tried in the header and rejected by Mack. Do not
re-add it.** Recorded because the constraint is real and someone will try
again: the mark is cream and gold on solid black, and **87% of the artwork is
that black field** (measured). It cannot sit on the pale page, and the black
cannot be knocked out either — what survives is white marks, invisible on
white. The only honest presentation is a dark tile, which was built, looked
fine, and was still not wanted. `web/src/vite-env.d.ts` is left behind from
that attempt: standard Vite boilerplate, costs nothing, and means the next
image import will not type-error.

### Known: a tab that mounts while hidden shows a spinner until it is focused

`NowPlaying`'s poll does `if (document.hidden) return;` **before** the first
`load()`, so `loading` never clears and the screen sits on a spinner. It
recovers on `visibilitychange`, so a real user never sees it — they are looking
at the page. It bit repeatedly while screenshotting in automation, where the
window is unfocused. Worth knowing before mistaking it for a broken build.

### The header, and getting the thumbs above the fold (2026-08-05)

Two complaints, one screenshot: the top row looked messy, and the vote buttons
sat behind the tab bar.

**The header was a `space-between` flex row** holding status, team name and
jersey. That only centres the middle item when the two flanking it are the
same width, which they never are — "HOLY CROSS" measured **45px right of
centre**. A centred grid row fixes the arithmetic but not the fit: "Speaker
offline" + "Holy Cross" + jersey is wider than a 375px phone, and a longer
team name overruns even 393. It collided outright:
`SPEAKER OFFLINEHOLY CROSS`.

Stacking it onto two rows worked and was rejected on sight — correct geometry,
still the wrong emphasis. **The status is an icon now**, a 30px square in the
corner opposite the jersey. That fixes both problems at once: the rails are
balanced by construction, so the centre is exact for free, and the row is back
to 30px. Measured, the gaps either side of the team name are now *identical*
to a tenth of a pixel at every width, including a long team name.

The full sentence survives in `aria-label` and `title` — spelled out on screen
it cost a whole line of header and pulled the eye to the least important thing
there. The waves versus the strike-through carry the state, so colour says it
a second time and is never the only thing saying it.

**For the fold**, the artwork gained an `svh` term. Width alone cannot know
how much vertical room is left, so on a short viewport the art kept its 62vw
and pushed the thumbs off the bottom. Height-relative it yields exactly the
scarce dimension. Plus a `max-height: 700px` query that tightens *everything*
— on an SE the problem is the sum of the furniture, not the art alone.

Measured clearance from the thumbs to the tab bar, nothing scrolling:

| viewport | before | after |
|---|---|---|
| 393×852 | fits | 144px |
| 393×740 (Safari chrome showing) | behind the bar | 45px |
| 375×667 (iPhone SE) | 33px behind | 40px |
| 360×780 (Pixel) | behind the bar | 91px |
| 430×932 | fits | 208px |

Below ~600px of height it scrolls again, and that is the honest answer —
artwork, three metadata lines, a DJ chip, a progress bar, a status line and
two 84px targets do not fit in less.

**How this was measured.** Not by eye: a static harness reproducing the
NowPlaying DOM against the built CSS, loaded into fixed-size iframes, printing
the centre offset and the thumb-to-tabbar clearance at each size. Auth-free,
so it iterates in seconds. `.vote` also came down 104px → 96px; the floor is
Apple's 44pt touch target and this is still more than double it. A control you
have to scroll to reach is worse than one 8px smaller.

### Playback state and the voting countdown (2026-08-05)

A line under the progress bar: **Playing / Paused / Ended**, then how long is
left to vote. It says how long the door is open and never what is behind it —
non-negotiable #2 is untouched.

**It does not count down to `vote_closes_at`, and must not.** While a song is
live the Pi's beacon keeps rolling that timestamp forward (keepalive + 150s +
30s) — which is exactly what holds the window open through a pause — so
rendering it raw would tick down and then visibly jump *up* every time a beacon
landed. Instead it counts down to `duration - elapsed + VOTE_GRACE_MS`, which
decreases smoothly and is correct in the normal case, and switches to the exact
`ended_at + grace` once the song genuinely ends.

Three states worth knowing:

- **Paused** shows "Voting stays open" rather than a number. The window really
  does stay open while the Pi says the song is on the speaker, so any countdown
  there would be a lie.
- **Ended** is its own state. A closed play keeps whatever `play_status` it last
  had, so a finished song still claims to be playing — found by testing, where
  it read "PLAYING · VOTING CLOSES IN 0:01". `ended_at` is the authority once
  it exists.
- **Under 30s** turns red, the same semantic red as the down vote. It is a
  deadline, not a brand moment.

`useElapsed()` is shared with the progress bar deliberately — two readings of
the same clock computed separately is how they end up a second apart on screen.
`VOTE_GRACE_MS` is duplicated from the Worker's `voteWindow.ts`; if spec 6.3's
30s ever changes, both move.

**The 30s grace does NOT block voting on the next song.** Worth writing down,
because it looks like it should. Measured directly with song A ended 5s ago and
song B started 5s ago:

- `/api/now` immediately returns **song B**, `vote_window_open: true`
- a vote on song B → **200**. Votable from the instant it starts, which is when
  people react hardest to hearing it
- a vote on song A → also **200**. The server honours the tail of A's window

The windows overlap rather than queue: `isVoteWindowOpen` is evaluated per play,
and B's opens at B's `started_at`. What is genuinely lost is the *tail* of A's
grace, because the screen has moved to B and A's reveal has fired — the server
would still accept it, but nothing in the UI offers it. That only matters for
back-to-back songs; with any gap between them the grace works as spec 6.3
intended.

### The AuxGoat (2026-08-05)

The DJs board leads with a card reading **"{name} is the AuxGoat"** — the top
qualified DJ, tying the board to the domain the product lives on. It is the
only celebratory element in the product, so it gets a card rather than a badge
on row one; a badge is lost in a list, and this is the thing anyone would
actually screenshot. No emoji, per the frontend direction — the weight comes
from the type and one accent word in `--team-ink`, the contrast-corrected
variant, so an arbitrary school colour still clears 4.5:1 on white.

**A shared top score renders "Tied for AuxGoat" and names everyone on it.**
Crowning one of two people on an identical score would be a coin toss presented
as a fact, and early in a season — before many songs have been rated — matching
`djScore` values are entirely ordinary. Both branches were verified in the
browser, the tie by intercepting the leaderboard response rather than
contriving one in the database.

Only ever shows qualified DJs, so it inherits spec 7.2's five-play threshold:
nobody is crowned off two lucky songs.

### Decisions made during the build

- **Thumbs up/down only.** A four-level scale (double thumbs) was designed and
  then cancelled before implementation. `votes.value` keeps its
  `CHECK (value IN (-1,1))` and `scoring.ts` was never touched.
- **A DJ cannot vote on their own song** — enforced in `POST /api/votes`, with
  their private qualification standing shown where the controls would be.
- **Players sign themselves up** (team code + first name, last name, number).
  No admin-curated roster, no per-player PIN. The team code is therefore the
  only gate: anyone holding it can register under any name, including a
  teammate's. Accepted knowingly; admin can deactivate a bad row after the
  fact. Signup is idempotent on `identity_key` so a cleared cookie or a new
  phone finds the existing player instead of forking their history. Jersey
  numbers may repeat across players by decision. `position` is gone entirely.
- **Device claiming is first-tap-wins**, mitigated by a confirm step naming the
  device and the song count. See the comment in `devices.ts`.

### Where it lives

`web/` — Vite + React + TS, no UI library, no CSS framework. Builds to
`backend/public/`, which the Worker serves via its `[assets]` binding.

Same-origin is deliberate: the session cookie is `SameSite=Lax`, and a separate
Pages origin would mean it is never sent on API fetches. See the comment block
in `wrangler.toml`.

---

## Non-negotiables (spec 12) — current compliance

1. No microphone / audio capture — **held.** Metadata only, no audio path in code.
2. No live vote tallies — **held and tested.** `/api/now` omits tallies from the
   raw response; `/api/plays/:id/results` returns 403 while the window is open.
3. Raw MACs never leave the Pi — **held and tested.** Salted SHA-256 plus a
   two-octet hint; e2e asserts the raw MAC never appears in a response.
4. Pi writes locally before syncing — **held and verified.** 62 outbox rows
   accumulated with zero dropped during the placeholder-URL outage.
5. Every ranking damped — **held.** `trackScore` k=5, `djScore` m=3, DJs hidden
   under 5 counted plays; the spec's worked examples (0.29, 0.76) are test
   assertions.
