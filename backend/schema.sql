-- Locker Room Music schema (spec section 6.1).

-- Players sign themselves up (team code + first name, last name, number).
-- There is no admin-curated roster: the team code is the only gate, which is
-- an accepted trade — see the comment on POST /api/session.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  jersey_number TEXT,
  -- normalize(first)|normalize(last)|normalize(jersey), matching trackKey.ts.
  -- This is what makes a re-signup (cleared cookies, new phone, reinstalled
  -- browser) find the existing player instead of silently creating a second
  -- one and splitting their play history in half.
  --
  -- Jersey numbers may repeat across players by decision — a QB and a DB can
  -- both wear 12 — so the number alone is deliberately NOT unique. The name
  -- is what carries the identity here.
  identity_key  TEXT NOT NULL UNIQUE,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  mac_hash      TEXT PRIMARY KEY,   -- SHA-256(mac + server salt)
  mac_hint      TEXT NOT NULL,      -- last two octets, for human identification only
  alias         TEXT,               -- e.g. "Jake's iPhone"
  user_id       TEXT REFERENCES users(id),
  first_seen    TEXT NOT NULL,
  claimed_at    TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
  id            TEXT PRIMARY KEY,
  track_key     TEXT NOT NULL UNIQUE,  -- lowercased, punctuation-stripped "artist|title"
  title         TEXT NOT NULL,
  artist        TEXT,
  album         TEXT,
  artwork_url   TEXT,
  artwork_state TEXT NOT NULL DEFAULT 'pending'  -- pending | found | none
);

CREATE TABLE IF NOT EXISTS plays (
  id            TEXT PRIMARY KEY,   -- UUID from the Pi
  track_id      TEXT NOT NULL REFERENCES tracks(id),
  device_hash   TEXT REFERENCES devices(mac_hash),
  user_id       TEXT REFERENCES users(id),  -- denormalized at play time
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  duration_ms   INTEGER,
  played_ms     INTEGER,
  counted       INTEGER NOT NULL DEFAULT 1,
  voided        INTEGER NOT NULL DEFAULT 0,
  -- Set by the Pi's beacon while this play is still on the speaker. Without
  -- it the vote window closes on wall-clock time (started_at + duration_ms
  -- + 30s), which keeps ticking while playback is PAUSED - so pausing a song
  -- mid-track ended voting on a song still sitting on the speaker.
  keepalive_at  TEXT,
  -- 'playing' | 'paused', last reported by the Pi. Lets the site freeze the
  -- progress bar instead of counting through a pause.
  play_status   TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  id            TEXT PRIMARY KEY,
  play_id       TEXT NOT NULL REFERENCES plays(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  value         INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  voided        INTEGER NOT NULL DEFAULT 0,
  -- Enforces one vote per person per song at the database level. Application
  -- logic must never be the only thing standing between a user and a second vote.
  UNIQUE (play_id, user_id)
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- Liveness, so the site can show "speaker offline".
CREATE TABLE IF NOT EXISTS heartbeats (
  speaker_name  TEXT PRIMARY KEY,
  last_seen_at  TEXT NOT NULL,
  -- Who has the aux, and who is connected but cannot be heard. Written by the
  -- same beacon that writes last_seen_at, so it is exactly as fresh.
  --
  -- Here rather than in a table of its own: volatile state, one writer, no
  -- history worth keeping, and reading it must never cost a join.
  --
  -- SHA-256(mac + MAC_SALT), never a raw MAC. Same hash as devices.mac_hash,
  -- so it joins straight to a claimed device and therefore to a person.
  aux_holder_hash   TEXT,
  aux_holder_alias  TEXT,   -- Bluetooth name, for a phone nobody has claimed
  aux_waiting       TEXT,   -- JSON [{hash, alias}], oldest first
  -- Milliseconds until anybody may take the aux, measured on the Pi at its
  -- last beacon. NULL = a song is open, so no deadline exists and the site
  -- shows no countdown; > 0 = the grace is running out; 0 = it has lapsed and
  -- whoever presses play next gets the speaker. The Worker subtracts beacon
  -- age before serving it (src/auxCountdown.ts).
  aux_free_in_ms    INTEGER,
  -- What the box is actually PLAYING THROUGH, as chosen by audio-route.sh.
  -- Reported rather than inferred from the selection, because the two disagree
  -- exactly when something is wrong - which is when the admin screen matters.
  -- All nullable: a Pi on older code reports none of it and the screen says
  -- unknown rather than a confident wrong answer.
  output_kind       TEXT,     -- usb | jack | relay
  output_card       TEXT,     -- the ALSA card, or the speaker MAC when relaying
  relay_connected   INTEGER,  -- 1/0, NULL when the Pi did not say
  relay_error       TEXT      -- why the chosen speaker is not playing, in words
);

-- Remote control for the Pi (see POST /api/pi/beacon).
--
-- The locker room network allows outbound 443 and nothing else useful: port
-- 7844 is blocked, so Cloudflare Tunnel cannot run, and Tailscale is blocked
-- by SNI. There is no way to reach INTO the Pi. So the Pi reaches out on the
-- one route that works and asks whether there is anything to do.
--
-- `command` is validated against a fixed allowlist on the way in AND again on
-- the Pi. There is deliberately no "run this string" command: that would be
-- remote code execution on a device sitting in a locker room.
CREATE TABLE IF NOT EXISTS pi_commands (
  id            TEXT PRIMARY KEY,
  command       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at  TEXT,
  ok            INTEGER,
  result        TEXT
);

CREATE INDEX IF NOT EXISTS idx_pi_commands_pending
  ON pi_commands (created_at) WHERE dispatched_at IS NULL;

-- The most recent Bluetooth scan, and only that one. Replaced wholesale every
-- scan: a device list is a snapshot, not a log, and a speaker that has left the
-- building must stop being offered.
--
-- This is how the speaker picker avoids putting an argument on pi_commands.
-- Scanning is an action that takes no parameters, so it is just another
-- allowlisted name; the chosen MAC travels back down as a `settings` row on the
-- beacon response and is validated again on the Pi. See
-- docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md.
CREATE TABLE IF NOT EXISTS bt_devices (
  mac        TEXT PRIMARY KEY,
  -- NULL means the device advertises no name; the UI shows the MAC. Kept NULL
  -- rather than defaulted so "nameless" stays distinguishable from a real name.
  name       TEXT,
  -- Class of Device. Its major class says whether this is audio gear, which
  -- SORTS speakers to the top - never filters, because the field is
  -- self-reported and a filter can hide the speaker in somebody's hand.
  cod        INTEGER,
  rssi       INTEGER,   -- NULL is normal: only populated for a recent sighting
  scanned_at TEXT NOT NULL
);

-- Long-form output from the box: the diagnostic dump and the repair log.
--
-- Exists for the same reason bt_devices does. `pi_commands.result` is truncated
-- to 2000 characters by the beacon handler, and a full diagnostic dump is many
-- times that - so the body rides its own beacon payload into here instead. A
-- TRUNCATED dump is worse than none: the line you went looking for vanishes
-- with nothing on screen admitting it was dropped, which is how 2026-09-20 cost
-- an hour on a box nobody could reach any other way.
--
-- Keyed by kind, so a repair log does not overwrite the diagnostic that
-- justified running it - reading the two side by side is the whole workflow.
-- Within a kind it is a snapshot, not a log. See migration 007 and
-- src/piReports.ts.
CREATE TABLE IF NOT EXISTS pi_reports (
  kind         TEXT PRIMARY KEY,   -- 'report-full' | 'run-repair'
  -- When the PI collected it, not when we stored it. On a box being repaired
  -- the gap between those two is the interesting part.
  collected_at TEXT NOT NULL,
  -- Bounded at 64 KiB server-side, and a cut is ANNOUNCED inside the body.
  body         TEXT NOT NULL,
  -- A repair that failed is still worth storing: it is the log that says why.
  ok           INTEGER NOT NULL DEFAULT 1
);

-- Operator-set values that must outlive a deploy. Currently the team colour
-- and team name (spec 9.2: "one configurable team-color token that the
-- operator sets once"). A table rather than a Worker secret because the admin
-- changes it from the UI, and secrets are write-only.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plays_started_at ON plays (started_at);
CREATE INDEX IF NOT EXISTS idx_plays_user_id    ON plays (user_id);
CREATE INDEX IF NOT EXISTS idx_plays_track_id   ON plays (track_id);
CREATE INDEX IF NOT EXISTS idx_votes_play_id    ON votes (play_id);
CREATE INDEX IF NOT EXISTS idx_tracks_track_key ON tracks (track_key);
CREATE INDEX IF NOT EXISTS idx_devices_user_id  ON devices (user_id);

-- Failed-authentication counters, one row per (scope, address). See
-- src/throttle.ts for why this is a table rather than a Cloudflare rate-limit
-- binding, and why only FAILURES are counted.
--
-- window_start is epoch milliseconds rather than the ISO text used elsewhere:
-- nothing human ever reads this table, and the throttle arithmetic is in ms.
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket        TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
