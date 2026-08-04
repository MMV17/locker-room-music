# Project state — resume here

Last worked: **2026-08-03**. Spec is `docs/spec.md`.

Build order status (spec section 10):

| # | Phase | Status |
|---|---|---|
| 1 | Pi is a working Bluetooth speaker | **Done, verified on hardware** |
| 2 | Listener logs to local SQLite | **Done, verified on hardware** |
| 3 | Worker + D1 + schema, deployed | **Done — deployed and verified in production** |
| 4 | Pi syncs to the Worker | **Done — 1,261 rows drained to production, 0 lost** |
| 5 | Voting site: join + now-playing | **Done — built and verified locally, not yet deployed** |
| 6 | Results reveal, leaderboards, rating math | **Done — all screens built** |
| 7 | Admin and device claiming | **Done — all screens built** |

---

## Production deployment (as of 2026-08-03)

| Thing | Value |
|---|---|
| Worker | `locker-room-music` |
| Primary URL | `https://lockerroom.finestkindfarms.com` |
| Fallback URL | `https://locker-room-music.mmvinton17.workers.dev` |
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

## Pick up here

**Deploy the site, then run it on real phones.** All seven screens are built
and pass locally against `wrangler dev`, but nothing from phase 5 has been
deployed or seen on hardware. Next steps, in order:

1. `cd web && npm install && npm run build` (writes to `backend/public/`),
   then `cd backend && npx wrangler deploy`.
2. Apply the schema change to production: the `settings` table is new.
   `npx wrangler d1 execute lockerroom --remote --file=./schema.sql` — it is
   `CREATE TABLE IF NOT EXISTS`, so it is safe against the live database.
3. Set the real team colour and name from `/admin` using `ADMIN_PASSWORD`.
4. Add the actual roster, then get it on five phones and run a session
   (spec build order step 5).

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

## Known issues, not yet addressed

**Heartbeats dominate the outbox.** ~1,100 of those 1,261 rows were heartbeats,
each durably stored, retried with backoff, and eventually replayed. But a
heartbeat only asserts "alive at time T" — replaying a four-hour-old one tells
the server nothing usable, and after an outage the Pi spends its first minutes
back online flushing stale pings before the plays anyone cares about get
through. Spec §5.3's "never drop an entry" is right for plays and votes;
heartbeats are liveness, not events. Either keep them out of the durable outbox
or collapse to the newest before sync.

**Two plays have `played_ms=NULL`** — 16 `POST /api/plays` against 14 `PATCH`es.
Plays that opened and never closed, most likely cut off when the Pi lost its
network mid-session. Harmless; the vote window falls back to
`started_at + duration_ms + 30s` per spec §6.3. Worth knowing that fallback has
now been exercised for real.

**Bluetooth range.** `hci0` is `Bus: UART` — the built-in radio, which shares
its antenna with wifi. The USB dongle from the spec's parts list is not plugged
in. **Deliberately deferred by Mack** until range actually causes a problem; do
not re-raise unprompted.

**How the Pi gets internet in the locker room is unsolved.** Every campus SSID
is WPA2 Enterprise, which a headless Pi handles badly and which likely needs
device registration. Options, best first: a wired ethernet drop; registering the
Pi on the school's IoT/device PSK network; a cellular hotspot. This has lead
time — start the IT conversation early.

**Remote admin access.** Campus wifi has client isolation (verified: an ARP
sweep of all 512 addresses in `10.6.14.0/23` drew replies from exactly two
hosts) and blocks Tailscale's control plane. Cloudflare Tunnel is the intended
answer and the zone is now on Cloudflare, so it is unblocked whenever you want
it. `workers.dev` is **not** blocked — an earlier claim that it was turned out
to be missing certificates on an undeployed hostname, not filtering.

---

## Environment

- **Pi:** Pi 4B, Debian 13 (trixie), Python 3.13, MAC `e4:5f:01:c2:6e:a9`,
  passwordless via `~/.ssh/id_ed25519`. **Its address is not stable** — it has
  been moved off the home network, so `192.168.1.6` is dead. See "Reaching the
  Pi" below.
- **Node:** now nvm `v24.14.0`, on PATH by default. The old `~/.local/node`
  (v22.14.0) has been deleted — ignore any `export PATH="$HOME/.local/node/..."`
  in older notes. That install was x86_64 under Rosetta, so `backend/node_modules`
  had to be rebuilt for arm64 (`rm -rf node_modules && npm install`). If tests
  ever die with a rollup `MODULE_NOT_FOUND`, that is this, recurring.
- **Local venv** for the Pi tests: `.venv/` in the repo root.

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

# Backend unit tests (15)
cd backend && npx vitest run

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

### Decisions made during the build

- **Thumbs up/down only.** A four-level scale (double thumbs) was designed and
  then cancelled before implementation. `votes.value` keeps its
  `CHECK (value IN (-1,1))` and `scoring.ts` was never touched.
- **A DJ cannot vote on their own song** — enforced in `POST /api/votes`, with
  their private qualification standing shown where the controls would be.
- **Join stays open** (team code + pick your name, no per-player PIN).
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
