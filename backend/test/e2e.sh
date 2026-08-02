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

echo "== setup: roster =="
USER_ID=$(curl -s -X POST "$BASE/api/admin/users" \
  -H "X-Admin-Password: $ADMIN_PW" -H 'content-type: application/json' \
  -d '{"name":"Jake","jersey_number":"12","position":"WR"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$USER_ID" ] && ok "created player" || bad "created player" "no id returned"

echo "== auth =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/now")
[ "$code" = "401" ] && ok "unauthenticated /api/now is rejected" || bad "unauthenticated /api/now" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/plays" \
  -H 'content-type: application/json' -d '{}')
[ "$code" = "401" ] && ok "play write without device key is rejected" || bad "play write without device key" "got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/session" \
  -H 'content-type: application/json' -d "{\"team_code\":\"wrong\",\"user_id\":\"$USER_ID\"}")
[ "$code" = "403" ] && ok "wrong team code is rejected" || bad "wrong team code" "got $code"

curl -s -c "$JAR" -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"team_code\":\"$TEAM_CODE\",\"user_id\":\"$USER_ID\"}" > /dev/null
grep -q lr_token "$JAR" && ok "session cookie issued" || bad "session cookie" "no cookie set"

echo "== play ingest =="
PLAY_ID="11111111-1111-1111-1111-111111111111"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY_ID\",\"device_mac\":\"5C:AD:BA:F0:B2:61\",\"device_alias\":\"Jake's iPhone\",\"title\":\"Decode\",\"artist\":\"Paramore\",\"duration_ms\":240000,\"started_at\":\"$STARTED\"}" > /dev/null
ok "play accepted"

# Idempotent: the Pi retries after ambiguous timeouts.
curl -s -X POST "$BASE/api/plays" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' \
  -d "{\"play_id\":\"$PLAY_ID\",\"device_mac\":\"5C:AD:BA:F0:B2:61\",\"title\":\"Decode\",\"artist\":\"Paramore\",\"duration_ms\":240000,\"started_at\":\"$STARTED\"}" > /dev/null
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
echo "$UNCLAIMED" | grep -q '"mac_hint":"B2:61"' \
  && ok "unclaimed device exposes only a two-octet hint" || bad "mac hint" "$UNCLAIMED"
echo "$UNCLAIMED" | grep -q '"alias":"Jake'"'"'s iPhone"' \
  && ok "alias survives an idempotent retry that omitted it" \
  || bad "alias clobbered by retry" "$UNCLAIMED"
echo "$UNCLAIMED" | grep -qi '5C:AD:BA' \
  && bad "raw MAC must never appear" "$UNCLAIMED" \
  || ok "raw MAC absent from API (non-negotiable #3)"

HASH=$(echo "$UNCLAIMED" | sed -n 's/.*"mac_hash":"\([^"]*\)".*/\1/p')
curl -s -b "$JAR" -X POST "$BASE/api/devices/$HASH/claim" > /dev/null
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/devices/$HASH/claim")
[ "$code" = "409" ] && ok "double claim rejected" || bad "double claim" "got $code"

echo "== leaderboards =="
DJS=$(curl -s -b "$JAR" "$BASE/api/leaderboard/djs")
echo "$DJS" | grep -q '"djs":\[\]' \
  && ok "DJ with 1 play is hidden (needs 5)" || bad "DJ min plays" "$DJS"

echo "== heartbeat =="
curl -s -X POST "$BASE/api/heartbeat" -H "X-Device-Key: $DEVICE_KEY" \
  -H 'content-type: application/json' -d '{"speaker_name":"Locker Room Speaker"}' > /dev/null
curl -s -b "$JAR" "$BASE/api/now" | grep -q '"speaker_online":true' \
  && ok "speaker reports online after heartbeat" || bad "heartbeat" "not online"

rm -f "$JAR"
echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
