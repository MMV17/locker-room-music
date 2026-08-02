# Project state — resume here

Last worked: **2026-08-02**. Spec is `docs/spec.md`.

Build order status (spec section 10):

| # | Phase | Status |
|---|---|---|
| 1 | Pi is a working Bluetooth speaker | **Done, verified on hardware** |
| 2 | Listener logs to local SQLite | **Done, verified on hardware** |
| 3 | Worker + D1 + schema, deployed | **Built and tested locally — NOT deployed** |
| 4 | Pi syncs to the Worker | Blocked on phase 3 deploy |
| 5 | Voting site: join + now-playing | Not started (see "Frontend" below) |
| 6 | Results reveal, leaderboards, rating math | Backend math done; UI not started |
| 7 | Admin and device claiming | Backend done; UI not started |

---

## Pick up here

Two things block progress, both needing a human:

1. **Cloudflare auth.** Everything in `backend/` runs against a local D1 via
   Miniflare and passes, but nothing is deployed. To deploy:
   ```
   export PATH="$HOME/.local/node/bin:$PATH"
   cd backend
   npx wrangler login                      # interactive, browser
   npx wrangler d1 create lockerroom       # put the id in wrangler.toml
   npx wrangler d1 execute lockerroom --remote --file=./schema.sql
   npx wrangler secret put DEVICE_KEY      # and MAC_SALT, TEAM_CODE, ADMIN_PASSWORD
   npx wrangler deploy
   ```
   Then phase 4 is just pointing `/etc/lockerroom/config.toml` on the Pi at the
   deployed URL and putting the real `DEVICE_KEY` in it. The outbox has been
   accumulating against a placeholder URL and will drain on first contact —
   that is by design and doubles as the offline-durability test.

2. **Bluetooth range.** The Pi is on wifi (`wlan0`), and the Pi 4's built-in
   Bluetooth shares its antenna with wifi. The USB Bluetooth dongle with
   external antenna from the spec's parts list is **not plugged in**. Range is
   currently poor enough that the link drops at moderate distance. Options,
   best first: plug in the dongle; or connect ethernet and disable wifi (do not
   disable wifi without ethernet attached — it is the only way in).

---

## Environment

- **Pi:** `ssh pi@192.168.1.6`, passwordless via `~/.ssh/id_ed25519`.
  Pi 4B, Debian 13 (trixie), Python 3.13.
- **Node:** installed locally at `~/.local/node` (v22.14.0), no sudo, not on
  PATH by default. Prefix commands with
  `export PATH="$HOME/.local/node/bin:$PATH"`. Delete the directory to undo.
- **Local venv** for the Pi tests: `.venv/` in the repo root.

## Commands

```bash
# Pi listener tests (14)
.venv/bin/python -m pytest pi/tests/ -q --asyncio-mode=auto

# Deploy listener to the Pi and restart it
./pi/scripts/deploy.sh

# Watch the Pi live
ssh pi@192.168.1.6 "sudo tail -f /var/log/lockerroom/listener.log"

# Backend unit tests (15)
cd backend && npx vitest run

# Backend end-to-end (22) — needs `npx wrangler dev --local` running first
cd backend && ./test/e2e.sh
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

## Frontend — read before designing anything

**The user does not like the spec's section 9.2 visual direction** (scoreboard
slot, condensed athletic block type, jersey typography). This was stated up
front, before any UI work.

Direction has **not** been established. Do not default to the spec's
prescription, and do not default to generic generated-app styling. Ask what
they want — references, an existing look, or reactions to concrete options —
and note they declined to answer a multiple-choice framing of this question, so
prefer showing over asking.

Available tooling is thin here: no general frontend-design skill exists. The
`DesignSync` tool can read/write design-system projects in the user's
claude.ai/design account (unexplored — they never confirmed whether one
exists). `artifact-design` is scoped to single-page Artifacts.
`claude-in-chrome` can screenshot a phone-sized viewport so they can react to
something real.

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
