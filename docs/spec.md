# Locker Room Music Rating System — Build Spec

A build specification for Claude Code. Read this whole document before writing any code.

---

## 1. What this is

A football locker room has one speaker and ~100 people with different music taste. Only one person can connect at a time. This system automatically logs **who is DJing** and **what song is playing**, and lets teammates vote each song up or down from their phones. Over a season it produces two rankings: which songs the team actually likes, and which teammates have taste the team trusts.

**The core insight of the architecture:** we do not try to read data out of a Bluetooth speaker. Consumer speakers are black boxes with no API. Instead, a Raspberry Pi *impersonates* the speaker — phones connect to the Pi, and the Pi passes audio through to the real speaker over a 3.5mm cable. Because the Pi is the Bluetooth endpoint, it gets both the connecting device's MAC address (identity) and AVRCP track metadata (song info) for free.

**No microphone. No audio recording, ever.** Song titles come from a metadata protocol, not from listening to the room. This is a hard requirement, not a preference — this device lives in a locker room. Do not add audio capture, audio fingerprinting, or any recording capability at any point.

---

## 2. Hardware

| Item | Notes |
|---|---|
| Raspberry Pi 4 (2GB) | **Must be the Pi 4, not the Pi 5.** The Pi 5 removed the 3.5mm analog audio jack. |
| USB Bluetooth 5.0 dongle, external antenna | The Pi's built-in radio shares an antenna with wifi and gets unreliable in a crowded room |
| 32GB microSD (A2-rated) | |
| Official Pi 4 USB-C power supply | Undervoltage causes Bluetooth dropouts, do not use a phone charger |
| Case with ventilation | |
| 3.5mm-to-3.5mm cable | Pi audio out → speaker aux in |

Deployment note for the operator: the aux cable must stay plugged into the speaker. On most Bluetooth speakers, an occupied aux jack disables their own Bluetooth radio — that is the enforcement mechanism that stops people connecting to the speaker directly and bypassing the system.

---

## 3. Architecture

```
Phone (DJ)  --Bluetooth A2DP+AVRCP-->  Raspberry Pi  --3.5mm-->  Speaker
                                            |
                                    local SQLite (outbox)
                                            |
                                    HTTPS, queued + retried
                                            v
                              Cloudflare Worker + D1 database
                                            ^
                                            | HTTPS
                              Cloudflare Pages (voting site)
                                            ^
                                   Teammates' phones
                            (on any network — wifi or cellular)
```

Teammates never join a special network and never connect to the Pi. They open a URL on whatever connection they already have. This was an explicit requirement: joining the system must not cost anyone their internet access.

**Stack**
- Pi: Raspberry Pi OS Lite (64-bit, Bookworm or later), Python 3.11+, BlueZ, bluez-alsa
- Backend: Cloudflare Workers + Hono + D1
- Frontend: Cloudflare Pages (React or plain TS — your call, keep the bundle small)
- Artwork: iTunes Search API (free, no key, no auth)

Target cost: **$0/month.** See section 8 for the request-budget constraint that keeps it there.

---

## 4. Phase 1 — Pi as a Bluetooth speaker

Goal for this phase: a phone can connect to a device named "AuxGoat" and hear music come out of the aux-connected speaker. No app code yet. Verify this works before writing anything else.

### 4.1 Audio backend

Use **bluez-alsa** (`bluez-alsa-utils`), not PipeWire. Pi OS Lite is headless with no user session, and PipeWire's session management is awkward there. bluez-alsa runs cleanly as a systemd system service.

- Install `bluez`, `bluez-alsa-utils`, `bluez-tools`, `alsa-utils`
- Enable analog audio in `/boot/firmware/config.txt` (`dtparam=audio=on`), and **pin the ALSA default to the headphone jack by card ID** in `/etc/asound.conf` — never by card index, which is assigned in kernel enumeration order and moves. Both are asserted by `pi/scripts/provision.sh` as of 2026-08-21; before that they were requirements nothing checked, and a fresh provision came up silent with every service green. See `docs/STATE.md`.
- Run `bluealsa` with the A2DP sink profile enabled
- Run `bluealsa-aplay 00:00:00:00:00:00` as a service — the all-zeros MAC means "play audio from any connected device," which is exactly what we want
- Both as systemd units with `Restart=always`

### 4.2 Discoverability and pairing

In `/etc/bluetooth/main.conf`:
- `Name = AuxGoat` — **this does nothing on BlueZ 5.x and is kept only so the
  file does not contradict reality.** Verified on the real Pi 2026-08-09:
  changing it and restarting bluetoothd left the advertised name untouched,
  with no `Alias` stored in `/var/lib/bluetooth/<adapter>/settings` to explain
  it. BlueZ takes the adapter name from systemd's **pretty hostname**:

      sudo hostnamectl set-hostname --pretty "AuxGoat"
      sudo systemctl restart bluetooth      # required; it is not picked up live

  That is the setting that actually renames the speaker, and it survives
  reboots in `/etc/machine-info`. It must match `speaker_name` in
  `/etc/lockerroom/config.toml`, which is a third separate setting — that one
  is only the key the server files heartbeats under.
- `Class = 0x200414` — this makes phones display it as a speaker rather than a generic device
- `DiscoverableTimeout = 0` and `PairableTimeout = 0` — permanently visible, never times out

Register a Bluetooth agent with `NoInputNoOutput` capability that auto-accepts pairing requests. `bt-agent` from `bluez-tools` handles this; a custom `org.bluez.Agent1` implementation is fine too. Nobody should have to press a button or type a PIN.

Also set the adapter to re-enter discoverable mode on boot and after any disconnect — BlueZ sometimes drops discoverability after a connection, which would make the speaker invisible to the next DJ.

### 4.3 Verification before proceeding

- Two different phones (one iOS, one Android) can find, pair, and play
- Audio comes out the speaker at usable volume
- After a phone disconnects, the next phone can find and connect without intervention
- Survives a reboot with no manual steps

---

## 5. Phase 2 — The Pi listener service

A Python systemd service watching the BlueZ D-Bus system bus. Use `dbus-fast` (async) or `pydbus`.

### 5.1 What to watch

| Interface | Gives us |
|---|---|
| `org.bluez.Device1` | `Connected`, `Address` (MAC), `Alias` (device name, e.g. "Jake's iPhone") |
| `org.bluez.MediaPlayer1` | `Track` dict — `Title`, `Artist`, `Album`, `Duration`; plus `Status` (playing/paused/stopped) |
| `org.bluez.MediaTransport1` | `State` — useful as a secondary signal for playback stopping |

Subscribe to `PropertiesChanged` signals rather than polling.

Note on AVRCP: the phone pushes this metadata from its OS-level Now Playing state, which is why it works identically across Spotify, Apple Music, SoundCloud, and YouTube. Some apps populate it inconsistently. Handle missing or empty fields gracefully — log the play with whatever fields exist and mark it incomplete rather than dropping it.

### 5.2 Session and play lifecycle

**On device connect:** open a session record with the MAC and device alias. Look up the MAC in the local device table. If unknown, still open the session — the play will attach to an unclaimed device, and the leaderboard will surface it for claiming later.

**On track change:** close the previous play (set `ended_at`), open a new one with a client-generated UUID.

**Close the current play when any of these happen:**
- Track metadata changes to a different title/artist
- `Status` goes to `stopped` (treat `paused` as a pause, not an end — resume within 60s continues the same play)
- Device disconnects
- Reported `Duration` elapses with no further events

**Debounce:** ignore a track-change event if the normalized title+artist matches the currently open play and less than 10 seconds have passed. Some phones re-emit metadata on volume changes or app foregrounding, and without this you will get duplicate plays.

**Skip rule:** if a play ends with less than 30 seconds elapsed, still record it but set `counted = false`. Skipped tracks are noise, not opinions. Keep them — "most skipped" is an interesting stat later.

### 5.3 Local storage and sync

The Pi writes every event to a local SQLite database **first**, then syncs. This is what makes a flaky locker room wifi connection survivable.

- Table `outbox(id, endpoint, payload_json, created_at, attempts, synced_at)`
- Background task drains the outbox every 15 seconds
- Exponential backoff on failure, cap at ~5 minutes, never drop an entry
- All IDs are client-generated UUIDs and all server writes are idempotent upserts, so a retry after an ambiguous timeout is safe
- Never delete synced rows — the local DB is the backup of record

### 5.4 Configuration

A single `/etc/lockerroom/config.toml`: API base URL, device key (shared secret), sync interval, speaker name. Secrets never in the repo.

---

## 6. Phase 3 — Backend (Cloudflare Workers + D1)

### 6.1 Schema

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  jersey_number TEXT,
  position      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE devices (
  mac_hash      TEXT PRIMARY KEY,   -- SHA-256(mac + server salt)
  mac_hint      TEXT NOT NULL,      -- last two octets, for human identification only
  alias         TEXT,               -- e.g. "Jake's iPhone"
  user_id       TEXT REFERENCES users(id),
  first_seen    TEXT NOT NULL,
  claimed_at    TEXT
);

CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,
  track_key     TEXT NOT NULL UNIQUE,  -- lowercased, punctuation-stripped "artist|title"
  title         TEXT NOT NULL,
  artist        TEXT,
  album         TEXT,
  artwork_url   TEXT,
  artwork_state TEXT NOT NULL DEFAULT 'pending'  -- pending | found | none
);

CREATE TABLE plays (
  id            TEXT PRIMARY KEY,   -- UUID from the Pi
  track_id      TEXT NOT NULL REFERENCES tracks(id),
  device_hash   TEXT REFERENCES devices(mac_hash),
  user_id       TEXT REFERENCES users(id),  -- denormalized at play time
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  duration_ms   INTEGER,
  played_ms     INTEGER,
  counted       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE votes (
  id            TEXT PRIMARY KEY,
  play_id       TEXT NOT NULL REFERENCES plays(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  value         INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (play_id, user_id)
);

CREATE TABLE device_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);
```

Index `plays(started_at)`, `plays(user_id)`, `votes(play_id)`, `tracks(track_key)`.

The `UNIQUE (play_id, user_id)` constraint is what enforces one vote per person per song at the database level. Do not rely on application logic alone for this.

MAC addresses are hashed with a server-side salt so the cloud database never holds raw device identifiers. The `mac_hint` (last two octets) is enough for someone to recognize their own device in the claim list.

### 6.2 Endpoints

**Pi → server** (authenticated with `X-Device-Key` header against a Worker secret):
- `POST /api/plays` — upsert a play; creates the track and device rows if new
- `PATCH /api/plays/:id` — set `ended_at`, `played_ms`, `counted`
- `POST /api/heartbeat` — liveness, so the site can show "speaker offline"

**Public / session-authenticated:**
- `POST /api/session` — body: team code + user id → returns a device token (httpOnly cookie, long-lived)
- `GET /api/now` — current play, artwork, DJ name, whether the vote window is open, and **the caller's own vote only**
- `POST /api/votes` — body: play_id, value. Upsert. Rejected if the window is closed.
- `GET /api/plays/:id/results` — tallies. **Returns 403 if the vote window is still open.**
- `GET /api/leaderboard/tracks` — with `?window=season|month|week`
- `GET /api/leaderboard/djs`
- `GET /api/devices/unclaimed` and `POST /api/devices/:hash/claim`
- `GET /api/history` — recent plays with scores

**Admin** (separate secret, simple password gate is fine):
- Roster CRUD, un-claim a device, void a play, void a vote.

### 6.3 The vote window

Server-enforced, no exceptions:
- Opens when the play is created
- Closes at `ended_at + 30 seconds` (grace for sync lag and slow thumbs)
- If `ended_at` is null, closes at `started_at + duration_ms + 30s` as a fallback
- Votes may be changed freely while open, locked permanently after

**Tallies must not be readable while the window is open.** Not hidden in CSS — not present in the API response. If someone opens devtools and sees the song sitting at −6, they pile on, and the data becomes a measure of social momentum rather than taste. `GET /api/now` returns only the caller's own vote. This is the single most important rule in the spec.

### 6.4 Artwork

On track creation, queue a lookup against the iTunes Search API (`https://itunes.apple.com/search?term=<artist title>&entity=song&limit=1`). Free, no key required. Take `artworkUrl100` and swap the dimensions in the URL for a larger size. Cache on the track row, set `artwork_state`, never look up the same track twice. If nothing is found, fall back to a generated color block derived from a hash of the track key — no broken images, no placeholder icons.

---

## 7. Rating math

Raw vote counts are misleading and must not be used for any ranking. A song played once to three people will otherwise beat a song played twenty times to the whole room.

### 7.1 Track score

```
track_score = (upvotes - downvotes) / (upvotes + downvotes + k)     where k = 5
```

Range is roughly −1 to +1, pulled toward 0 when the sample is small. A song with 2 up and 0 down scores 0.29; a song with 30 up and 2 down scores 0.76. That is the correct ordering.

Aggregate across all plays of the same track — a song played five times accumulates all five plays' votes.

Only include plays where `counted = 1`.

### 7.2 DJ score

Bayesian shrinkage toward the team average:

```
dj_score = (sum(track_scores of their counted plays) + m * global_mean_score) / (n + m)
           where n = their number of counted plays, m = 3
```

This means a DJ needs a real body of work before they can top the board. Someone who played one universally loved song does not outrank someone with a 40-song track record.

**Hide any DJ with fewer than 5 counted plays** from the public leaderboard entirely. Show them their own score privately with a "3 more songs to qualify" message.

### 7.3 Additional stats worth surfacing

- Total plays, unique voters per play, most-played track, most-skipped track
- Turnout: votes cast ÷ number of distinct users who voted at all that day (a rough proxy for who was in the room)
- Per-user: "your taste agreement" — how often their vote matched the majority

### 7.4 Deliberately out of scope for v1

Troll detection (users whose votes anticorrelate with everyone else) and any per-user vote weighting. Build the honest version first, look at real data, then decide. Note in the code where these would slot in.

---

## 8. The request budget

Cloudflare's free tier is 100,000 Worker requests/day and 100,000 D1 rows written/day. Votes are trivial against this. **Polling is what would blow it.**

Rules:
- The now-playing view polls at **7.5 seconds**, never faster (was 10s; lowered
  2026-08-05 after a real session felt laggy — sized against 75 players × 2
  hours/day = 150 player-hours, which lands at ~76,000 requests/day, 76% of the
  tier. Redo this arithmetic before changing it:
  `polls/day = players × hours × 3600 / interval_seconds`)
- Polling stops entirely when the tab is backgrounded (`visibilitychange`) and when no play is active
- Leaderboards are fetched on load and on manual pull-to-refresh only, never polled
- Cache leaderboard responses at the edge for 60 seconds

Done right this lands in the low thousands of requests a day. Done wrong it exceeds the daily limit before lunch and the whole thing 500s.

---

## 9. Frontend

### 9.1 The physical situation this UI lives in

Design for it literally: someone half-dressed, holding a phone in one hand, in a loud room, for about four seconds between other things. That is the entire brief.

- Thumb targets sized for a hand that is wet or taped. Minimum 64px, ideally much larger — the two vote controls should own most of the screen.
- No small text anywhere. No precision gestures, no long-press, no swipe-to-vote.
- One screen does one thing. Now-playing is the home screen; leaderboards are a deliberate second destination.
- Instant optimistic feedback on tap — the vote registers visually before the network confirms, and reconciles quietly.

### 9.2 Visual direction

Ground it in the subject's own materials: the laminated depth chart, the sharpie on athletic tape, the scoreboard slot, the jersey number. Not generic "sports app."

- **Type:** a condensed athletic block face for display (numbers and names read as jersey typography), a plain grotesque for body, a monospace for stats and tallies. The type should carry the identity — the layout underneath can be quiet.
- **Color:** one configurable team-color token that the operator sets once, and a restrained neutral system around it. Do not build a palette that only works in one team's colors.
- **Signature element:** the now-playing card as a scoreboard slot — DJ's name and number in the DJ position, track and artist in the display slot, artwork as the only image on screen.
- **Avoid:** cream backgrounds with serif display faces and clay accents; near-black with a single acid accent. Both read as templated AI output regardless of subject.
- Results reveal is a real moment — the tally is hidden for the whole song and then lands. Give that one transition proper attention, and keep animation elsewhere near zero.

### 9.3 Copy

Interface voice, not a person's. "Speaker offline" not "Oops! We couldn't connect." Empty leaderboard says what will fill it: "No songs rated yet. Ratings appear after the first song plays." Actions keep their name through the flow.

### 9.4 Screens

1. **Now playing** — artwork, track, artist, DJ, two vote controls, vote-locked state after the window closes
2. **Results reveal** — the tally for the song that just ended
3. **Song leaderboard** — top and bottom, with a season/month/week filter
4. **DJ leaderboard** — qualified DJs only
5. **History** — recent plays with final scores
6. **Join** — team code, then pick your name from the roster
7. **Claim device** — shown to a signed-in user when an unclaimed device is active
8. **Admin** — roster, claims, voiding

---

## 10. Build order

Do not skip ahead. Each phase is verifiable on its own.

1. **Pi is a working Bluetooth speaker.** Two phones, audio out, survives reboot. No code.
2. **Listener logs to local SQLite.** Print every connect, track change, and disconnect to a log file. Play a dozen songs from Spotify, Apple Music, and YouTube on both an iPhone and an Android and confirm the metadata is accurate and the play boundaries are right. **This is the phase most likely to surface surprises — spend real time here.**
3. **Worker + D1 + schema, deployed.** Test endpoints with curl.
4. **Pi syncs to the Worker.** Pull the wifi mid-song and confirm nothing is lost.
5. **Voting site: join flow and now-playing only.** Get it on five phones and run a real session.
6. **Results reveal, leaderboards, rating math.**
7. **Admin and device claiming.**

---

## 11. Test checklist

- Two phones connect back to back without intervention
- Phone disconnects mid-song → play closes cleanly
- Same song played twice in one session → two plays, one track, votes aggregate
- Song skipped at 10 seconds → recorded, `counted = 0`, excluded from scores
- Track with missing artist metadata → still logs, does not crash
- Wifi pulled for 10 minutes → outbox drains and reconciles on reconnect
- Vote submitted after the window closes → rejected with a clear message
- Same user votes from two devices → second is rejected by the unique constraint
- Tallies genuinely absent from the API response while the window is open (check the raw response, not the UI)
- DJ with 4 plays does not appear on the leaderboard; at 5 they do
- Pi reboots mid-session and recovers unattended
- Site is usable one-handed on a small phone

---

## 12. Non-negotiables

1. **No microphone, no audio capture, no fingerprinting.** Metadata only.
2. **No live vote tallies during a song.**
3. **Raw MAC addresses never leave the Pi** — salted hash plus a two-octet hint only.
4. **The Pi writes locally before it syncs.** Connectivity is never a precondition for recording a play.
5. **Every ranking is damped.** No raw counts on any leaderboard.

---

## 13. Operator notes (not for the code)

- Tell the team this exists before switching it on. It logs who played what and stores device identifiers. Getting buy-in up front is easy; getting forgiveness after someone discovers it is not.
- Expect the first two weeks of data to be mostly noise. People will downvote their friends for sport. The damping absorbs some of it, and novelty wears off.
- Back up the D1 database on a schedule. A season of data is not reproducible.
