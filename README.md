# AuxGoat

A Bluetooth speaker for a team's locker room that knows what it is playing.
Whoever has the aux plays music from their phone as usual; everyone else votes
each song up or down from a web page, and the team gets song and DJ
leaderboards. No microphone, no recording: titles come from Bluetooth
metadata.

## What is in this repo

| Directory | What it is | Runs on |
|---|---|---|
| `pi/` | The speaker: a Python listener (`pi/lockerroom/`), its watchdogs and scripts (`pi/scripts/`), systemd units (`pi/systemd/`) | Raspberry Pi 4B, Debian 13 |
| `backend/` | The API and database: a Cloudflare Worker (Hono) on D1, with a daily backup to R2 | Cloudflare Worker `auxgoat-hc` |
| `web/` | The voting app and the Admin screen: a React single-page app, built into `backend/public` and served by that Worker | (same Worker) |
| `apex/` | The front door at auxgoat.com: a team-code box that sends you to your team's site | Cloudflare Worker `auxgoat` |
| `tools/` | `loadtest.mjs`, the smoke and load check for beta | your laptop |
| `docs/` | `LAUNCH.md` (pre-launch checklist and cut-over steps), `spec.md`, the hardware runbook, design notes, and `STATE.md` (the dated engineering log) | |

How the pieces talk: the speaker can only make outbound HTTPS calls (the
school network allows nothing inbound), so it posts plays to the Worker from a
store-and-forward outbox and checks in every 10 seconds on a "beacon" that also
carries back commands from the Admin screen. Phones poll the Worker.

## Where it lives

| URL | What |
|---|---|
| `https://auxgoat.com` | Front door (type the team code) |
| `https://hc.auxgoat.com` | The team's voting app; `/admin` is the coach's screen |
| `https://auxgoat-hc.mmvinton17.workers.dev` | Same app on Cloudflare's own hostname, a fallback if a school filter blocks the pretty one |
| `https://auxgoat.mmvinton17.workers.dev` | Same front door, fallback |

## Running it locally

Node 22 and Python 3.13.

```bash
# Backend: unit tests and typecheck
cd backend && npm ci && npx vitest run && npx tsc --noEmit -p .
```

```bash
# Web: typecheck and build (writes backend/public)
cd web && npm ci && npm run build
```

```bash
# Front door: tests and typecheck
cd apex && npm ci && npx vitest run && npx tsc --noEmit
```

```bash
# Speaker code: tests (no hardware needed)
python3 -m venv .venv && .venv/bin/pip install -r pi/requirements.txt -r pi/requirements-dev.txt
cd pi && ../.venv/bin/python -m pytest tests -q
```

To run the whole app on your machine, create `backend/.dev.vars` with
`DEVICE_KEY`, `TEAM_CODE`, `ADMIN_PASSWORD` and `MAC_SALT` set to any
development values (the end-to-end script expects `dev-device-key`, `dev-team`,
`dev-admin`), then:

```bash
cd backend && npx wrangler d1 execute lockerroom --local --file=./schema.sql
```

```bash
cd backend && npx wrangler dev --local
```

```bash
cd backend && ./test/e2e.sh
```

`cd web && npm run dev` gives hot reload on port 5173, proxying `/api` to the
Worker on 8787.

Every pull request runs all of the above plus shellcheck (`.github/workflows/ci.yml`).

## Shipping a change

| What changed | How it ships |
|---|---|
| `backend/` or `web/` | Merge to `main`. GitHub Actions tests, builds and deploys the Worker (`deploy-worker.yml`). |
| `apex/` | Merge to `main` (`deploy-apex.yml`). |
| `pi/` (the speaker) | Merge to `main`, then in Admin → Diagnostics press **Update speaker software**. The speaker pulls the new code, tries it, and puts the old version back by itself if the new one cannot check in. |
| Database schema | By hand, with a backup first, **before** merging the code that needs it: `backend/scripts/backup.sh`, then `npx wrangler d1 execute lockerroom --remote --file=backend/migrations/<file>.sql`. |

Deploying the Worker by hand is `cd backend && npm run deploy`, never a bare
`npx wrangler deploy`: wrangler creates a new, secret-less Worker if the name
in `wrangler.toml` does not exist yet, and the script refuses to.

A deploy takes up to two minutes to reach every Cloudflare location. Checking
sooner tests the old version.

## Looking after the speaker

Everything is in Admin → Diagnostics, from a phone:

- **Report full** reads the box's state (services, Bluetooth, audio route,
  wifi, clock, software version). It changes nothing and is allowed mid-song.
- **Run repair** pulls this repo on the box and runs
  `pi/scripts/remote-repair.sh`: it clears the usual faults (radio soft-block,
  stopped Bluetooth services, audio routing). Refused while a song is playing.
- **Update speaker software** installs the listener from `main`, with automatic
  rollback.
- **Restart listener** and **Reboot** do what they say.

The speaker's server addresses, in the order it tries them, are the
`api_base_url` in its `/etc/lockerroom/config.toml` and then the fallbacks in
`pi/lockerroom/endpoints.py`. It stays on whichever one last worked.

When there is a cable to hand, `pi/scripts/deploy.sh pi@<host>` installs
everything over SSH and `pi/scripts/serial-deploy.py` does the listener over
the serial console.

## What is still called `lockerroom`

The project was renamed from "Locker Room Music" to AuxGoat on 2026-11-10. Four
things keep the old one-word name on purpose, because renaming them risks more
than it gains:

- **On the speaker:** `/opt/lockerroom`, `/etc/lockerroom`, `/var/lib/lockerroom`,
  `/run/lockerroom`, the `lockerroom-*.service` units and the `lockerroom`
  Python package. The listener is the only way to reach the box, and moving its
  files and units remotely is the kind of change that needs a cable if it goes
  wrong. New files on the box are named `auxgoat-*`.
- **In Cloudflare:** the D1 database `lockerroom` and the R2 bucket
  `lockerroom-backups`. Neither can be renamed in place; it would mean copying
  the data to new resources.
- **In the browser:** the `lr_token` cookie and `lr_*` saved settings. Renaming
  them would sign every player out.

None of these is visible to a player or a coach.

## Secrets

Never in the repo. The Worker has four, set with `npx wrangler secret put`:
`DEVICE_KEY` (shared with the speaker), `MAC_SALT` (salts phone identifiers;
changing it orphans every phone record), `TEAM_CODE`, `ADMIN_PASSWORD`.
Cloudflare will not show them again, so keep a copy somewhere safe. GitHub
Actions needs `CLOUDFLARE_API_TOKEN` as a repository secret.
