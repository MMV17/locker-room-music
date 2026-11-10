#!/usr/bin/env bash
# Tests for resolve-worker.sh, against a fake `curl`. No network, no token.
#
#   bash .github/scripts/test-resolve-worker.sh
#
# The script under test decides whether a deploy may run and which Worker it
# uploads to. Getting it wrong either blocks every deploy or creates a Worker
# with no secrets in front of the live site, so each branch is pinned here.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${!#}"   # the URL is the last argument
case "$url" in
  */workers/scripts)
    if [ "${FAKE_LIST_FAIL:-0}" = 1 ]; then echo '{"success":false,"errors":[{"code":10000}]}'; exit 22; fi
    printf '{"success":true,"result":[%s]}' "${FAKE_SCRIPTS:-}";;
  */secrets)
    if [ "${FAKE_SECRETS_FAIL:-0}" = 1 ]; then echo 'boom'; exit 22; fi
    printf '{"success":true,"result":[%s]}' "${FAKE_SECRETS:-}";;
  *) echo "unexpected url: $url" >&2; exit 2;;
esac
FAKE
chmod +x "$TMP/bin/curl"

ALL='{"name":"DEVICE_KEY"},{"name":"MAC_SALT"},{"name":"TEAM_CODE"},{"name":"ADMIN_PASSWORD"}'
FAILED=0

# check <label> <expected rc> <expected stdout> -- run with FAKE_* / ALLOW_CREATE in the environment
check() {
  local label="$1" want_rc="$2" want_out="$3" out rc
  out="$(PATH="$TMP/bin:$PATH" CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCOUNT_ID=a \
        WANT_NAME=new-name LEGACY_NAME=old-name \
        REQUIRED_SECRETS="DEVICE_KEY MAC_SALT TEAM_CODE ADMIN_PASSWORD" \
        GITHUB_OUTPUT="" bash "$HERE/resolve-worker.sh" 2>"$TMP/err")"
  rc=$?
  if [ "$rc" = "$want_rc" ] && [ "$out" = "$want_out" ]; then
    echo "ok    $label"
  else
    echo "FAIL  $label: rc=$rc (want $want_rc) stdout=[$out] (want [$want_out])"
    sed 's/^/        /' "$TMP/err"
    FAILED=1
  fi
}

FAKE_SCRIPTS='{"id":"other"},{"id":"old-name"}' FAKE_SECRETS="$ALL" \
  check "only the legacy Worker exists -> deploy to the legacy name" 0 "old-name"
FAKE_SCRIPTS='{"id":"other"},{"id":"new-name"}' FAKE_SECRETS="$ALL" \
  check "renamed -> deploy to the new name" 0 "new-name"
FAKE_SCRIPTS='{"id":"old-name"},{"id":"new-name"}' FAKE_SECRETS="$ALL" \
  check "both exist -> the new name wins" 0 "new-name"
FAKE_SCRIPTS='{"id":"other"}' FAKE_SECRETS="$ALL" \
  check "neither exists -> refuse" 1 ""
FAKE_SCRIPTS='' FAKE_SECRETS="$ALL" \
  check "empty account -> refuse" 1 ""
ALLOW_CREATE=1 FAKE_SCRIPTS='{"id":"other"}' FAKE_SECRETS='' \
  check "neither exists but creation allowed -> the new name" 0 "new-name"
FAKE_SCRIPTS='{"id":"new-name"}' FAKE_SECRETS='{"name":"DEVICE_KEY"},{"name":"TEAM_CODE"}' \
  check "target is missing secrets -> refuse" 1 ""
FAKE_LIST_FAIL=1 FAKE_SCRIPTS='' FAKE_SECRETS="$ALL" \
  check "cannot list Workers -> refuse" 1 ""
FAKE_SECRETS_FAIL=1 FAKE_SCRIPTS='{"id":"new-name"}' FAKE_SECRETS='' \
  check "cannot read the secret list -> warn and continue" 0 "new-name"
FAKE_SCRIPTS='{"id":"new-name-2"},{"id":"xold-name"}' FAKE_SECRETS="$ALL" \
  check "a name that only contains the wanted one does not match" 1 ""

if [ "$FAILED" = 0 ]; then echo "all passed"; fi
exit "$FAILED"
