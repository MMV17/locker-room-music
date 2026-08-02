-- Locker Room Music schema (spec section 6.1).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  jersey_number TEXT,
  position      TEXT,
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
  voided        INTEGER NOT NULL DEFAULT 0
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
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plays_started_at ON plays (started_at);
CREATE INDEX IF NOT EXISTS idx_plays_user_id    ON plays (user_id);
CREATE INDEX IF NOT EXISTS idx_plays_track_id   ON plays (track_id);
CREATE INDEX IF NOT EXISTS idx_votes_play_id    ON votes (play_id);
CREATE INDEX IF NOT EXISTS idx_tracks_track_key ON tracks (track_key);
CREATE INDEX IF NOT EXISTS idx_devices_user_id  ON devices (user_id);
