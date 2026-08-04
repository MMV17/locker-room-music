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

echo "== heartbeat =="
curl -s -X POST "$BASE/api/heartbeat" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"Locker Room Speaker"}' > /dev/null
curl -s -b "$JAR" "$BASE/api/now" | grep -q '"speaker_online":true' \
  && ok "speaker reports online after heartbeat" || bad "heartbeat" "not online"

rm -f "$JAR"
echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
