-- 001 — self-signup: split name, drop position.
--
-- schema.sql is all CREATE TABLE IF NOT EXISTS, so it cannot reshape a table
-- that already exists. This migration does that once, in place.
--
-- Written to be safe against the live database rather than a fresh one:
-- production already holds a real player, a claimed device, and 17 plays
-- attributed to them. users.id is referenced by plays.user_id,
-- devices.user_id, and device_tokens.user_id, so the row is ALTERed in place
-- and never recreated — dropping and reinserting would orphan every one of
-- those references and silently erase a season's attribution.
--
-- Idempotent it is NOT. Run once. Verify with the queries at the bottom.

ALTER TABLE users ADD COLUMN first_name   TEXT;
ALTER TABLE users ADD COLUMN last_name    TEXT;
ALTER TABLE users ADD COLUMN identity_key TEXT;

-- Backfill from the old single `name` column. Everything before the first
-- space is the first name, the remainder is the last name; a single-word name
-- keeps the whole string as the first name and gets an empty last name rather
-- than losing it.
UPDATE users
SET first_name = TRIM(
      CASE WHEN INSTR(name, ' ') > 0 THEN SUBSTR(name, 1, INSTR(name, ' ') - 1)
           ELSE name END),
    last_name = TRIM(
      CASE WHEN INSTR(name, ' ') > 0 THEN SUBSTR(name, INSTR(name, ' ') + 1)
           ELSE '' END)
WHERE first_name IS NULL;

-- identity_key must match normalize() in trackKey.ts: lowercased, punctuation
-- stripped, whitespace collapsed. SQL cannot strip punctuation generally, so
-- this covers the characters that actually occur in names (apostrophes and
-- hyphens: O'Brien, Smith-Jones). Anything more exotic gets corrected the
-- next time that player signs in, because the app recomputes the key.
UPDATE users
SET identity_key =
      REPLACE(REPLACE(LOWER(TRIM(first_name)), '''', ''), '-', '') || '|' ||
      REPLACE(REPLACE(LOWER(TRIM(last_name)),  '''', ''), '-', '') || '|' ||
      LOWER(TRIM(COALESCE(jersey_number, '')))
WHERE identity_key IS NULL;

ALTER TABLE users DROP COLUMN position;
ALTER TABLE users DROP COLUMN name;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identity ON users (identity_key);

-- Verify (should show the existing player intact, split correctly, with their
-- device and plays still attached):
--   SELECT id, first_name, last_name, jersey_number, identity_key FROM users;
--   SELECT COUNT(*) FROM plays  WHERE user_id IS NOT NULL;   -- expect 17
--   SELECT COUNT(*) FROM devices WHERE user_id IS NOT NULL;  -- expect 1
