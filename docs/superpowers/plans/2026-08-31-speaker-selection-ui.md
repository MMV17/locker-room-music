# Speaker selection UI — implementation plan

> Implements `docs/superpowers/specs/2026-08-31-speaker-selection-ui-design.md`.

**Goal:** choose the relay speaker from the Admin screen instead of by SSH.

**Architecture:** scan travels as a fourth fixed allowlist command; the chosen
speaker travels as a `settings` row carried on the beacon response. `pi_commands`
gains no argument column.

**Tech stack:** Python 3.13 on the Pi (tests run on 3.9 — see constraints),
Hono + D1 on Workers, React on the web.

## Global constraints

- **The Pi test venv is Python 3.9.** `config.py` imports `tomllib` (3.11+) and
  therefore cannot be imported by any test. Anything that needs testing lives
  outside `config.py`. This is why `macaddr.py` exists; new modules follow it.
- **No `from .config import Config` at runtime** in a tested module — type-only
  under `TYPE_CHECKING`, as `control.py` already does.
- **Every subprocess call is an argv list**, never a shell string. A MAC is
  always its own element.
- **Every failure path ends on a working speaker.** A missing file, a dead
  relay, an unreachable server: all fall back to a wired output.
- **The wired fallback rule:** clear `/run/lockerroom/relay-target` and reroute
  BEFORE attempting a new connection, never after.
- Tests: `.venv/bin/python -m pytest pi/tests/ -q` and `cd backend && npm test`.

---

### Task 1: Relay target resolution and its on-disk cache

**Files:** create `pi/lockerroom/relaytarget.py`, `pi/tests/test_relaytarget.py`

**Produces:** `CACHE_PATH`, `read_cache(path) -> str | None`,
`write_cache(path, value) -> None`, `resolve(server, cached, configured) -> str | None`

Three-state values throughout: `None` = no opinion, `""` = explicitly off, a MAC
= use it. `resolve` prefers server, then cache, then config; `""` at any level
that has an opinion means off and stops the search.

`read_cache` returns `None` for a missing file and for a file whose contents do
not validate — a corrupt cache must not wedge the box, and a MAC is cheap to
re-learn from the next beacon.

- [ ] Write failing tests: precedence in all three positions, `""` beats a
      configured MAC, garbage cache reads as `None`, missing file reads as
      `None`, round-trip through `write_cache`.
- [ ] Run: `.venv/bin/python -m pytest pi/tests/test_relaytarget.py -q` → FAIL
- [ ] Implement.
- [ ] Run → PASS. Commit.

### Task 2: RelayManager gains a settable target

**Files:** modify `pi/lockerroom/relay.py`, `pi/tests/test_relay.py`

**Consumes:** Task 1's three-state convention.
**Produces:** `RelayManager(mac: str | None = ...)`, `async set_target(mac: str | None) -> None`,
`property target -> str | None`, `property connected -> bool`, `property last_error -> str | None`

`mac` becomes optional so the manager can exist on a box that has never been
given a speaker — today it is constructed only when `config.toml` has one, which
a runtime selection makes impossible.

`set_target` on an unchanged MAC is a no-op (no reconnect churn). On a change:
disconnect old → remove target file → reroute → `pair` → `trust` → `connect`.
`pair` returning `org.bluez.Error.AlreadyExists` is success. `ensure_connected`
keeps doing connect-only, because re-pairing on every reconnect is noise.

- [ ] Failing tests: set to a new MAC tears down the old first (assert call
      order), same MAC is a no-op, `None` clears to wired, invalid MAC raises
      and leaves the previous target intact, `AlreadyExists` counts as paired,
      `last_error` populated on failure.
- [ ] Run → FAIL. Implement. Run → PASS. Commit.

### Task 3: The scan script and its parser

**Files:** create `pi/scripts/bt-scan.sh`, `pi/lockerroom/btscan.py`,
`pi/tests/test_btscan.py`

**Produces:** `parse(text) -> list[dict]` with keys `mac`, `name`, `cod`, `rssi`.

The script emits `MAC<TAB>COD<TAB>RSSI<TAB>name`, one per line. `parse` treats
that output as untrusted: a device name is chosen by a stranger's phone. Lines
whose MAC fails `macaddr.normalise` are dropped. `cod`/`rssi` that are not
integers become `None` rather than failing the line.

- [ ] Failing tests: a good line parses, junk MAC dropped, missing name → `None`,
      non-integer cod/rssi → `None`, tabs inside a name survive (name is the
      last field, split with `maxsplit=3`), empty input → `[]`.
- [ ] Run → FAIL. Implement both. Run → PASS. Commit.

### Task 4: control.py — timeouts, attentive mode, scan and state reporting

**Files:** modify `pi/lockerroom/control.py`, `pi/tests/test_control.py`

`ALLOWED` values become `(argv, timeout_s)` so one slow command does not set the
timeout for all of them. Adds `scan-speakers` → `(["sudo", "/usr/local/bin/bt-scan.sh"], 45)`.

Beacon changes:
- send immediately when a result is pending, instead of sleeping a cycle first
- attentive mode: 5s interval for 180s after a command
- payload gains `scan`, `relay`, `output`
- response `relay_speaker` reconciled through Task 1 and applied via Task 2
- scan refused while a play is open

- [ ] Failing tests: per-command timeout selected, unknown command still
      refused, attentive window opens on a command and expires, pending result
      beacons at once, scan refused mid-play, scan payload attached once and
      cleared after, server MAC applied, garbage server MAC refused without
      disturbing the current target.
- [ ] Run → FAIL. Implement. Run → PASS. Commit.

### Task 5: Wire it in main.py

**Files:** modify `pi/lockerroom/main.py`, `pi/lockerroom/lifecycle.py`

`RelayManager` is now always constructed. `SessionManager` gains
`set_relay_mac(mac)` so the exclusion guard follows a runtime change — without
it, a newly chosen speaker would be granted the aux and written into the play
data, which is the exact bug that killed the relay on 2026-08-23.

- [ ] Failing test in `test_lifecycle_relay.py`: exclusion follows `set_relay_mac`.
- [ ] Implement both. Full Pi suite → PASS. Commit.

### Task 6: Backend schema and allowlist

**Files:** modify `backend/schema.sql`, `backend/src/piControl.ts`;
create `backend/migrations/005-speaker-selection.sql`

Adds the `bt_devices` table from the spec, `scan-speakers` to `PI_COMMANDS`, and
`isMacAddress()` sharing the Pi's regex.

- [ ] Failing test for `isMacAddress` (case, separators, length, junk).
- [ ] Implement. Run → PASS. Commit.

### Task 7: Beacon handler

**Files:** modify `backend/src/index.ts`, `backend/test/`

Accepts `scan` (replaces `bt_devices` wholesale), `relay` and `output` (stored
on the heartbeat row); returns `relay_speaker` from `settings`.

- [ ] Failing tests: scan replaces prior rows, junk devices rejected, absent
      settings row returns `null`, empty string returned as empty.
- [ ] Implement. Run → PASS. Commit.

### Task 8: Admin endpoints

**Files:** modify `backend/src/admin.ts`

`GET /api/admin/pi/speakers` → devices + selection + live relay state.
`PUT /api/admin/pi/speakers` → `{mac}` sets, `{mac: null}` clears. MAC validated
before storage; 400 on anything else.

- [ ] Failing tests: set, clear, reject junk, response shape.
- [ ] Implement. Run → PASS. Commit.

### Task 9: The Admin screen

**Files:** modify `web/src/api.ts`, `web/src/screens/Admin.tsx`

A **Speaker output** block: current output line, Scan button with status, device
list sorted audio-first then by RSSI, "Use this one", "Use wired output".
Instruction order is load-bearing: press Scan, wait for "scanning", THEN put the
speaker in pairing mode.

- [ ] Implement. `npm run build` clean. Commit.

### Task 10: Ship

**Files:** modify `pi/scripts/deploy.sh`, `docs/STATE.md`

`deploy.sh` installs `bt-scan.sh`. Apply migration 005, deploy the Worker,
deploy the Pi, then the five hardware steps from the spec.
