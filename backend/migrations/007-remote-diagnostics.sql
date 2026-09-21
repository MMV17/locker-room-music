-- 007 - seeing and fixing the box over the 443 beacon.
--
-- Written after 2026-09-20, when the speaker stopped accepting pairings and it
-- took an hour to find out why — and then could not be fixed remotely at all.
-- The box was online and beaconing, the controller was healthy, the listener
-- took commands, nobody was connected, and the adapter simply was not
-- advertising. Cause was almost certainly `keep-discoverable` and/or `bt-agent`
-- not running.
--
-- Every part of that was invisible from here:
--
--   * `report-status` checks lockerroom-listener, bluetooth and bluealsa. NONE
--     of those were the broken units. It never looked at bt-agent,
--     keep-discoverable, lockerroom-btwatch or `hciconfig hci0` — and the
--     PSCAN/ISCAN line on that last one is the single fact that was wanted.
--   * No allowlisted command could restart the Bluetooth units.
--   * `lockerroom-btwatch` only fires when the controller is not UP RUNNING, so
--     a healthy-but-silent adapter never triggered it.
--   * The Admin screen rendered `result.split("\n")[0].slice(0, 40)`, so even
--     the service states that WERE collected never reached a human.
--
-- And on campus there is no second way in: 7844 is blocked both protocols so
-- Cloudflare Tunnel cannot run, Tailscale is blocked by SNI, and TCP/22 is
-- filtered between guest clients and outbound. The beacon is the only door.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, and it is the same refusal migration 005
-- wrote down: it adds no argument column to `pi_commands`. Both new commands
-- are fixed names mapping to fixed argv on both ends. There is still no "run
-- this string" command, because that is remote code execution on a device in a
-- locker room. `run-repair` runs a COMMITTED script at a FIXED path — the
-- parameter, such as it is, is the commit you pushed.

-- The latest long-form output from the box, one row per kind.
--
-- This exists for exactly the reason bt_devices does, and the reasoning is
-- worth repeating rather than referencing: `pi_commands.result` is truncated to
-- 2000 characters by the beacon handler, a full diagnostic dump is many times
-- that, and a TRUNCATED dump is worse than no dump at all — the line you needed
-- goes missing with nothing on screen to say it was dropped. So the body rides
-- its own beacon payload, into its own storage, the way a scan does.
--
-- Keyed by kind rather than a single row: a repair's log must not overwrite the
-- diagnostic that justified running it. Each kind keeps only its latest, which
-- is the bt_devices "a snapshot, not a log" rule — the state of a box an hour
-- ago is not what anyone is looking at the screen to find out.
CREATE TABLE IF NOT EXISTS pi_reports (
  -- 'report-full' or 'run-repair'. The command name that produced the body, so
  -- the screen can label it without a join and a new kind needs no migration.
  kind         TEXT PRIMARY KEY,
  -- When the PI collected it, not when we stored it. Those differ by a beacon
  -- interval, and on a box being repaired the difference is the interesting
  -- part.
  collected_at TEXT NOT NULL,
  -- Bounded server-side (see piReports.ts MAX_BODY). If it is ever cut, the cut
  -- is ANNOUNCED in the body itself — silent truncation is the exact failure
  -- this table was created to stop repeating.
  body         TEXT NOT NULL,
  -- Whether the command that produced this exited 0. A repair that failed is
  -- still worth storing and reading; it is the log that says what went wrong.
  ok           INTEGER NOT NULL DEFAULT 1
);

-- Verify (after pressing "report full" and waiting one beacon):
--   SELECT kind, collected_at, ok, length(body) FROM pi_reports;
