-- 005 - choosing the relay speaker from the Admin screen.
--
-- Until now the box's output speaker was [relay] speaker_mac in
-- /etc/lockerroom/config.toml, which needs SSH to change. On campus there is no
-- SSH: 7844 is blocked so Cloudflare Tunnel cannot run, Tailscale is blocked by
-- SNI, and TCP/22 is filtered between guest clients. So in the one place the
-- box actually lives, the speaker it plays through could not be changed at all.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: add an argument column to pi_commands.
-- That table's comment says why - "there is deliberately no 'run this string'
-- command: that would be remote code execution on a device sitting in a locker
-- room" - and a parameterised command is the first crack in it. Instead the
-- two halves travel differently:
--
--   scanning   an ACTION that takes no parameters -> a fourth allowlisted
--              command name, no schema change at all
--   selecting  a FACT about the box's configuration -> a settings row, carried
--              down on the beacon response and validated on arrival by the Pi
--
-- See docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md.

-- The most recent Bluetooth scan, and only that one.
--
-- Replaced wholesale on every scan, because a device list is a SNAPSHOT rather
-- than a log: a speaker that has left the building must stop being offered.
-- The scan arrives as its own beacon payload, not in pi_commands.result, which
-- the beacon handler truncates to 2000 characters - a locker room with thirty
-- phones in it overflows that, and a truncated list is worse than none because
-- the speaker somebody is holding goes missing for no visible reason.
CREATE TABLE IF NOT EXISTS bt_devices (
  mac        TEXT PRIMARY KEY,
  -- NULL means the device advertises no name, and the UI shows the MAC. Not
  -- defaulted to the MAC here: "has no name" should stay a fact about the
  -- device rather than becoming a fake name nothing can tell apart from a real
  -- one.
  name       TEXT,
  -- Bluetooth Class of Device. The major class (bits 8-12) says whether this
  -- is audio gear, which is what sorts speakers to the top of the list. NULL
  -- when the device does not report one - and the UI SORTS on this rather than
  -- filtering, because the field is self-reported and a filter can hide the
  -- exact speaker being held in front of the box.
  cod        INTEGER,
  -- NULL is normal, not an error: RSSI is only populated for a device seen
  -- recently.
  rssi       INTEGER,
  scanned_at TEXT NOT NULL
);

-- The selected speaker lives in `settings` under `relay_speaker_mac`, with no
-- schema change needed. THREE states, and collapsing any two of them breaks
-- something real:
--
--   row absent  never configured from the UI. The Pi falls back to
--               config.toml, so an existing box keeps working untouched.
--   a MAC       relay to this speaker.
--   ''          explicitly cleared - the "Use wired output" button. It must
--               override config.toml, or that button silently does nothing on
--               any box that has a speaker in its file.
--
-- `relay_speaker_name` sits alongside it for display only. It is never used to
-- identify anything.

-- What the box is actually playing through, reported every beacon.
--
-- This is the deferred "report the selected output in the heartbeat" item,
-- folded in because a selection screen that cannot show the current selection
-- is half a feature - and because what was CHOSEN and what is PLAYING disagree
-- exactly when something is wrong, which is when the screen matters.
--
-- All nullable: a Pi running older code reports none of it, and the screen says
-- unknown rather than a confident wrong answer.
ALTER TABLE heartbeats ADD COLUMN output_kind TEXT;      -- usb | jack | relay
ALTER TABLE heartbeats ADD COLUMN output_card TEXT;      -- ALSA card, or the MAC when relaying
ALTER TABLE heartbeats ADD COLUMN relay_connected INTEGER;
ALTER TABLE heartbeats ADD COLUMN relay_error TEXT;      -- why not, in words the operator can act on

-- Verify (after a scan and a selection):
--   SELECT mac, name, cod, rssi FROM bt_devices ORDER BY scanned_at DESC;
--   SELECT key, value FROM settings WHERE key LIKE 'relay_speaker%';
