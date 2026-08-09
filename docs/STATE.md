# Project state — resume here

Last worked: **2026-08-08**. Spec is `docs/spec.md`. Repo lives at
`~/Desktop/Home_Projects/locker-room-music.nosync` — the `.nosync` is
deliberate, see "Why `.nosync`" below.

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

- **`/go` is throttled in the Worker, not by the WAF.** Cloudflare's rate
  limiting rules are a paid add-on on this plan, so `apex/wrangler.toml` binds
  the Workers rate-limit API instead: 10 per 60s, keyed on `CF-Connecting-IP`.
  This is *better* than the WAF rule would have been — it also covers the
  `workers.dev` hostname, which a zone-level rule cannot, and that is the
  hostname actually in use on campus.

  **Only WRONG codes are counted.** A whole school shares one public IP on
  campus wifi, so throttling every `/go` would let players arriving at the
  start of practice lock each other out. Legitimate players type a code that
  works; a brute-forcer generates misses by definition.

  Still a stopgap: 10/min from one IP is 14,400 a day, and a mascot wordlist
  is not much longer. The real fix is the QR path, which removes the apex's
  need to validate anything.
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

## Pick up here

**FIRST: `auxgoat.com` currently resolves to nothing.** The team Worker was
deployed with its apex routes removed, which deleted those DNS records, and the
apex Worker has never been deployed. Two commands close it:

```bash
cd apex && npx wrangler deploy                    # claims auxgoat.com + www
cd web && npm run build && cd ../backend && npx wrangler deploy
```

The second is needed because `Join.tsx` changed (the fragment handoff) and
production is still running the build from before it. `hc.auxgoat.com` and the
Pi are unaffected by either — neither is reachable on campus regardless, see
the filter section.

**Then: run it with actual teammates.** What is left needs more than one phone
in a room.

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
- **A routing artifact got in as a real play.** Seen 2026-08-05 20:12 from a
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
