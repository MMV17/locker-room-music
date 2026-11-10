# Launch checklist

What has to happen, in order, to take the 2026-11-10 pre-launch work live and
finish the rename to AuxGoat. Nothing here needs a laptop or a cable unless a
step says so. Each step says how to tell it worked and what to do if it did not.

**The order matters.** The speaker in the locker room can only be reached
through the website, so the website goes first, the speaker second, and the old
hostname is retired last.

---

## 1. Merge, and check the site

1. Merge the pull request into `main`.
2. In GitHub → Actions, wait for **Deploy Worker** and **Deploy front door** to
   go green (about three minutes).
   - Deploy Worker will show a yellow warning that the Worker is "still named
     `locker-room-music`". That is expected until step 2.
   - No database migration is needed for this release.
3. Open `https://hc.auxgoat.com` on a phone. Sign in, look at Now Playing, the
   boards and History.
4. Open `https://hc.auxgoat.com/admin`, sign in, open **Diagnostics**. It should
   show "Speaker software: not reported yet" and "Checking in through:" with
   the hostname the speaker is using today.

If the deploy is red, nothing changed on the live site. Read the failed step's
message; it says what to fix.

## 2. Rename the Worker in Cloudflare (two minutes, any quiet moment)

The code now calls the team Worker `auxgoat-hc`. Cloudflare still has it under
the old name. A Worker has to be renamed in the dashboard, because that is the
only way to keep its secrets.

1. Cloudflare dashboard → **Workers & Pages** → `locker-room-music` →
   **Settings** → rename it to exactly `auxgoat-hc`.
2. GitHub → Actions → **Deploy Worker** → **Run workflow** (on `main`).
3. The run should finish green with no rename warning.

What changes: the fallback address becomes
`https://auxgoat-hc.mmvinton17.workers.dev`, and the old `locker-room-music…`
address stops working. `hc.auxgoat.com` and the speaker are not affected.

**If the dashboard has no rename option:** do not change anything. The site
keeps deploying to the old name indefinitely, safely. The alternative (creating
`auxgoat-hc` as a new Worker) needs all four secrets re-entered from the copy
kept off the laptop, and is not worth doing before launch.

**Never run a bare `npx wrangler deploy` in `backend/`.** Use `npm run deploy`.
See the README.

## 3. Give the speaker its first wireless update

This installs the new speaker software: 10-second response to buttons, a
fallback list of server addresses, the update button itself, and several fixes
for ways the box could go quiet. If the new software cannot check in, the
speaker puts the old version back by itself.

**Before you start:** steps 1 and 2 are done (step 2 is optional but
recommended), and nobody is playing music.

1. **Check the speaker can fetch code.** Admin → Diagnostics → open the most
   recent **run repair** report (press Run repair once if there is none).
   - `repo: /opt/lockerroom/repo (owner: …)` and `now: … on origin/main` → carry on.
   - `ERROR: no git clone` → stop. The speaker needs one visit with a cable to
     create the clone (the command is printed by `pi/scripts/deploy.sh`). After
     that, everything is wireless.
   - A branch other than `origin/main` → stop and ask; the box is following a
     different branch than the one you merged to.
2. **Press "Update speaker software".** The first time, the confirmation says
   it goes through Run repair. Confirm.
3. About a minute later, open the repair report. It should include:
   - `installed /usr/local/bin/auxgoat-update`
   - `VERIFIED: the listener package is byte-for-byte unchanged.`
   - `scheduled unknown -> <commit>`
4. **Wait about four minutes.** The speaker shows offline for roughly half a
   minute while it restarts, then spends about two minutes proving the new
   software works before keeping it.
5. **It worked when** Diagnostics shows "Speaker software: `<commit>`" and a
   "Last update" report reading `AuxGoat software update: committed`.

From then on, a speaker change is: merge to `main`, press **Update speaker
software**.

If it did not work:

| What you see | What happened | What to do |
|---|---|---|
| No software version; the next repair report starts `last update: rolled-back` | The new software did not start or could not check in. The old version is back. | Nothing is broken. The reason is in that report. It needs a code fix and a new commit; the same commit is refused on purpose. |
| Report says `deferred` | Music was playing. | Press again when it is quiet. |
| Speaker offline for longer than ten minutes | Most likely campus wifi. The speaker decides once the network is back. | Wait. Check Now Playing later. |
| The report says in capitals that both versions failed | The one case that needs a cable. | `pi/scripts/deploy.sh` over the USB-C cable, or `serial-deploy.py`. |

Things only the real box can confirm, worth a glance in the first full report
after updating (**Report full**): the `auxgoat-update status` section shows
`idle` and the installed commit; `timedatectl` shows whether the clock is
synchronised (if it says no, tell whoever maintains this: the box has no clock
battery, and a wrong clock shifts when voting closes).

## 4. Retire the legacy test hostname

The speaker was provisioned with one server address, on an unrelated test
domain (the second `routes` entry in `backend/wrangler.toml`). The updated
speaker software knows two more addresses and switches by itself. **Do not
remove the old one until the speaker is running the new software**, or the box
loses the only address it knows, cannot be reached, and its wifi watchdog
starts rebooting it. That needs a cable to fix.

1. Precondition: step 3 worked. Diagnostics shows a software version.
2. In `backend/wrangler.toml`, delete the route line for the legacy hostname
   and the comment block above it, and merge. The deploy removes the hostname
   from Cloudflare.
3. Within a few minutes, Diagnostics should show "Checking in through:"
   change to `auxgoat-hc.mmvinton17.workers.dev` or `hc.auxgoat.com`, and the
   speaker should stay online.
   - If the speaker goes offline and stays offline for ten minutes, put the
     route line back and merge. The hostname returns and so does the speaker.
4. Leave it for a day or two of real use.
5. Only then delete the test domain's zone from Cloudflare. **Check first**
   that nothing else uses it: that zone also carries the mail records for a
   mailbox on that domain (`docs/dns-snapshot-legacy-zone.md` lists them).
   Deleting the zone stops mail to that domain. If the mailbox is already
   abandoned, delete the zone, and cancel the registrar's auto-renewal
   separately.
6. Delete `docs/dns-snapshot-legacy-zone.md`. That removes the last mention of
   the test domain from the repo.

## 5. Rename the GitHub repository

GitHub → the repo → **Settings** → **General** → Repository name → `auxgoat`.

Do this after the pull request is merged. GitHub redirects the old address, so
nothing breaks: existing clones keep working, and the speaker switches its own
clone to the new address the next time it updates. On your
own machine:

```bash
git remote set-url origin ssh://git@ssh.github.com:443/MMV17/auxgoat.git
```

The folder on the Mac can be renamed too; keep the `.nosync` suffix.

## 6. Security chores (ten minutes, once)

- **Speaker's deploy key must be read-only.** GitHub → repo → Settings →
  Deploy keys: the key the speaker uses should not have "Allow write access".
  The speaker runs code from this repo as root, so write access to the repo is
  root on the box.
- **Protect `main`.** Settings → Branches → require a pull request before
  merging. A merge deploys the site and is what the speaker installs.
- **Decide about the team code.** It is still the dictionary word chosen for
  the beta, it is the only thing between the internet and a team's data, and
  it is written in `apex/src/teams.ts`. Changing it means a new `TEAM_CODE`
  secret on the Worker and the same word in `apex/src/teams.ts`.
- **Optional, stronger:** the updater will refuse unsigned code if a file
  `/etc/lockerroom/allowed_signers` exists on the box. Setting that up needs a
  signing key kept off the laptop and one cable visit.

## 7. Beta test plan

### The automated check

From any laptop with Node 18 or newer, outside practice hours:

```bash
node tools/loadtest.mjs --url https://hc.auxgoat.com --code <TEAM_CODE> --players 20 --minutes 3 --burst --yes
```

It checks the site answers correctly, then simulates 20 phones on Now Playing
for three minutes and everyone opening the boards at once. It never votes.
It passes (exit code 0) only if every one of these holds:

| Measure | Pass |
|---|---|
| Smoke checks (page loads, sign-in works, errors are well-formed) | all pass |
| Now Playing response time | 95% within 0.8 s, 99% within 2 s, none over 8 s |
| Failed requests | at most 0.5%, and no server errors or rate-limit responses |
| Vote tallies visible while voting is open | never |
| Boards and History under a burst | 95% within 1.5 s |

Afterwards delete the player "Loadtest Bot" in Admin → Roster.

Run it again with `--players 75 --minutes 5` once before the first full-team
session. That run costs about 3,000 requests of the 100,000 a day the free
plan allows.

### What to ask beta testers to do (and report)

Give each tester this list. Ask for a screenshot of anything that looks wrong,
with the time it happened.

1. Open `auxgoat.com` on your phone, type the team code, enter your name. Did
   you know what the app was for before you signed in?
2. With a song playing: can you see both thumbs without scrolling? Vote. Did
   it show clearly that your vote counted?
3. Stay on the screen through the end of the song and into the next one. Did
   the result of the first song appear?
4. Open Songs, DJs and History. Anything slow, empty or confusing?
5. Connect your phone to the speaker over Bluetooth and play a song. Does Now
   Playing show your song within about ten seconds? Claim your phone in
   Settings. Do later songs show your name?
6. With two phones connected: does the second person see that someone else has
   the aux, and get it when the first one stops?
7. Turn wifi off for a minute and back on. Does the app recover by itself?
8. Leave the app open, lock the phone for ten minutes, unlock. Is it current?

For the coach: sign in to `/admin`, add and deactivate a player, void a song,
press Report full, and try Find speakers in Settings.

### Numbers worth watching in the first week

- Cloudflare dashboard → Workers → `auxgoat-hc` → Metrics: requests per day
  (limit 100,000), errors.
- Cloudflare dashboard → D1 → `lockerroom` → Metrics: rows read per day (limit
  5 million) and rows written per day (limit 100,000). Before this release a
  full practice would have exceeded the write limit; it should now sit far
  below it.
- Admin → Diagnostics: the speaker stays online, and "clock" shows no warning.

## 8. Known gaps, not fixed in this release

Deliberately left for a decision or for hardware testing:

- **Anyone with the team code can sign in as any teammate** (name and number
  are the whole identity, by design). A per-player PIN would close it and
  costs every player a step at sign-in.
- **The front door does not limit team-code guesses.** The limiter there has
  never worked on this Cloudflare plan. The team site itself now limits guesses
  properly.
- **The coach's password is kept in the browser tab** and sent with each Admin
  request. A sign-in cookie would be better.
- **Bluetooth gets choppy with several phones connected.** The new software
  logs when a waiting phone is streaming, and Report full shows it. The
  candidate fixes change how phones are disconnected and need trying on the
  real speaker first.
- **Phone hardware addresses still travel from the speaker to the server**,
  which hashes them before storing. Players can no longer see any of them.
  Moving the hashing onto the speaker needs a config change on the box.
- **The speaker's own folder and service names still say `lockerroom`**, as do
  the database and backup bucket. See the README for why.
- **The daily database backup runs inside the Worker** and may outgrow its time
  limit late in a season. Check Cloudflare → R2 → `lockerroom-backups` shows a
  new file each morning.
