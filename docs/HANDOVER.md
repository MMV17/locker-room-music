# Handover — 2026-09-07

Paste the block below into a fresh session.

---

I'm working on the AuxGoat locker room music project at
`~/Desktop/Home_Projects/locker-room-music.nosync`. Read `docs/STATE.md` first —
it is the canonical record and is current as of 2026-08-31, including its
"Pick up here" section, which was rewritten on 2026-08-31 and is now accurate.

**Everything is working right now.** The speaker is built, provisioned, deployed
and playing music. Both Workers, D1 and the voting site are healthy. The
2026-08-31 session added automatic audio output routing and a Bluetooth relay.

## Committed and pushed — 2026-09-07

Branch `audio-output-routing`, HEAD **`05e0cbe`** (123 commits), working tree clean,
local and remote in sync. Nothing is stranded on this laptop.

Everything is deployed and live: migration 005 on prod D1, the Worker
(`d732b3c3-42df-4ddf-a840-604b592e83a4`) and the Pi. Speaker selection works
from the team app.

Pushing on campus needs the 443 endpoint —
`ssh://git@ssh.github.com:443/MMV17/locker-room-music.git` — which is already
set as `origin`. Port 22 is blocked.

**Branches, tidied 2026-09-07.** Two locals, `audio-output-routing` (checked
out, and what gets deployed) and `main`, both at the same commit. GitHub's
default branch was `phase5-voting-site` and is now `main`. Two remote branches
hold one unmerged commit each and MUST NOT be deleted — they are the only copy:
`origin/claude/flux-pcb-locker-music-yacr3s` (carrier board, BOM, KiCad library)
and `origin/claude/usb-c-aux-wired-audio-bgycew` (wired-aux feasibility study).

## The stylesheet has a design system now — 2026-09-07

Prompted by "it feels cheap". Audited, and three findings were measurable
rather than taste. All three are fixed and deployed; no new look, same palette,
same layout, same components.

- **Contrast.** `--muted` coloured every piece of secondary text at 2.72:1 on
  `--page`, under the 4.5:1 AA floor. Now `#666d76`. `--up` was 3.30:1, now
  `#12883e`. The find worth remembering: `.tally` and `.banner` set a colour as
  TEXT on a 10% tint of ITSELF, which leaves almost no room — both failed, red
  included. `--up-ink` / `--down-ink` exist for that case, the same move
  `--team-ink` already makes.
- **Type.** Fifteen font sizes became seven, on a 1.25 ratio.
- **Spacing.** Twenty ad-hoc values became a 4px grid.

Both systems are documented in `web/src/styles.css` at the top of their
sections. A scale is worth nothing once it is only partly true, so an off-scale
value added later costs more than it looks like it does.

Verified at 375x667 — the constrained Now Playing case the `.np` comments were
written about — at 29px clearance under the vote thumbs with no scrolling,
measured against the old stylesheet's 30px. A 1px cost.

**Finding 4 was explicitly dropped by Mack**: missing artwork renders as a flat
block of team colour. Do not resurrect it uninvited.

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
2. **The UI is up for a redesign.** 2026-09-02: a background picture was
   tried and removed — the reaction was that the app "feels cheap", which a
   backdrop does not fix. Nothing has been decided about what replaces it. The
   background work is in the history if it is ever wanted back (`683e136` and
   its three parents), but it is fully out of the tree, not switched off.
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
- **A 200 from the site does NOT mean the file exists.** `not_found_handling =
  "none"` plus the catch-all in `src/index.ts` answers any unknown path with
  index.html and a 200. Check the content-type, not the status. This wasted a
  round on 2026-09-07 checking whether a deleted image was still deployed.
- **`backend/public` IS the wrangler upload payload**, and Finder writes
  `.DS_Store` into any directory it displays. Two were live on the public site
  until 2026-09-07. Guarded now by `web/public/.assetsignore` (it must live in
  `web/` — vite's `emptyOutDir` wipes `backend/public` every build) and a
  `predeploy` script. Do not delete either guard.

## USB-C speaker, if it comes up

The JBL Charge 6 over USB works **conditionally**: it needs one specific cable
and a near-full battery. A miswired CC resistor in the other cable advertises
3A and trips the Pi's over-current protection; a battery below ~full draws full
charging current and does the same. The charging current is invisible to USB
(`bMaxPower` reads 100mA), so it is not diagnosable in software. Details in
`STATE.md`. The relay avoids all of this.
