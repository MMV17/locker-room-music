#!/usr/bin/env bash
# Decide which Cloudflare Worker a deploy (or a diagnostic) must target, and
# REFUSE to create a brand-new Worker by accident.
#
# WHY THIS EXISTS. `wrangler deploy` treats the `name` in wrangler.toml as the
# Worker to upload to, and if no Worker has that name it quietly creates one.
# A new Worker has NO SECRETS - no DEVICE_KEY, MAC_SALT, TEAM_CODE or
# ADMIN_PASSWORD - and the same deploy moves the custom domains onto it. So a
# rename done only in wrangler.toml takes the whole product down in one merge,
# and MAC_SALT cannot be read back out of Cloudflare to repair it.
#
# The project was renamed to AuxGoat on 2026-11-10 and the team Worker's name
# went from the legacy one to `auxgoat-hc`. A Worker can only be renamed in
# the Cloudflare dashboard (that keeps its secrets, bindings and cron), which
# is a manual step nobody can do from a pull request. So until that step has
# happened this script keeps deploying to the Worker that actually exists:
#
#   wanted name exists             -> use it
#   only the legacy name exists    -> use the legacy name, and say so loudly
#   neither exists                 -> stop, unless ALLOW_CREATE=1
#   target is missing a secret     -> stop
#
# Every "cannot tell" case stops the deploy. A deploy that did not happen is
# fixed by re-running it; a second Worker without secrets is an outage.
#
# Usage (all inputs are environment variables):
#   CLOUDFLARE_API_TOKEN   required
#   CLOUDFLARE_ACCOUNT_ID  required
#   WANT_NAME              required  the name in wrangler.toml
#   LEGACY_NAME            optional  the name the Worker had before a rename
#   REQUIRED_SECRETS       optional  space-separated secret names that must exist
#   ALLOW_CREATE           optional  "1" lets a first-ever deploy create WANT_NAME
#   CF_API                 optional  API base, overridable for the tests
#
# Prints the chosen name on stdout (nothing else goes to stdout), and writes
# `name=<chosen>` to $GITHUB_OUTPUT when that is set. Messages go to stderr.
set -euo pipefail

API="${CF_API:-https://api.cloudflare.com/client/v4}"
WANT="${WANT_NAME:?WANT_NAME is required}"
LEGACY="${LEGACY_NAME:-}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

say()  { echo "$*" >&2; }
fail() { echo "::error::$*" >&2; exit 1; }

# One authenticated GET. Prints the body; fails the script unless the HTTP
# request worked AND Cloudflare's own envelope says success. The token goes in
# through a header file descriptor, never onto a command line that `ps` or a
# shell trace could show.
cf_get() {
  local path="$1" body
  if ! body="$(curl --silent --show-error --fail-with-body --max-time 30 \
        --retry 2 --retry-delay 2 \
        -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") \
        "$API/accounts/$CLOUDFLARE_ACCOUNT_ID$path" 2>&1)"; then
    say "Cloudflare API call failed for $path:"
    say "$(printf '%s' "$body" | head -c 400)"
    return 1
  fi
  if [ "$(printf '%s' "$body" | jq -r '.success' 2>/dev/null)" != "true" ]; then
    say "Cloudflare API answered without success for $path:"
    say "$(printf '%s' "$body" | head -c 400)"
    return 1
  fi
  printf '%s' "$body"
}

SCRIPTS_JSON="$(cf_get /workers/scripts)" \
  || fail "Could not list the account's Workers, so it is not safe to deploy. Nothing was changed. Check the CLOUDFLARE_API_TOKEN secret, then re-run."
NAMES="$(printf '%s' "$SCRIPTS_JSON" | jq -r '.result[]?.id // empty')"

has() { printf '%s\n' "$NAMES" | grep -Fxq -- "$1"; }

CREATING=0
if has "$WANT"; then
  TARGET="$WANT"
  if [ -n "$LEGACY" ] && has "$LEGACY"; then
    echo "::warning::Both '$WANT' and the legacy Worker '$LEGACY' exist. The legacy one still runs its cron triggers against the same database. Delete it in the Cloudflare dashboard once '$WANT' is confirmed working." >&2
  fi
elif [ -n "$LEGACY" ] && has "$LEGACY"; then
  TARGET="$LEGACY"
  echo "::warning::The Worker is still named '$LEGACY'. Deploying to it. To finish the rename: Cloudflare dashboard -> Workers & Pages -> $LEGACY -> Settings -> rename it to '$WANT', then re-run this workflow. See docs/LAUNCH.md." >&2
elif [ "${ALLOW_CREATE:-0}" = "1" ]; then
  TARGET="$WANT"
  CREATING=1
  echo "::warning::No Worker named '$WANT' exists and ALLOW_CREATE is set, so this run will CREATE it. It will have no secrets until they are set with 'wrangler secret put'." >&2
else
  TRIED="'$WANT'"
  if [ -n "$LEGACY" ]; then TRIED="$TRIED or '$LEGACY'"; fi
  fail "No Worker named $TRIED exists in this account. Refusing to create one: a new Worker has no secrets and would take the site down. If this really is a first deploy, run the workflow by hand with 'allow_create' ticked."
fi

if [ "$CREATING" = "0" ] && [ -n "${REQUIRED_SECRETS:-}" ]; then
  # Being UNABLE to read the list only warns: the Worker exists, a deploy does
  # not touch its secrets, and a token that cannot list them must not block
  # every fix from shipping. A list that was read and is short DOES stop it -
  # that is a half-configured Worker about to receive the custom domains.
  if SECRETS_JSON="$(cf_get "/workers/scripts/$TARGET/secrets")"; then
    HAVE="$(printf '%s' "$SECRETS_JSON" | jq -r '.result[]?.name // empty')"
    MISSING=""
    for s in $REQUIRED_SECRETS; do
      printf '%s\n' "$HAVE" | grep -Fxq -- "$s" || MISSING="$MISSING $s"
    done
    if [ -n "$MISSING" ]; then
      fail "Worker '$TARGET' is missing secret(s):$MISSING. Deploying now would break sign-in or the speaker. Set them with 'npx wrangler secret put <NAME> --name $TARGET' and re-run."
    fi
  else
    echo "::warning::Could not read which secrets '$TARGET' has; continuing, because the Worker exists and a deploy does not change its secrets." >&2
  fi
fi

say "Deploy target: $TARGET"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "name=$TARGET" >> "$GITHUB_OUTPUT"; fi
printf '%s\n' "$TARGET"
