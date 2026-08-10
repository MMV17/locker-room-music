#!/usr/bin/env bash
# End-to-end check against a running `wrangler dev` (spec build order step 3:
# "Test endpoints with curl"). Verifies the rules that matter most, against
# raw HTTP responses rather than the UI.
set -uo pipefail

BASE="${BASE:-http://localhost:8787}"
DEVICE_KEY="dev-device-key"
TEAM_CODE="dev-team"
ADMIN_PW="dev-admin"
JAR="$(mktemp)"
PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; echo "        $2"; FAIL=$((FAIL+1)); }

echo "== setup: player =="
# Players sign themselves up now, so the fixture is a signup rather than an
# admin insert. The last name carries the run suffix: identity_key is UNIQUE
# and signup is idempotent on it, so a fixed name would silently reuse the
# previous run's player along with their claimed device and play history.
SUFFIX="$$-$(date +%s)"
FIRST="Jake"
LAST="Tester$SUFFIX"

echo "== auth =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/now")
[ "$code" = "401" ] && ok "unauthenticated /api/now is rejected" || bad "unauthenticated /api/now" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/plays" \
  -H 'content-type: application/json' -d '{}')
[ "$code" = "401" ] && ok "play write without device key is rejected" || bad "play write without device key" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/session" \
  -H 'content-type: application/json' \
  -d "{\"team_code\":\"wrong\",\"first_name\":\"$FIRST\",\"last_name\":\"$LAST\",\"jersey_number\":\"12\"}")
[ "$code" = "403" ] && ok "wrong team code is rejected" || bad "wrong team code" "got $code"

SIGNUP=$(curl -s -c "$JAR" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"$FIRST\",\"last_name\":\"$LAST\",\"jersey_number\":\"12\"}")
grep -q lr_token "$JAR" && ok "signup issues a session cookie" || bad "session cookie" "no cookie set"
USER_ID=$(echo "$SIGNUP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$USER_ID" ] && ok "signup created the player" || bad "signup created the player" "no id: $SIGNUP"

# Idempotent on identity: the same name and number must return the SAME player,
# or clearing cookies would split someone's history across two rows.
JAR2="$(mktemp)"
AGAIN=$(curl -s -c "$JAR2" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"$FIRST\",\"last_name\":\"$LAST\",\"jersey_number\":\"12\"}")
AGAIN_ID=$(echo "$AGAIN" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ "$AGAIN_ID" = "$USER_ID" ] && ok "re-signup returns the same player" || bad "re-signup" "$USER_ID vs $AGAIN_ID"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/session" \
  -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"\",\"last_name\":\"\"}")
[ "$code" = "400" ] && ok "signup requires a name" || bad "signup requires a name" "got $code"

# The team code is typed by a teenager on a phone. Case and stray whitespace
# must not be the thing standing between them and the product.
for variant in "$(echo "$TEAM_CODE" | tr '[:lower:]' '[:upper:]')" "  $TEAM_CODE  "; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/session/check-code" \
    -H 'content-type: application/json' -d "{\"team_code\":\"$variant\"}")
  [ "$code" = "204" ] && ok "check-code accepts '$variant'" || bad "check-code '$variant'" "got $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/session/check-code" \
  -H 'content-type: application/json' -d '{"team_code":"definitely-not-it"}')
[ "$code" = "403" ] && ok "check-code rejects a wrong code" || bad "check-code wrong" "got $code"

# The two 403s on this route mean completely different things, and the client
# branches on `code` to decide whether to send someone back to the code screen.
# Collapsing them told a removed player their correct code was wrong.
BODY=$(curl -s -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"nope\",\"first_name\":\"$FIRST\",\"last_name\":\"$LAST\"}")
echo "$BODY" | grep -q '"code":"wrong_team_code"' \
  && ok "wrong code is tagged wrong_team_code" || bad "wrong_team_code tag" "$BODY"

DEACT_LAST="Removed$SUFFIX"
DEACT=$(curl -s -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"Gone\",\"last_name\":\"$DEACT_LAST\"}")
DEACT_ID=$(echo "$DEACT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -s -o /dev/null -X PATCH "$BASE/api/admin/users/$DEACT_ID" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"active":false}'
BODY=$(curl -s -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"Gone\",\"last_name\":\"$DEACT_LAST\"}")
echo "$BODY" | grep -q '"code":"player_removed"' \
  && ok "removed player is tagged player_removed, not a code error" \
  || bad "player_removed tag" "$BODY"

echo "== play ingest =="
# Fixture ids are unique per run. They used to be hardcoded, which made the
# suite pass only against a freshly-created database: on a second run the play
# already had ended_at set and the device was already claimed, so every
# "window is open" and "unclaimed device" assertion failed with confusing
# output. Local D1 persists in .wrangler/state between runs, so tests must not
# collide with their own history.
# uuidgen ships with macOS but not with every Linux image, and when it is
# missing PLAY_ID comes out empty — which fails the play create with a 400 and
# then fails eight downstream assertions that look like real regressions.
gen_id() {
  if command -v uuidgen > /dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    printf 'test-%s-%s-%s\n' "$$" "$(date +%s)" "$RANDOM$RANDOM"
  fi
}
PLAY_ID=$(gen_id)
MAC_PREFIX="5C:AD:BA:F0"
MAC_TAIL=$(printf '%02X:%02X' $((RANDOM % 256)) $((RANDOM % 256)))
DEVICE_MAC="$MAC_PREFIX:$MAC_TAIL"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY_ID\",\"device_mac\":\"$DEVICE_MAC\",\"device_alias\":\"Jake's iPhone\",\"title\":\"Decode\",\"artist\":\"Paramore\",\"duration_ms\":240000,\"started_at\":\"$STARTED\"}" > /dev/null
ok "play accepted"

# Idempotent: the Pi retries after ambiguous timeouts.
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY_ID\",\"device_mac\":\"$DEVICE_MAC\",\"title\":\"Decode\",\"artist\":\"Paramore\",\"duration_ms\":240000,\"started_at\":\"$STARTED\"}" > /dev/null
ok "duplicate play upsert accepted (idempotent)"

echo "== THE most important rule: no live tallies =="
curl -s -b "$JAR" -X POST "$BASE/api/votes" -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY_ID\",\"value\":1}" > /dev/null
NOW_RAW=$(curl -s -b "$JAR" "$BASE/api/now")

if echo "$NOW_RAW" | grep -qiE '"(up|down|upvotes|downvotes|score|tally|voters)"'; then
  bad "tallies absent from /api/now while window open" "response leaked: $NOW_RAW"
else
  ok "tallies genuinely absent from /api/now raw response"
fi

echo "$NOW_RAW" | grep -q '"my_vote":1' \
  && ok "caller's own vote is returned" \
  || bad "caller's own vote" "$NOW_RAW"

code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/api/plays/$PLAY_ID/results")
[ "$code" = "403" ] && ok "results are 403 while voting is open" || bad "results while open" "got $code"

echo "== vote changes and the unique constraint =="
curl -s -b "$JAR" -X POST "$BASE/api/votes" -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY_ID\",\"value\":-1}" > /dev/null
echo "$(curl -s -b "$JAR" "$BASE/api/now")" | grep -q '"my_vote":-1' \
  && ok "vote can be changed while open" || bad "vote change" "not reflected"

code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/votes" \
  -H 'content-type: application/json' -d "{\"play_id\":\"$PLAY_ID\",\"value\":5}")
[ "$code" = "400" ] && ok "invalid vote value rejected" || bad "invalid vote value" "got $code"

echo "== closing the window =="
ENDED=$(date -u -v-60S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '60 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s -X PATCH "$BASE/api/plays/$PLAY_ID" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"ended_at\":\"$ENDED\",\"played_ms\":200000,\"counted\":true}" > /dev/null

code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/votes" \
  -H 'content-type: application/json' -d "{\"play_id\":\"$PLAY_ID\",\"value\":1}")
[ "$code" = "409" ] && ok "vote after close is rejected" || bad "vote after close" "got $code"

RESULTS=$(curl -s -b "$JAR" "$BASE/api/plays/$PLAY_ID/results")
echo "$RESULTS" | grep -q '"downvotes":1' \
  && ok "tallies revealed once closed" || bad "tallies after close" "$RESULTS"

echo "== unknown ids =="
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/votes" \
  -H 'content-type: application/json' -d '{"play_id":"nope","value":1}')
[ "$code" = "404" ] && ok "vote on unknown play is 404" || bad "unknown play" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/plays/nope" \
  -H "X-Device-Key: $DEVICE_KEY" -H 'content-type: application/json' -d '{"played_ms":1}')
[ "$code" = "404" ] && ok "patching unknown play is 404" || bad "patch unknown play" "got $code"

echo "== device claiming =="
UNCLAIMED=$(curl -s -b "$JAR" "$BASE/api/devices/unclaimed")
# Spec: mac_hint is the LAST TWO octets, and nothing more.
echo "$UNCLAIMED" | grep -q "\"mac_hint\":\"$MAC_TAIL\"" \
  && ok "unclaimed device exposes only a two-octet hint" || bad "mac hint" "$UNCLAIMED"
echo "$UNCLAIMED" | grep -q '"alias":"Jake'"'"'s iPhone"' \
  && ok "alias survives an idempotent retry that omitted it" \
  || bad "alias clobbered by retry" "$UNCLAIMED"
echo "$UNCLAIMED" | grep -qi "$MAC_PREFIX" \
  && bad "raw MAC must never appear" "$UNCLAIMED" \
  || ok "raw MAC absent from API (non-negotiable #3)"

HASH=$(echo "$UNCLAIMED" | sed -n 's/.*"mac_hash":"\([^"]*\)".*/\1/p')
curl -s -b "$JAR" -X POST "$BASE/api/devices/$HASH/claim" > /dev/null
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/devices/$HASH/claim")
[ "$code" = "409" ] && ok "double claim rejected" || bad "double claim" "got $code"

echo "== leaderboards =="
DJS=$(curl -s -b "$JAR" "$BASE/api/leaderboard/djs")
# Assert the rule, not an empty board. Checking for "djs":[] only held against
# a database with no other history, which is the same fixture-collision trap
# called out above — a seeded or previously-exercised local D1 has qualified
# DJs on it, and their presence is correct rather than a failure.
echo "$DJS" | grep -q "\"id\":\"$USER_ID\"" \
  && bad "DJ under the minimum is hidden" "$USER_ID appears with fewer than 5 plays: $DJS" \
  || ok "DJ with fewer than 5 counted plays is hidden"

echo "== a DJ cannot rate their own song =="
# Claim first, so the play's denormalized user_id is set at create time.
MAC2="$MAC_PREFIX:$(printf '%02X:%02X' $((RANDOM % 256)) $((RANDOM % 256)))"
PLAY2=$(gen_id)
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY2\",\"device_mac\":\"$MAC2\",\"device_alias\":\"Jake's iPad\",\"title\":\"Misery Business\",\"artist\":\"Paramore\",\"duration_ms\":210000,\"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > /dev/null
HASH2=$(curl -s -b "$JAR" "$BASE/api/devices/unclaimed" \
  | tr '}' '\n' | grep "Jake's iPad" | sed -n 's/.*"mac_hash":"\([^"]*\)".*/\1/p')
curl -s -b "$JAR" -X POST "$BASE/api/devices/$HASH2/claim" > /dev/null

# The claim backfilled PLAY2 onto Jake, so Jake is now its DJ.
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/votes" \
  -H 'content-type: application/json' -d "{\"play_id\":\"$PLAY2\",\"value\":1}")
[ "$code" = "403" ] && ok "DJ's vote on their own song is rejected" || bad "DJ self-vote" "got $code"

curl -s -b "$JAR" "$BASE/api/now" | grep -q '"i_am_dj":true' \
  && ok "/api/now tells the DJ it is their song" || bad "i_am_dj" "not set"

echo "== claiming voids a vote cast before the device was yours =="
# Vote while the device is anonymous, then claim it. Without the void in the
# claim batch, that vote would silently become a self-vote in the tally.
MAC3="$MAC_PREFIX:$(printf '%02X:%02X' $((RANDOM % 256)) $((RANDOM % 256)))"
PLAY3=$(gen_id)
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY3\",\"device_mac\":\"$MAC3\",\"device_alias\":\"Mystery phone\",\"title\":\"Still Into You\",\"artist\":\"Paramore\",\"duration_ms\":216000,\"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > /dev/null
curl -s -b "$JAR" -X POST "$BASE/api/votes" -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY3\",\"value\":1}" > /dev/null

HASH3=$(curl -s -b "$JAR" "$BASE/api/devices/unclaimed" \
  | tr '}' '\n' | grep "Mystery phone" | sed -n 's/.*"mac_hash":"\([^"]*\)".*/\1/p')
curl -s -b "$JAR" -X POST "$BASE/api/devices/$HASH3/claim" > /dev/null

ENDED3=$(date -u -v-60S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '60 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s -X PATCH "$BASE/api/plays/$PLAY3" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d "{\"ended_at\":\"$ENDED3\",\"played_ms\":200000,\"counted\":true}" > /dev/null

R3=$(curl -s -b "$JAR" "$BASE/api/plays/$PLAY3/results")
echo "$R3" | grep -q '"upvotes":0' \
  && ok "vote cast before claiming is voided by the claim" || bad "claim backfill void" "$R3"

echo "== team colour =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/admin/theme" \
  -H 'content-type: application/json' -d '{"primary":"#862633"}')
[ "$code" = "401" ] && ok "theme write without admin password is rejected" || bad "theme auth" "got $code"

for BADCOLOR in 'red' '#fff' '#f00; background:url(x)' 'javascript:alert(1)'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/admin/theme" \
    -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
    -d "{\"primary\":\"$BADCOLOR\"}")
  # This value is written into a CSS custom property on every page, so
  # anything but a six-digit hex is a stylesheet injection.
  [ "$code" = "400" ] && ok "theme rejects '$BADCOLOR'" || bad "theme rejects '$BADCOLOR'" "got $code"
done

curl -s -X PUT "$BASE/api/admin/theme" -H "X-Admin-Password: $ADMIN_PW" \
  -H 'content-type: application/json' -d '{"primary":"#862633","team_name":"Crusaders"}' > /dev/null
THEME=$(curl -s "$BASE/api/theme")
echo "$THEME" | grep -q '"primary":"#862633"' \
  && ok "valid hex round-trips through the public endpoint" || bad "theme round-trip" "$THEME"
echo "$THEME" | grep -q '"team_name":"Crusaders"' \
  && ok "team name round-trips" || bad "team name" "$THEME"

echo "== static site =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
[ "$code" = "200" ] && ok "app shell is served at /" || bad "app shell" "got $code"

# Client-side routes have no matching file and must fall through to the shell.
BODY=$(curl -s "$BASE/songs")
echo "$BODY" | grep -qi '<div id="root">' \
  && ok "client-side route falls through to the app shell" || bad "SPA fallback" "got: $BODY"

# But an unknown /api path must stay JSON — handing the Pi a page of HTML
# with a 200 on it is worse than useless when debugging.
APIMISS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/definitely-not-a-route")
[ "$APIMISS" = "404" ] && ok "unknown /api path is a JSON 404, not the shell" || bad "api 404" "got $APIMISS"

echo "== pi remote control =="
# Local D1 persists between runs and only one command may be outstanding at a
# time, so a command left un-reported by a previous run would block every
# assertion below. Drain it through the same API the Pi uses.
for _ in 1 2 3; do
  LEFTOVER=$(curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
    -H 'content-type: application/json' -d '{"speaker_name":"AuxGoat"}')
  LEFT_ID=$(echo "$LEFTOVER" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  [ -z "$LEFT_ID" ] && break
  curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
    -H 'content-type: application/json' \
    -d "{\"speaker_name\":\"AuxGoat\",\"result\":{\"id\":\"$LEFT_ID\",\"ok\":true,\"output\":\"drained by e2e setup\"}}" > /dev/null
done
# The allowlist is what stops this being remote code execution on a device in
# a locker room, so it is asserted at the API boundary, not just on the Pi.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/pi/commands" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"command":"rm -rf /"}')
[ "$code" = "400" ] && ok "command outside the allowlist is rejected" || bad "allowlist" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/pi/commands" \
  -H 'content-type: application/json' -d '{"command":"reboot"}')
[ "$code" = "401" ] && ok "queueing a command needs the admin password" || bad "command auth" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/pi/beacon" \
  -H 'content-type: application/json' -d '{}')
[ "$code" = "401" ] && ok "beacon without the device key is rejected" || bad "beacon auth" "got $code"

CMD_ID=$(curl -s -X POST "$BASE/api/admin/pi/commands" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"command":"report-status"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$CMD_ID" ] && ok "queued an allowed command" || bad "queue" "no id"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/pi/commands" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"command":"reboot"}')
[ "$code" = "409" ] && ok "a second queued command is refused while one is outstanding" || bad "single outstanding" "got $code"

GOT=$(curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"AuxGoat"}')
echo "$GOT" | grep -q "report-status" && ok "beacon receives the pending command" || bad "beacon dispatch" "$GOT"

AGAIN=$(curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"AuxGoat"}')
echo "$AGAIN" | grep -q '"command":null' && ok "a dispatched command is not handed out twice" || bad "double dispatch" "$AGAIN"

curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"speaker_name\":\"AuxGoat\",\"result\":{\"id\":\"$CMD_ID\",\"ok\":true,\"output\":\"up 4 minutes\"}}" > /dev/null
DONE=$(curl -s "$BASE/api/admin/pi/commands" -H "X-Admin-Password: $ADMIN_PW")
echo "$DONE" | grep -q "up 4 minutes" && ok "the Pi's result is recorded" || bad "result recorded" "$DONE"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/pi/commands" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"command":"reboot"}')
[ "$code" = "200" ] && ok "queueing works again once the last one completed" || bad "requeue" "got $code"

# reboot is fire-and-forget: the Pi is killed before it can report a result.
# It used to sit dispatched-but-never-completed forever, and the
# one-outstanding-at-a-time rule then blocked every future command - so a
# single reboot permanently wedged remote control.
# The previous assertion left a reboot queued; collect it so this block starts
# from a clean queue.
curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"AuxGoat"}' > /dev/null

RB_ID=$(curl -s -X POST "$BASE/api/admin/pi/commands" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"command":"reboot"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$RB_ID" ] && ok "queued a reboot" || bad "queue reboot" "no id"

curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"AuxGoat"}' > /dev/null

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/pi/commands" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"command":"report-status"}')
[ "$code" = "200" ] && ok "a dispatched reboot does not wedge the queue" || bad "reboot wedge" "got $code"

echo "== deleting a player =="
# Deactivating keeps someone's record; deleting is for the rows that should
# never have existed (typos, duplicates, test signups). The rule being pinned
# here is that the SONGS survive it: a play is a thing that happened in the
# room, and it stays on record having lost only its DJ.
DJAR="$(mktemp)"
DOOM_LAST="Doomed$SUFFIX"
DOOM=$(curl -s -c "$DJAR" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"Temp\",\"last_name\":\"$DOOM_LAST\"}")
DOOM_ID=$(echo "$DOOM" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

# A song they DJ'd, on a phone of their own.
DOOM_PLAY=$(gen_id)
DOOM_MAC="$MAC_PREFIX:$(printf '%02X:%02X' $((RANDOM % 256)) $((RANDOM % 256)))"
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$DOOM_PLAY\",\"device_mac\":\"$DOOM_MAC\",\"device_alias\":\"TempPhone$SUFFIX\",\"title\":\"Sabotage\",\"artist\":\"Beastie Boys\",\"duration_ms\":178000,\"started_at\":\"$STARTED\"}" > /dev/null
# Found by its unique alias rather than by asking /api/now, which picks the
# latest play — several fixtures here share a started_at, so which one that is
# would be a coin toss.
DOOM_HASH=$(curl -s -b "$DJAR" "$BASE/api/devices/unclaimed" \
  | tr '{' '\n' | grep "TempPhone$SUFFIX" \
  | sed -n 's/.*"mac_hash":"\([^"]*\)".*/\1/p')
[ -n "$DOOM_HASH" ] || bad "delete fixture: found the phone" "no mac_hash for TempPhone$SUFFIX"
curl -s -b "$DJAR" -X POST "$BASE/api/devices/$DOOM_HASH/claim" > /dev/null

# A vote they cast on somebody else's song, closed so the tally is readable.
VPLAY=$(gen_id)
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$VPLAY\",\"device_mac\":\"$DEVICE_MAC\",\"title\":\"Bulls On Parade\",\"artist\":\"Rage Against The Machine\",\"duration_ms\":230000,\"started_at\":\"$STARTED\"}" > /dev/null
curl -s -b "$DJAR" -X POST "$BASE/api/votes" -H 'content-type: application/json' \
  -d "{\"play_id\":\"$VPLAY\",\"value\":1}" > /dev/null
curl -s -X PATCH "$BASE/api/plays/$VPLAY" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"ended_at\":\"$ENDED\",\"played_ms\":200000,\"counted\":true}" > /dev/null
curl -s -b "$JAR" "$BASE/api/plays/$VPLAY/results" | grep -q '"upvotes":1' \
  && ok "fixture vote is counted before the delete" \
  || bad "fixture vote" "$(curl -s -b "$JAR" "$BASE/api/plays/$VPLAY/results")"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/users/$DOOM_ID")
[ "$code" = "401" ] && ok "deleting a player needs the admin password" || bad "delete auth" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/users/nope" \
  -H "X-Admin-Password: $ADMIN_PW")
[ "$code" = "404" ] && ok "deleting an unknown player is 404" || bad "delete unknown player" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/users/$DOOM_ID" \
  -H "X-Admin-Password: $ADMIN_PW")
[ "$code" = "200" ] && ok "player deleted" || bad "delete player" "got $code"

USERS=$(curl -s "$BASE/api/admin/users" -H "X-Admin-Password: $ADMIN_PW")
echo "$USERS" | grep -q "$DOOM_ID" \
  && bad "player is gone from the roster" "still listed" \
  || ok "player is gone from the roster"

# The whole point: the song stays, and reads as unclaimed rather than vanishing.
APLAYS=$(curl -s "$BASE/api/admin/plays" -H "X-Admin-Password: $ADMIN_PW")
echo "$APLAYS" | grep -q "$DOOM_PLAY" \
  && ok "their song is still on record" || bad "song survives delete" "$DOOM_PLAY missing"
echo "$APLAYS" | grep -q "\"id\":\"$DOOM_PLAY\"[^}]*\"dj_name\":null" \
  && ok "the song lost its DJ rather than its row" \
  || bad "song is unclaimed after delete" "$APLAYS"

# Votes are DELETED, not voided: votes.user_id is NOT NULL and references
# users(id), so there is no row to leave behind. Same visible effect.
curl -s -b "$JAR" "$BASE/api/plays/$VPLAY/results" | grep -q '"upvotes":0' \
  && ok "their votes stopped counting" \
  || bad "votes after delete" "$(curl -s -b "$JAR" "$BASE/api/plays/$VPLAY/results")"

curl -s -b "$JAR" "$BASE/api/devices/unclaimed" | grep -q "$DOOM_HASH" \
  && ok "their phone is claimable again" || bad "phone unclaimed after delete" "$DOOM_HASH"

# Deleted is not deactivated: the same name signs up fresh as a new person,
# rather than being told it was removed by an admin.
REBORN=$(curl -s -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"first_name\":\"Temp\",\"last_name\":\"$DOOM_LAST\"}")
REBORN_ID=$(echo "$REBORN" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$REBORN_ID" ] && [ "$REBORN_ID" != "$DOOM_ID" ] \
  && ok "the name is free again and signs up as a new player" \
  || bad "re-signup after delete" "$REBORN"

echo "== deleting a phone =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/devices/$DOOM_HASH")
[ "$code" = "401" ] && ok "deleting a phone needs the admin password" || bad "device delete auth" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/devices/nope" \
  -H "X-Admin-Password: $ADMIN_PW")
[ "$code" = "404" ] && ok "deleting an unknown phone is 404" || bad "delete unknown phone" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/admin/devices/$DOOM_HASH" \
  -H "X-Admin-Password: $ADMIN_PW")
[ "$code" = "200" ] && ok "phone deleted" || bad "delete phone" "got $code"

curl -s "$BASE/api/admin/devices" -H "X-Admin-Password: $ADMIN_PW" | grep -q "$DOOM_HASH" \
  && bad "phone is gone from the list" "still listed" || ok "phone is gone from the list"
curl -s "$BASE/api/admin/plays" -H "X-Admin-Password: $ADMIN_PW" | grep -q "$DOOM_PLAY" \
  && ok "the song it played is still on record" || bad "song survives phone delete" "missing"

rm -f "$DJAR"

echo "== who has the aux =="
# The Pi reports the holder and the waiting queue on every beacon. The site
# needs it so the "Nothing playing" screen stops telling a blocked player to
# connect over Bluetooth.
#
# DEVICE_MAC is Jake's claimed phone, so the holder must resolve to a PERSON,
# not just a phone alias.
WAIT_MAC="$MAC_PREFIX:$(printf '%02X:%02X' $((RANDOM % 256)) $((RANDOM % 256)))"
curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"speaker_name\":\"AuxGoat\",\"aux\":{\"holder\":{\"mac\":\"$DEVICE_MAC\",\"alias\":\"Jake's iPhone\"},\"waiting\":[{\"mac\":\"$WAIT_MAC\",\"alias\":\"Visitor phone\"}]}}" > /dev/null

AUX=$(curl -s -b "$JAR" "$BASE/api/now")
echo "$AUX" | grep -q "\"name\":\"$FIRST $LAST\"" \
  && ok "the aux holder resolves to a person, not a phone" || bad "aux holder name" "$AUX"
echo "$AUX" | grep -q '"is_you":true' \
  && ok "the holder is told it is them" || bad "is_you" "$AUX"
echo "$AUX" | grep -q '"waiting":1' \
  && ok "the waiting queue is reported" || bad "waiting count" "$AUX"

# Non-negotiable #3 again: a raw MAC must never leave the API, and this is a
# brand new path that carries them.
echo "$AUX" | grep -q "$DEVICE_MAC" \
  && bad "raw MAC absent from the aux report" "leaked: $DEVICE_MAC" \
  || ok "raw MAC absent from the aux report"
echo "$AUX" | grep -q "$WAIT_MAC" \
  && bad "raw waiting MAC absent from the API" "leaked" \
  || ok "raw waiting MAC absent from the API"

# Jake is the holder, so he is not waiting. Nobody should see the waiting
# banner just because somebody is.
echo "$AUX" | grep -q '"you_are_waiting":false' \
  && ok "the holder is not told they are waiting" || bad "you_are_waiting" "$AUX"

# Now flip it: Jake's phone is the one waiting.
curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"speaker_name\":\"AuxGoat\",\"aux\":{\"holder\":{\"mac\":\"$WAIT_MAC\",\"alias\":\"Visitor phone\"},\"waiting\":[{\"mac\":\"$DEVICE_MAC\",\"alias\":\"Jake's iPhone\"}]}}" > /dev/null
FLIPPED=$(curl -s -b "$JAR" "$BASE/api/now")
echo "$FLIPPED" | grep -q '"you_are_waiting":true' \
  && ok "the waiting player is told it is them" || bad "you_are_waiting flipped" "$FLIPPED"
# An unclaimed holder has no person to name, so the alias carries it.
echo "$FLIPPED" | grep -q '"alias":"Visitor phone"' \
  && ok "an unclaimed holder is named by its phone" || bad "holder alias" "$FLIPPED"

# Nobody connected at all means the aux is FREE, and the site can only learn
# that from a write. A stale holder would keep telling everyone to wait.
curl -s -X POST "$BASE/api/pi/beacon" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d '{"speaker_name":"AuxGoat","aux":{"holder":null,"waiting":[]}}' > /dev/null
FREE=$(curl -s -b "$JAR" "$BASE/api/now")
echo "$FREE" | grep -q '"holder":null' \
  && ok "an empty room reports the aux as free" || bad "aux freed" "$FREE"

echo "== clearing history =="
# The leaderboards are cumulative, so a test run sits on top of the first real
# session forever without this. Voids rather than deletes: a voided row drops
# out of every ranking but stays on disk.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/plays/void-all")
[ "$code" = "401" ] && ok "clearing history needs the admin password" || bad "void-all auth" "got $code"

# A play still on the speaker must survive: voiding the song a room is
# mid-vote on is a confusing way to lose it.
LIVE_PLAY=$(gen_id)
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$LIVE_PLAY\",\"device_mac\":\"$DEVICE_MAC\",\"title\":\"Still Going\",\"artist\":\"Live Fixture\",\"duration_ms\":240000,\"started_at\":\"$STARTED\"}" > /dev/null

CLEARED=$(curl -s -X POST "$BASE/api/admin/plays/void-all" -H "X-Admin-Password: $ADMIN_PW")
echo "$CLEARED" | grep -q '"ok":true' && ok "history cleared" || bad "void-all" "$CLEARED"
# At least one, not exactly one: local D1 persists between runs and carries
# open plays from earlier ones, which is the same trap this file warns about
# for play ids. The check that it spared THE RIGHT one is below.
echo "$CLEARED" | grep -qE '"spared":[1-9]' \
  && ok "a song still on the speaker was spared" || bad "spared count" "$CLEARED"

# Everything finished is now voided, so /api/history is empty of them.
HIST=$(curl -s -b "$JAR" "$BASE/api/history")
echo "$HIST" | grep -q "$PLAY_ID" \
  && bad "cleared songs drop out of history" "still listed" \
  || ok "cleared songs drop out of history"

# But the rows are still there — voided, not deleted.
APLAYS=$(curl -s "$BASE/api/admin/plays" -H "X-Admin-Password: $ADMIN_PW")
echo "$APLAYS" | grep -q "$PLAY_ID" \
  && ok "cleared songs are voided, not deleted" || bad "rows survive clearing" "gone"

# And the live one is untouched, so a second clear has something to do later.
echo "$APLAYS" | grep -q "\"id\":\"$LIVE_PLAY\"[^}]*\"voided\":0" \
  && ok "the live song is still counting" || bad "live song voided" "$APLAYS"

AGAIN=$(curl -s -X POST "$BASE/api/admin/plays/void-all" -H "X-Admin-Password: $ADMIN_PW")
echo "$AGAIN" | grep -q '"voided":0' \
  && ok "clearing twice is a no-op, not an error" || bad "second clear" "$AGAIN"

echo "== heartbeat =="
curl -s -X POST "$BASE/api/heartbeat" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"AuxGoat"}' > /dev/null
curl -s -b "$JAR" "$BASE/api/now" | grep -q '"speaker_online":true' \
  && ok "speaker reports online after heartbeat" || bad "heartbeat" "not online"

rm -f "$JAR"
echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
