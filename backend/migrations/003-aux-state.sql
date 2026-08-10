-- 003 - who has the aux, and who is waiting for it.
--
-- The site used to tell everyone "Connect to AuxGoat over Bluetooth to DJ"
-- whenever nothing was playing. Since one phone at a time became a real rule
-- that is a lie for anyone who is not the one holding it, and it is exactly
-- the screen a blocked player stares at.
--
-- Lives on `heartbeats` because that is already "what the speaker last told
-- us", and it is written by the same beacon in the same request. It is
-- deliberately NOT a table of its own: this is volatile state with a single
-- writer and no history worth keeping, and reading it must never cost a join.
--
-- Additive only. Existing rows get NULL, which /api/now reads exactly as it
-- reads an old Pi that does not report any of this yet.

-- SHA-256(mac + MAC_SALT), never a raw MAC. Same hash as devices.mac_hash, so
-- it joins straight to a claimed device and therefore to a person - which is
-- what lets the site say "Mack has the aux" rather than "a phone does".
ALTER TABLE heartbeats ADD COLUMN aux_holder_hash TEXT;
-- The Bluetooth name, for a phone nobody has claimed yet. Non-identifying in
-- the same way devices.alias already is.
ALTER TABLE heartbeats ADD COLUMN aux_holder_alias TEXT;
-- JSON array of {hash, alias}, oldest first, so "you are next" means
-- something. A column rather than a table for the reason above; nothing ever
-- queries INTO this, it is read whole and handed to one screen.
ALTER TABLE heartbeats ADD COLUMN aux_waiting TEXT;

-- Verify (run after the Pi has beaconed once):
--   SELECT speaker_name, aux_holder_alias, aux_waiting FROM heartbeats
--    ORDER BY last_seen_at DESC LIMIT 1;
