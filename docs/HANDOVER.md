# Handover — 2026-08-31

Paste the block below into a fresh session.

---

I'm working on the AuxGoat locker room music project at
`~/Desktop/Home_Projects/locker-room-music.nosync`. Read `docs/STATE.md` first —
it is the canonical record and is current as of 2026-08-31, including its
"Pick up here" section, which was rewritten on 2026-08-31 and is now accurate.

**Everything is working right now.** The speaker is built, provisioned, deployed
and playing music. Both Workers, D1 and the voting site are healthy. The
2026-08-31 session added automatic audio output routing and a Bluetooth relay.

## Committed and pushed — 2026-08-31

The **aux handover countdown** feature, which for a week existed only in this
working tree while running in production, is committed and on GitHub. Branch
`audio-output-routing`, 21 commits, HEAD `e2c101b`, working tree clean, local
and remote in sync. Its spec is
`docs/superpowers/specs/2026-08-23-aux-handover-countdown-design.md`.

Pushing on campus needs the 443 endpoint —
`ssh://git@ssh.github.com:443/MMV17/locker-room-music.git` — which is already
set as `origin`. Port 22 is blocked.

## Unfinished work, roughly in priority order

1. **Plan 2: the speaker scan-and-select admin UI.** Designed but not planned or
   built. Today the relay speaker is set by a config key on the Pi, which needs
   SSH to change. The intended flow: put the speaker in pairing mode, see
   discoverable devices in the Admin screen, pick one, AuxGoat connects.
   It must ride the existing outbound-443 `pi_commands` channel, because campus
   blocks all inbound access to the Pi. Note this needs the **first
   parameterised command** in a system deliberately built with none — every
   existing command (`restart-listener`, `reboot`, `report-status`) maps to a
   fixed argv. A MAC must be strictly validated on BOTH server and Pi and passed
   as an argv element, never interpolated. See
   `docs/superpowers/specs/2026-08-31-bluetooth-relay-output-design.md`.
2. **Relay longevity is unproven.** It has only run for minutes. On 2026-08-23 a
   relay test wedged the Bluetooth controller "shortly after" starting.
   `lockerroom-btwatch` now recovers that automatically, but a long session has
   not been run.
3. **Artwork: negative responses are cached for 24h.** Both providers fetch with
   `cf: { cacheTtl: 86400, cacheEverything: true }`, which caches failures too,
   so a transient failure sticks for a day and the admin retry cannot clear it.
   Fix is two lines in `backend/src/artwork.ts`:
   `cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "400-599": 0 } }`.
   Low priority — 66 of 73 tracks have artwork and the one real failure heals
   itself. Fold it into the next Worker deploy rather than deploying specially.
4. **No artwork-retry button in the Admin screen.** `POST /api/admin/artwork/retry`
   exists and is documented as the corrective tool, but nothing in the UI calls
   it, so it is only reachable with curl and `X-Admin-Password`.
5. **Junk AVRCP metadata is reaching the play data.** Two tracks recorded
   `"Listening on MacBook Pro"` as the artist and one recorded `adsmoloco.com`
   as a title. Consider filtering at ingest.
6. **Deferred: report the selected audio output in the heartbeat**, so the admin
   screen shows whether the box is on USB, the jack, or the relay. The hook
   already exists at `/run/lockerroom/audio-out`.
7. **Anti-bypass is verified only on the JBL Charge 6.** It is a per-speaker
   property; re-test on any other speaker before relying on it.

## Gotchas that cost real time on this project

- **The Pi test venv is Python 3.9** and `config.py` imports `tomllib` (3.11+),
  so `config.py` cannot be imported by the test suite. MAC validation lives in
  `pi/lockerroom/macaddr.py` for exactly this reason. Run tests with
  `.venv/bin/python -m pytest pi/tests/ -q` (161 passed, 1 skipped).
- **Reaching the Pi:** `pi@192.168.2.3` over USB-C ethernet + macOS Internet
  Sharing. The cable is now safe (`ipv4.ignore-auto-dns` + `never-default` are
  set on the wired connection), but before that it poisoned DNS and made healthy
  wifi look dead while netwatch counted toward a reboot.
- **`iw` is NOT installed on the Pi.** `iw dev wlan0 link` returns
  `command not found`; a naive `|| echo "not associated"` fallback then reports
  the wifi down when it is up. Use `nmcli` and `ip route`.
- **Wifi is locked to 5GHz** (`nmcli connection modify HCGuest
  802-11-wireless.band a`). This is deliberate and load-bearing: it frees 2.4GHz
  for Bluetooth and is what made the relay work.
- **`deploy.sh` scp's the whole `pi/lockerroom` directory**, so it ships
  uncommitted working-tree changes to the Pi. That is how the countdown Pi code
  reached production.
- **`wrangler deploy` deploys the working tree**, so deploying the Worker right
  now would also ship the uncommitted countdown backend changes. They are
  already live, but check before assuming.
- Background a long command with `systemd-run --unit=... --collect`, not
  `nohup ... &` over ssh, which does not survive the session closing.

## USB-C speaker, if it comes up

The JBL Charge 6 over USB works **conditionally**: it needs one specific cable
and a near-full battery. A miswired CC resistor in the other cable advertises
3A and trips the Pi's over-current protection; a battery below ~full draws full
charging current and does the same. The charging current is invisible to USB
(`bMaxPower` reads 100mA), so it is not diagnosable in software. Details in
`STATE.md`. The relay avoids all of this.
