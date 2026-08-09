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

### It gets its own Worker — `apex/`

**This reverses the original decision in this spec, and the reversal was forced
by production.** The first version kept the apex on the `locker-room-music`
Worker to avoid a second deploy target. That cannot work, for a reason worth
writing down because it is invisible until deployed:

**Cloudflare serves any asset matching the request path without invoking the
Worker at all.** The team Worker has an `[assets]` binding containing
`index.html`, so `/` was answered with the voting app and the apex middleware
never ran. Measured in production 2026-08-08, after the first deploy:

| request | result |
|---|---|
| `auxgoat.com/go?code=CRUSADERS` | 302 → `hc.auxgoat.com` ✅ |
| `auxgoat.com/api/now` | 404 ✅ |
| `auxgoat.com/songs` | 302 → `/` ✅ |
| **`auxgoat.com/`** | **the team app — Worker never invoked** ❌ |

Everything that did not collide with a filename worked. The one path that
mattered did not. The same is retroactively true of the 302 this replaced:
`auxgoat.com/` has *always* shown Holy Cross's app directly rather than
redirecting, and nobody noticed because the destination looked the same.

The only fix available on the shared Worker is `run_worker_first = true`, which
in wrangler 3.x is **all-or-nothing** — no path scoping. That would put a
Worker invocation in front of every JS, CSS and font request the team makes, on
the campus wifi this product already loses regularly, and would make a Worker
exception take the static assets down with it. It also requires rewriting the
catch-all to serve real assets before the app shell, or `/assets/index-*.js`
gets answered with HTML.

So the apex is its own Worker, `auxgoat-apex`, in `apex/`:

```
backend/   locker-room-music   hc.auxgoat.com, lockerroom.finestkindfarms.com
apex/      auxgoat-apex        auxgoat.com, www.auxgoat.com
```

This is better on every axis that was actually being weighed:

- **Multiple schools.** The front door stops living inside one school's Worker,
  so a bad `hc` deploy cannot take it down for everyone. This was always the
  end state; production just made it urgent.
- **Latency and bad wifi.** The team's hot path keeps being served straight
  from edge cache with no Worker invocation.
- **Blast radius.** The apex Worker has **no bindings at all** — no D1, no
  secrets, no cron, no R2. It cannot read a school's data because it has no
  handle to any.

**And it removes the interception problem instead of fighting it.** There is no
`index.html` in `apex/public/`, so `/` matches no asset, falls through to the
Worker naturally, and the page is rendered in code. No `run_worker_first`
anywhere. Do not add an `index.html` there — it would be served directly and
the `?e=` error state would silently stop working.

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

`apex/src/teams.ts`:

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

**It imports `normalizeTeamCode()` from `backend/src/crypto.ts`, across the
package boundary, rather than copying it.** STATE.md documents `CRUSADERS`
being rejected in production because one comparison path was byte-exact while
the UI implied case-insensitivity. A second copy here would reintroduce exactly
that bug, one layer earlier and worse: a player turned away at the front door
by the very site that would have accepted them.

Splitting the Workers made this a real decision rather than an import. The
trade taken is explicit — **duplication fails silently, a cross-package import
fails at build time.** `crypto.ts` has no imports of its own, so nothing else
is dragged along. If the apex is ever extracted to its own repository this
breaks loudly, which is the correct moment to promote the function to something
shared rather than the moment to copy it.

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
the field refilled.

Zero JS in the flow. The destination is a different origin, so there is a full
navigation either way — a client-side `fetch` would save nothing and adds a
failure mode on exactly the campus wifi that STATE.md keeps recording outages
on.

**`?e=` is reflected into a form value, so it must be HTML-escaped.** It is the
only user-controlled string on the page and the only injection surface it has.

### Rendered in the Worker, with the CSS inlined

`apex/src/page.ts` returns the HTML as a string. Not built by Vite, not a file
in an assets directory.

This is what makes `/` reach the Worker at all — see the interception problem
above — but it earns its place twice over:

- **One round trip instead of two.** Inlining the CSS costs about 1.2 kB
  gzipped and removes a request. On bad wifi that is the better trade, and it
  is the whole page: 
  the font is the only other fetch.
- **It deletes a class of bug.** The earlier build-time version used
  `__CODE__` / `__ERROR__` tokens that the Worker substituted, and shipped
  broken — see below. There is nothing to substitute now; the value is
  interpolated where it is used.

The font stays self-hosted and is the only static asset: `apex/public/fonts/`
holds the Outfit latin subset (32 kB), vendored into the repo rather than built
from `node_modules`, so the Worker deploys from a clean checkout with no build
step. It is served by Cloudflare directly and never touches the Worker.
`font-display: swap` means text paints immediately in a fallback rather than
hanging on 32 kB. It is never a Google Fonts CDN link — campus wifi is
unpredictable and the type is the identity.

The latin-ext subset is deliberately **not** shipped. The app needs it for
track titles; this page has a fixed English string and an uppercase code field.

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

31 tests in `apex/test/`, all pure, no wrangler and no deploy.

`teams.test.ts` (8) asserts `resolveTeam` accepts every casing and padding of
`CRUSADERS` and rejects `KNIGHTS`, `CRUSADER`, `CRUS ADERS`, empty, and the
`Object.prototype` collisions. It mirrors `backend/test/teamcode.test.ts`
deliberately: the front door and the join gate must never diverge.

`apex.test.ts` (23) drives the Worker's `fetch` directly. Beyond routing, three
assert properties of the design that would otherwise erode silently:

- the page contains no `<script` — the no-JS guarantee, pinned
- the CSS is inlined and no stylesheet is linked — the round trip, pinned
- the rejected code round-trips: `/go` encodes it into `Location`, `/` escapes
  it back into the field. The two halves are written in different places, so
  this is the test that they agree — `O'BRIEN & SONS` comes back as
  `O&#39;BRIEN &amp; SONS`.

### Host routing cannot be tested through `wrangler dev` — measured

The plan was to cover this in `test/e2e.sh` with an apex `Host` header. **That
does not work, and the probe is worth recording so nobody spends an afternoon
on it.**

`wrangler dev` reconstructs every request URL against its own bind address, so
the Worker always sees `localhost:8787`. Measured 2026-08-07 against the *old*
`auxgoat.com` → `hc.auxgoat.com` redirect, which demonstrably worked in
production and could not be made to fire locally by any means:

| attempt | result |
|---|---|
| `curl -H 'Host: auxgoat.com' localhost:8787` | 200, no redirect |
| `curl --resolve auxgoat.com:8787:127.0.0.1 http://auxgoat.com:8787/` | 200, no redirect |
| `curl --resolve hc.auxgoat.com…` (control) | 200, no redirect |

The answer is better than the deployed-preview fallback this spec originally
predicted: **call the Worker's `fetch` directly with an absolute URL.** No
wrangler, no deploy, milliseconds per case, and it covers the one thing e2e
could not.

Related, and confusing if met cold: `wrangler dev` also **rewrites `Location`
headers on the way out**, mapping a configured domain back to the local
address. `/go?code=crusaders` against `localhost:8788` returns
`https://hc.localhost:8788/`, and only with `-H 'Host: auxgoat.com'` does it
show the `https://hc.auxgoat.com/` the Worker actually produced. The Worker's
output is correct either way; the dev server is being helpful. The unit tests
assert the constant, so they are unaffected.

`backend/test/e2e.sh` is unchanged and still passes. It runs against
`localhost` and only ever exercises the team Worker, which is exactly the
regression surface that matters there: this change must be invisible to the
live school.

### Three bugs the tests did not catch on their own

All three are the same shape: **a fixture too clean to contain the hazard
cannot catch it.** All three were found by deploying or by looking.

**The Vite entry key silently disabled the stale-build reload.** Adding a
second Rollup input meant naming the first one, and calling it `main` renamed
the output to `main-<hash>.js`. `staleBuild.ts` finds the running and the
served build by matching `/assets/index-<hash>.js` — a selector and a regex,
*neither of which fails loudly*. The reload that stops a tab held across a
deploy from executing `index.html` as JavaScript would simply have stopped
happening. Moot now that the landing page is not built by Vite, but the
landmine is still there for the next second entry, so `vite.config.ts` carries
a comment.

**Server-side substitution replaced the documentation, not the markup.** The
built `landing.html` explained its own tokens in a comment above the form, so
the first occurrence of each was prose. `String.replace()` with a string
pattern replaces only the first match, so the Worker rewrote the comment and
served the live tokens raw — `__CODE__` sitting in the input box, behind 24
passing tests. Caught by looking at the rendered page. Now moot too: rendering
in code means there is nothing to substitute.

**And the one that forced the redesign: `/` never reached the Worker.** No test
could have caught it, because it is not a property of the code — the routing
logic was correct and unit-tested. It is a property of `[assets]`, and it only
exists in a deployed Worker. The tests were right; the architecture was wrong.

## Deployment notes

Two Workers now, and **the order matters once**. A custom domain belongs to
exactly one Worker, so the apex routes must be released by the team Worker
before the apex Worker can claim them:

```bash
# 1. Release auxgoat.com + www from the team Worker.
cd backend && npx wrangler deploy

# 2. Claim them on the apex Worker.
cd apex && npx wrangler deploy
```

Between those two steps `auxgoat.com` resolves to nothing. It is short, and it
is the only ordering that does not have both Workers claiming one hostname.
`hc.auxgoat.com` is unaffected throughout — no step here touches it.

`apex/wrangler.toml` sets `workers_dev = true`, so a deploy can be verified at
`auxgoat-apex.<subdomain>.workers.dev` **before** the custom domains are moved.
Worth doing: it turns the ordering above from a leap into a check.

Other things that bite:

- **The `cd` is not cosmetic.** From the repo root, wrangler finds no config,
  scaffolds a `wrangler.jsonc`, and creates a *second* Worker named after the
  directory while the real one keeps serving the old build. Done by accident on
  2026-08-05. With two Workers there are now two ways to get this wrong.
- **Wait ~2 minutes before verifying.** A deploy reporting success was measured
  still serving old code 80 seconds later.
- **`cd web && npm run build` before deploying the team Worker.**
  `backend/public/` is gitignored, so wrangler uploads whatever is on disk and
  a stale working tree ships a stale app with nothing in `git status` to hint
  at it. The apex Worker needs no build step at all — its only asset is a
  vendored font, committed.

## Out of scope

- Prefilling the code on the destination site via `?code=`. Nice, and cheap,
  but it puts a team code in browser history and a referrer; worth deciding on
  its own rather than as a rider here.
- Any second school. The map has one entry and that is honest.
- `/d/:serial`, device binding, and everything else in the provisioning design.
- A rate-limiting rule on `/go`. Required before this is advertised, but it is
  dashboard configuration rather than code — Security → WAF → Rate limiting,
  matching `hostname eq "auxgoat.com" and http.request.uri.path eq "/go"`.
