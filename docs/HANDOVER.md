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

## Committed and pushed — 2026-09-01

Branch `audio-output-routing`, **37 commits, HEAD `fe8abfd`**, working tree
clean, local and remote in sync. Nothing is stranded on this laptop.

Everything below is deployed and live: migration 005 on prod D1, the Worker, and
the Pi. Speaker selection works from the team app.

Pushing on campus needs the 443 endpoint —
`ssh://git@ssh.github.com:443/MMV17/locker-room-music.git` — which is already
set as `origin`. Port 22 is blocked.

## Verified on 2026-09-02, in a browser

The Settings screen and the speaker presence gate had both shipped unseen. They
have now been driven end to end against a local Worker at phone width, and all
four branches behave:

- **offline** — "The AuxGoat is offline right now."
- **not connected** — "Connect your phone to the AuxGoat over Bluetooth first."
- **mid-song** — "Someone's song is playing. Wait for it to finish."
- **allowed** — the audio-first list renders, `Show other devices (1)` reveals
  the non-audio one, an unnamed device shows its MAC as the title, and tapping
  one wrote `relay_speaker_mac` / `_name` / `_set_by = u3`, flipped the row to
  "Playing through this" and revealed "Use the cable instead".

The allow path was previously untested because a session would have added a
fake player to the production roster. That objection does not apply to the
local D1, which is already full of "Jake Tester" rows — do it there.

**To set this up again:** the local D1 lags production. Apply `schema.sql`
then `migrations/004` and `005` with `wrangler d1 execute lockerroom --local`
(001-003 are already inside schema.sql and will report duplicate-column, which
is correct). Then give a user a claimed device, point the newest heartbeat's
`aux_holder_hash` at it, and close any open plays or the mid-song interlock
fires. `devices.first_seen` is NOT NULL and is easy to forget — and note that
`wrangler d1 execute` reports a failed INSERT quietly enough to miss if you
grep its output for success rather than reading it.

## Unfinished work, roughly in priority order

1. **Two hardware steps still unrun:** reboot the box and confirm it reconnects
   to the same speaker unattended, and a long relay session for longevity. A
   2026-08-23 relay test wedged the Bluetooth controller "shortly after"
   starting; `lockerroom-btwatch` recovers that automatically now, but no long
   session has been run. **This is the only speaker-selection work left** —
   everything else about the feature has now been seen working.
2. **The page has a background picture**, set by one constant,
   `BACKGROUND_IMAGE`, at the top of `web/src/background.ts`. It takes a
   `/bg/<name>.jpg` path or a full https address. `BACKGROUND_STRENGTH` next to
   it is the opacity and has to be re-judged whenever the picture changes — the
   current one is near-white so it sits at 0.85, where a photograph of a room
   would wash out the type well below 0.4. Downscale anything before adding it;
   `web/public/bg/CREDITS.md` has the one-liner and the reason.
3. **Artwork: negative responses are cached for 24h.** Both providers fetch with
   `cf: { cacheTtl: 86400, cacheEverything: true }`, which caches failures too,
   so a transient failure sticks for a day and the admin retry cannot clear it.
   Fix is two lines in `backend/src/artwork.ts`:
   `cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "400-599": 0 } }`.
   Fold it into the next Worker deploy rather than deploying specially.
4. **No artwork-retry button in the Admin screen.** `POST /api/admin/artwork/retry`
   exists and is documented as the corrective tool, but nothing in the UI calls
   it, so it is only reachable with curl and `X-Admin-Password`.
5. **Junk AVRCP metadata is reaching the play data.** Two tracks recorded
   `"Listening on MacBook Pro"` as the artist and one recorded `adsmoloco.com`
   as a title. Consider filtering at ingest.
6. **Anti-bypass is verified only on the JBL Charge 6.** It is a per-speaker
   property; re-test on any other speaker before relying on it.
7. **No Forget button for paired speakers.** Deliberately out of scope — they
   accumulate, which is cheap, and forgetting one costs the one-tap return.
   Add it when the list actually gets annoying, which may be never.

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
