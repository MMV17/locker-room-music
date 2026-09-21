-- 2026-09-08: this Worker had no rate limiting of any kind. /api/admin/* took
-- unlimited ADMIN_PASSWORD guesses with no lockout and no record that anyone
-- had tried; the team-code endpoints were equally open. The apex Worker's
-- limiter only ever guarded /go, and apex/wrangler.toml records the
-- measurement proving that binding never bound at all.
--
-- See src/throttle.ts. Only FAILURES are counted, which is what keeps a limit
-- this low safe with a whole team behind one school NAT.
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket        TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
