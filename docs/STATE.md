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
| Primary URL | `https://hc.auxgoat.com` (`hc` = the school; see wrangler.toml) |
| Old URL, kept | `https://lockerroom.finestkindfarms.com` — the Pi's fallback, do not remove |
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
4. Get it on five phones and run a real session (spec build order step 5).
   No roster step any more - players add themselves at the join screen.

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
new device on every reconnect. **wlan0 is `e4:5f:01:c2:6e:ab`** — a different
MAC from eth0 (`...a9`), which is the one to hand over if the school ever adds
device registration.

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

# Back up production D1 (spec 13). Writes outside the repo, verifies the dump
# is usable, keeps 30. Restore instructions are in the script's footer - read
# them before you need them. Time Travel (30 days) is the first thing to reach
# for; this dump is for damage older than that.
./backend/scripts/backup.sh

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
