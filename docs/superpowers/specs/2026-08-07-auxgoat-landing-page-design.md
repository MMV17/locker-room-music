# auxgoat.com landing page — design

Date: 2026-08-07. Status: approved, not yet implemented.

Replaces the bare-domain 302 middleware in `backend/src/index.ts` with a real
landing page at the apex, plus a team-code router that sends a player to their
school's subdomain.

`wrangler.toml` already anticipates this. Its comment on the apex routes reads:
"When a second school exists, the apex must stop favouring Holy Cross: remove
these two routes and the middleware, and put a real landing page here." This is
that change, done before the second school rather than after.

## Why now, and what it is not

This is not a marketing site. It is a **router with a face**: the page someone
reaches when they heard "auxgoat.com" said out loud in a loud room and typed it
without the school in front of it. That was the exact case the 302 was written
for, and it stays the case being served — the 302 just stops being able to
answer it correctly the moment a second school exists.

Scope is deliberately one screen. No marketing copy, no pricing, no signup, no
"about". Those are a different project if they are ever a project at all.

## Architecture

### It stays on the same Worker

The apex is routed to the `locker-room-music` Worker, the same one serving
Holy Cross. That does not change here.

Splitting the apex onto its own Worker is the structurally correct end state —
it is the only way the front door stops depending on one school's deploy — but
not yet. STATE.md records a `wrangler deploy` from the repo root accidentally
creating a second Worker on 2026-08-05, and standing up a real second deploy
target for one static page invites that class of mistake for no benefit today.
The seam is one entry in `routes`; take it when school two is real.

**Consequence to accept knowingly:** until then, a bad hc deploy takes the
front door down with it.

### Route table at the apex

| Path | Behaviour |
|---|---|
| `/` | Serve `landing.html` |
| `/go?code=…` | Resolve, 302 to `https://<slug>.auxgoat.com/`, or bounce to `/?e=<typed>` |
| `/api/*` | **404** |
| anything else | 302 to `/` |

`www.auxgoat.com/*` 302s to the apex so there is a single canonical host.

**`/api/*` returning 404 at the apex is a correctness fix, not tidiness.**
Today the apex serves hc's entire API on a second hostname. Nothing crosses —
the session cookie is host-only, so a session on `auxgoat.com` and one on
`hc.auxgoat.com` are simply different sessions — but "one hostname per team"
should hold by construction. Two hostnames that both work is how a player ends
up signed in on the one nobody else is using, with no way to tell.

All redirects here are **302, never 301**, for the reason the existing
middleware comment gives: a 301 is cached by browsers effectively forever, so
any rule shipped by mistake outlives the ability to fix it from the server.

### `resolveTeam()`

New file, `backend/src/teams.ts`:

```ts
export interface Team { slug: string; name: string; }

const TEAMS: Record<string, Team> = {
  CRUSADERS: { slug: "hc", name: "Holy Cross" },
};

export async function resolveTeam(env: Env, code: string): Promise<Team | null> {
  return TEAMS[normalizeTeamCode(code)] ?? null;
}
```

Three decisions, each load-bearing:

**It is `async` and takes `env`, though it needs neither.** This is the entire
"swappable later" requirement. Replacing the body with a D1 query against a
`teams` table then touches this function and nothing else. A synchronous
signature would make that a change at every call site, which is the kind of
friction that keeps a placeholder in place for a year.

**It reuses `normalizeTeamCode()` from `crypto.ts`.** It does not do its own
trim-and-uppercase. STATE.md documents `CRUSADERS` being rejected in
production because one comparison path was byte-exact while the UI implied
case-insensitivity. A second normalizer here would reintroduce exactly that
bug, one layer earlier and worse: a player would be turned away at the front
door by the very site that would have accepted them.

**Internal whitespace still fails.** `normalizeTeamCode` preserves it
deliberately, so `CRUS ADERS` is not a match and the error stays honest.

### The team code is now brute-forceable, and that is a real cost

The apex answers "is this a valid team code?" to anyone who asks, at whatever
rate they ask. The team code is currently the **only** gate on a school's data
— signup is self-service, so anyone holding a valid code can register under any
name — and `CRUSADERS` is a guessable locker-room word.

Accepted for one school, with two mitigations:

1. A Cloudflare rate-limiting rule on `/go`.
2. The QR path below, which is the actual fix and makes the code box a
   fallback rather than the main road.

This is written down rather than assumed because the exposure is new. The 302
it replaces validated nothing and so leaked nothing.

### The QR path — designed for, not built

The intended primary onboarding is a QR code on the physical box. Scanning it
lands a player directly on their team's subdomain; they enter the team code
*there*, against the school's own Worker, where a wrong code has always been
rejected and no cross-team oracle exists.

**The QR is printed at manufacture and encodes a device serial, not a team.**

```
QR (fixed, printed once)   ->  auxgoat.com/d/A7F3K2
Worker resolves A7F3K2     ->  302 https://hc.auxgoat.com/
```

A team-specific printed QR would mean every unit has to be manufactured for a
school that already exists — no stock inventory, no resale, no re-binding when
a box changes hands. A device serial is anonymous at manufacture and the
binding lives on the server, so the same printed sticker is correct for the
life of the hardware.

It also gives project 2 its entry point for free: **an unbound serial means
"this box has not been set up yet"**, which is the first screen of the
provisioning flow.

Implications for this project, all of which are shape rather than code:

- `teams.ts` is the module for *both* resolvers. `resolveDevice(env, serial)`
  joins `resolveTeam` there when it is built, with the same async signature.
- The apex route table gains `/d/:serial` and nothing else moves.
- The code box on the landing page is designed as a **fallback**, not the hero.
  When QR becomes the main path, shrinking or removing the box is a content
  change, not a rearchitecture.

Not built now. Recorded so the shape does not have to be undone.

## The page

### No JavaScript

The form submits to `/go` with a GET. The Worker resolves and 302s. An
unrecognised code bounces to `/?e=<typed>`, and the page renders the error with
the field refilled from the query string.

Zero JS in the flow. The destination is a different origin, so there is a full
navigation either way — a client-side `fetch` would save nothing and adds a
failure mode on exactly the campus wifi that STATE.md keeps recording outages
on. Enhancement later is unblocked by this design; it is simply not worth doing
first.

**`?e=` is reflected into a form value, so it must be HTML-escaped.** It is the
only user-controlled string on the page and the only injection surface it has.

### It must be a Vite entry, not a hand-placed file

`web/landing.html` becomes a second Rollup input alongside `index.html`,
building to `backend/public/landing.html`.

Dropping a hand-written HTML file into `backend/public/` **does not work and
fails late**: `vite.config.ts` sets `emptyOutDir: true`, so the next
`cd web && npm run build` deletes it. The landing page would vanish during
unrelated frontend work, with nothing connecting cause to effect.

The Vite entry also picks up the self-hosted Outfit subset. The type is the
identity and it is never loaded from a CDN — campus wifi is unpredictable and a
Google Fonts link is a dependency on a third party for the one thing that
carries the brand.

### Visual direction

Neutral, and expected to be adjusted later. Tokens come from the existing
`styles.css` set: `--page: #edf0f5`, white surfaces, `--ink: #14171c`, Outfit
Variable, generous whitespace.

**No logo.** The wordmark is set in large Outfit and carries the page alone.

The AuxGoat artwork is cream and gold on solid black, with 87% of the image
being that black field. STATE.md records it being tried in the app header and
rejected by Mack; a dark hero tile was built for it, worked, and was still not
wanted. Setting the wordmark in type sidesteps the artwork entirely and is the
most obviously neutral-and-adjustable option — which is what was asked for.

There is no team colour at the apex, because there is no team. The page uses no
accent at all rather than falling back to the neutral slate default — accent
belongs to a school and the front door does not have one. The submit button is
therefore filled with `--ink` (`#14171c`) rather than `--team`, which is the
one place the absence of an accent has to be answered rather than just noted.

Content, in order, and that is all of it. Copy is written here so it is a
decision rather than an exercise left to implementation; it is cheap to change:

1. **AUXGOAT**, wordmark, large.
2. "Vote on what's playing in your locker room."
3. Team code field, label "Team code".
4. Submit button, "Go".
5. Error slot, occupied only after a failed `/go`.
6. "Don't have a code? Ask whoever set up your team's speaker."

### States

| State | Behaviour |
|---|---|
| Empty field | Button disabled |
| Unrecognised code | "We don't recognise that code." in place; field keeps what was typed; no navigation |
| Recognised code | 302 to `https://<slug>.auxgoat.com/` |

Disabled uses the existing `.btn:disabled` treatment — brand colour dropped
entirely for `--hairline`/`--muted`, no shadow, `not-allowed`. STATE.md records
that `opacity: 0.5` alone left a disabled button still reading as confidently
tappable, and tapping it did nothing with no feedback.

The field keeps `text-transform: uppercase` and `autoCapitalize="characters"`
to match the Join screen, and the input stays at 16px or larger: iOS zooms any
smaller input on focus and does not zoom back out.

## Testing

Unit, in `backend/test/`:

- `resolveTeam` accepts every casing and padding of `CRUSADERS`; rejects
  `KNIGHTS`, `CRUSADER`, `CRUS ADERS`, and empty. This mirrors
  `teamcode.test.ts` on purpose — the two normalizers must never diverge.

End-to-end, added to `test/e2e.sh`, all with an apex `Host` header.

**Verify host-based routing works under `wrangler dev --local` before writing
these.** The middleware branches on `new URL(c.req.url).hostname`, and that URL
is reconstructed by the runtime from the request's `Host` header — so
`curl -H 'Host: auxgoat.com' localhost:8787` should present as `auxgoat.com`.
If it does not, these cases cannot run locally and have to move to a deployed
preview, which is slow enough to change how the work is sequenced. Check it
first with a one-line probe rather than discovering it after writing six tests.

- `GET /` serves the landing page, not the app shell.
- `GET /go?code=crusaders` → 302 to `https://hc.auxgoat.com/`.
- `GET /go?code=nope` → 302 to `/?e=nope`.
- `GET /api/now` → 404, **not** 401. A 401 would mean the API is still mounted.
- `GET /whatever` → 302 to `/`.
- Same requests with an `hc.auxgoat.com` Host header behave as they do today —
  this change must be invisible to the live school.

Manual, once: the reflected `?e=` value is escaped. Submit `"><script>` and
confirm it renders as text in the field.

## Deployment notes

- Deploy with `cd backend && npx wrangler deploy`. The `cd` is not cosmetic:
  from the repo root, wrangler finds no config, scaffolds a `wrangler.jsonc`,
  and creates a *second* Worker named after the directory, leaving the real one
  serving the old build. Done by accident on 2026-08-05.
- Wait ~2 minutes before verifying. A deploy reporting success was measured
  still serving old code 80 seconds later. A verification run immediately after
  a deploy tests the previous Worker.
- `web/` must be rebuilt and committed before the Worker deploy, since the
  Worker serves `backend/public/` from its `[assets]` binding.

## Out of scope

- Prefilling the code on the destination site via `?code=`. Nice, and cheap,
  but it puts a team code in browser history and a referrer; worth deciding on
  its own rather than as a rider here.
- Any second school. The map has one entry and that is honest.
- `/d/:serial`, device binding, and everything else in the provisioning design.
- Splitting the apex onto its own Worker.
