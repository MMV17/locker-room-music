# Choosing the relay speaker from the Admin screen

**Status:** design, 2026-08-31. Follows
`2026-08-31-bluetooth-relay-output-design.md`, which built the relay itself and
listed "scan-and-pick speaker selection UI" as explicitly out of scope: "config
key only in v1". This is v2 of that one line.

## The problem

The relay works. Choosing what it relays to does not.

Today the target speaker is `[relay] speaker_mac` in
`/etc/lockerroom/config.toml`. Changing it means SSH to the box, editing a file
as root, and restarting the listener. **On campus there is no SSH** — 7844 is
blocked so Cloudflare Tunnel cannot run, Tailscale is blocked by SNI, and TCP/22
is filtered between guest clients. So in the one place the box actually lives,
the speaker it plays through cannot be changed at all without carrying a laptop
and a USB-C ethernet cable into the locker room.

The requested flow, in Mack's words: *"put your speaker in pairing mode, select,
and the AuxGoat will connect — keep your device connected to the AuxGoat."*

That last clause is the point of the whole feature and is easy to miss. Phones
stay paired to the AuxGoat exactly as they are now. Nothing about the DJ
experience changes. The only thing being chosen is where the box sends audio
*out*.

## What this is not

- **Not a general remote shell.** See "Security" below; this design makes the
  command channel no more powerful than it is today.
- **Not pairing phones.** Phones pair to the box the way they always have.
- **Not multiple simultaneous outputs.** One speaker at a time, still arbitrated
  by `audio-route.sh`.
- **Not a replacement for `config.toml`.** That key keeps working and remains
  the bootstrap for a box that has never been given a speaker from the UI.

## Architecture

### Scan is a command; selection is state

This is the load-bearing decision and everything else follows from it.

The obvious design — a `set-relay-speaker <MAC>` command — would make this the
**first parameterised command** in a channel deliberately built without any. The
`pi_commands` schema comment says why: *"`command` is validated against a fixed
allowlist on the way in AND again on the Pi. There is deliberately no 'run this
string' command: that would be remote code execution on a device sitting in a
locker room."* Adding an argument column is the first crack in that, and the
crack is permanent.

It is also unnecessary, because the two halves of this feature are different
kinds of thing:

| half | kind | how it travels |
|---|---|---|
| **Scan** | an action, and it takes no parameters | a fourth fixed name on the existing allowlist |
| **Select** | a fact about the box's configuration | a `settings` row, carried on the beacon response |

`pi_commands` is therefore **completely unchanged** — no new column, no
argument, no interpolation, every command still a fixed name mapping to a fixed
argv on both sides.

A MAC does still reach the Pi. It reaches it as **data on the beacon response**,
validated on arrival by `macaddr.normalise`, which is precisely how
`config.toml` values are already handled. `relay.py` already takes a validated
MAC and passes it to `bluetoothctl` as its own argv element. This adds a second
source for that value; it adds no new capability and no new shape of input.

### Selection state, and the three-state key

`settings` key `relay_speaker_mac` (plus `relay_speaker_name`, display only).

| value | meaning |
|---|---|
| **row absent** | never configured from the UI — fall back to `config.toml`, and every code path behaves exactly as it does today |
| **a MAC** | relay to this speaker |
| **empty string** | explicitly cleared — this is the "Use wired output" button |

The distinction between absent and empty is not pedantry. Absent means *no
opinion*, so an existing box that has only ever been configured by file keeps
working untouched. Empty means *the operator said no*, which must override the
file — otherwise pressing "Use wired output" on a box with a `config.toml` entry
would silently do nothing.

**Precedence on the Pi:** server value (when a beacon has ever succeeded) →
locally cached value → `config.toml`.

The cache is `/var/lib/lockerroom/relay-target-mac`, written whenever the server
value changes. It exists because the box must reconnect to the right speaker
after a power cut in a locker room where the network may not come back first.
`/var/lib` rather than `/run` on purpose: this one must survive a reboot, unlike
`/run/lockerroom/relay-target`, whose whole meaning is "a relay is live right
now" and which must NOT survive one.

### Scan results ride the beacon, not the result field

`pi_commands.result` is truncated to 2000 characters by the beacon handler. A
locker room with thirty phones in it overflows that, and a truncated device list
is worse than none — the speaker you want is missing for no visible reason.

The beacon payload already carries structured `current_play` and `aux`. The scan
list goes the same way:

```json
"scan": { "at": "...", "devices": [ { "mac": "...", "name": "...", "cod": 2360324, "rssi": -54 } ] }
```

Server-side this replaces the contents of a new `bt_devices` table wholesale. A
device list is a **snapshot, not a log**: the previous scan is not history worth
keeping, and keeping it would show speakers that have since left the building.

```sql
-- The most recent Bluetooth scan, and only that one. Replaced wholesale on
-- every scan: a device that has left the room must stop being offered.
CREATE TABLE IF NOT EXISTS bt_devices (
  mac        TEXT PRIMARY KEY,
  name       TEXT,              -- NULL when the device advertises none
  cod        INTEGER,           -- Bluetooth Class of Device, NULL if unknown
  rssi       INTEGER,           -- NULL is normal, not an error
  scanned_at TEXT NOT NULL
);
```

`name` is nullable rather than defaulted to the MAC, so that "this device has no
name" stays a fact about the device instead of becoming a fake name the UI
cannot tell apart from a real one.

The command's own `result` stays a one-line human summary — `found 12 devices` —
so the existing command history rows keep reading sensibly.

### The scan itself

A new script, shipped by `deploy.sh` like the others, invoked as a fixed argv:

```
"scan-speakers": ["sudo", "/usr/local/bin/bt-scan.sh"]
```

It runs a timed discovery, then enumerates what was found, emitting one
tab-separated `MAC<TAB>COD<TAB>name` line per device. Class of Device comes from
`bluetoothctl info`; RSSI is included when present and omitted when not, because
it is only populated for devices seen recently and its absence is normal rather
than an error.

**This command needs a longer timeout than the others.** `COMMAND_TIMEOUT_S` is
currently a single module constant of 25s; a 15s discovery plus per-device info
calls exceeds it. `ALLOWED` becomes a mapping to `(argv, timeout)` so the slow
command does not force every command to wait as long as the slowest.

**Discovery must not disturb an active session.** Scanning shares the one
antenna with both the phone's A2DP sink and the outbound relay. The scan is
therefore refused, with a clear result string, while a play is open — pressing
Scan mid-song must not stutter the room's music. This is a refusal on the Pi,
where the play state actually lives, not a guess made server-side.

### Attentive mode

The beacon idles at 60s. Unchanged, that gives: up to 60s before the Pi even
picks the scan up, ~20s to scan, and up to 60s more before the result is
reported — **about two and a half minutes**, against a speaker pairing window
that typically times out after two.

Two changes, one of which is free:

1. **Beacon immediately when a result is pending.** Today the loop sets
   `pending_result` and then sleeps a full cycle before sending it. That is half
   the latency and it is an early-wake that should already have been there.
2. **Attentive mode:** after receiving a command, poll every **5s for 3
   minutes**, then settle back to 60s. Nothing changes when nobody is in the
   admin screen.

**The first press still waits up to 60s and this design does not pretend
otherwise.** Nothing can tell the Pi to pay attention before it next checks in;
the only fix would be permanently lowering the idle interval, which spends the
beacon budget all day for a thing done once a month.

So the UI inverts the order of operations instead:

> **Press Scan. Wait for it to say "scanning". *Then* put your speaker in
> pairing mode.**

The wait moves in front of the pairing window rather than consuming it, and the
2-minute speaker timeout stops being a constraint at all. This is a wording fix
for a timing problem, chosen deliberately over a code fix that would cost more
and buy less.

### Applying a selection on the Pi

`RelayManager` gains `set_target(mac | None)`, called by the beacon loop when the
server's value differs from the one in hand. On a change:

1. Disconnect the old speaker, if any.
2. Remove `/run/lockerroom/relay-target` and re-run `audio-route.sh`, so the box
   drops to a wired output **before** the new attempt rather than after it.
3. `pair` → `trust` → `connect` the new MAC.

`pair` against an already-paired speaker fails with
`org.bluez.Error.AlreadyExists`; that is success and is treated as such. `trust`
is what makes the speaker reconnect on its own after a power cut without anyone
present.

Step 2 before step 3 matters: a failed connection then leaves the box on the
jack, which is audible, rather than pointing at a speaker that never answered,
which is silence with every unit green. That is the same reasoning `relay.py`
already documents for removing the target before rerouting on disconnect.

### Reporting what is actually playing

Folded in from the deferred backlog item, because a selection screen that cannot
show the current selection is half a feature. `audio-route.sh` already writes
`/run/lockerroom/audio-out`; the beacon reads it and reports it, and the Admin
screen shows **USB / 3.5mm jack / relay to <name>**.

The Pi also reports `relay: {mac, connected, last_error}`, which is what lets the
screen distinguish *selected, connecting…* from *selected but will not connect*.

## The screen

A **Speaker output** block inside the existing Admin `Speaker` section:

- **Current output**, one line, from the heartbeat.
- **Scan for speakers**, with live `queued → scanning → done` status and the
  pairing-mode instruction in the order given above.
- **The device list.** Everything found, **audio-class devices sorted to the
  top**, devices with no name shown as their MAC.

Audio-class means the Bluetooth major device class is Audio/Video, which is
bits 8-12 of the Class of Device: `(cod >> 8) & 0x1F == 0x04`. A NULL or
unparseable `cod` sorts with the non-audio devices rather than being treated as
either — it is unknown, and guessing in either direction would be worse than
saying so by position. Within each group, order by descending RSSI where it is
known (the nearest speaker is usually the one in your hand), then by name.
- **Use this one** per row; **Use wired output** to clear.

**Nothing is filtered out of the list.** Class of Device is self-reported and
some speakers report it wrongly or not at all, so filtering on it can hide the
exact speaker being held in front of the box — the one failure that would make
the screen untrustworthy. Sorting gets the same short-list benefit with none of
that risk. Nameless devices are shown rather than dropped for the same reason.

## Security

The threat this channel was designed against is a compromised or misdeployed
server turning a locker-room speaker into a shell. That property is preserved:

- `pi_commands` gains **one more fixed name**, and no argument column. The Pi's
  `ALLOWED` dict remains the second, independent gate.
- The MAC is validated **on the server** before it is stored and **again on the
  Pi** by `macaddr.normalise` before it is used, with the same regex.
- The MAC is passed as **its own argv element** to `create_subprocess_exec`.
  Never a shell string, never interpolated.
- **Scan output is parsed defensively.** Any line whose MAC does not validate is
  dropped, not trusted — the parser treats the Pi's own subprocess output as
  untrusted input, because a device name is chosen by a stranger's phone.
- Device names are rendered as text in the admin UI, never as markup.

## Error handling

| case | behaviour |
|---|---|
| Speaker not in pairing mode | `pair` fails; selection is kept, `last_error` reported, screen says so and suggests pairing mode |
| Speaker out of range at boot | Cached target retried on the existing reconnect loop; wired output meanwhile |
| Server unreachable | Cached target applies; the box keeps playing to the right speaker with no network at all |
| Garbage MAC from the server | Refused by `macaddr.normalise`, logged, previous target left alone |
| Scan pressed mid-song | Refused on the Pi with a clear result string; music undisturbed |
| Scan finds nothing | Empty list, stated plainly, not an error |
| Relay manager dead | `relay-target` absent → wired output → a working speaker, exactly as today |

## Testing

**Pi-side unit tests**, following the existing `pi/tests/` patterns:

| case | expected |
|---|---|
| server sends a new MAC | old disconnected, target cleared, reroute, then pair/trust/connect |
| server sends the same MAC | no-op, no reconnect churn |
| server sends `""` | target cleared, wired output, nothing connected |
| no server value, `config.toml` set | behaves exactly as today |
| server unreachable, cache present | cached target applied |
| garbage MAC from the server | refused, previous target untouched |
| scan output with junk lines | junk dropped, valid devices kept |
| scan while a play is open | refused, clear message |
| attentive mode | fast interval after a command, back to idle after the window |

**Server-side:** MAC rejected at the API, three-state precedence, a scan
replacing prior results, result summary recorded.

**Hardware, which is the only test that counts:**

1. Scan from the Admin screen with a speaker in pairing mode; it appears.
2. Select it; the box pairs, connects, and audio moves to it.
3. A phone plays a song through it end to end.
4. "Use wired output"; audio returns to the jack.
5. Power-cut the box; it reconnects to the same speaker unattended.

## Out of scope

- Forgetting a paired speaker from the UI. Paired speakers accumulate; that is
  cheap and makes returning to one a single tap. Add a Forget button when the
  list is actually annoying, which may be never.
- Multiple relay targets.
- Profile-role detection instead of a MAC allowlist (still the more general
  answer, still not needed).
- Pairing phones from the UI.
