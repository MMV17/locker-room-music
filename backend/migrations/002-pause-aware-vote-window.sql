-- 002 - pause-aware vote window.
--
-- The vote window closed on wall-clock time, so pausing a song mid-track let
-- voting expire while the song was still on the speaker. Observed live:
-- "POWER" by Kanye West started 22:04:28 with duration 292093ms, so the
-- window closed at 22:09:50 regardless of the track being paused.
--
-- Additive only. Existing rows get NULL, which voteWindow.ts treats exactly
-- as it does today.

ALTER TABLE plays ADD COLUMN keepalive_at TEXT;
ALTER TABLE plays ADD COLUMN play_status  TEXT;
