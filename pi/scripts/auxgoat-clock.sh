#!/usr/bin/env bash
# Step a badly wrong clock FORWARD from an HTTP Date header. Boot only.
#
#   /usr/local/bin/auxgoat-clock.sh       # run by auxgoat-clock.service
#
# See auxgoat-clock.service for the failure this prevents. The rules, each of
# which is a way this could otherwise do harm:
#
#   * ONLY when NTP has not synchronised. If the network gives us real time,
#     this does nothing at all.
#   * ONLY forward, and only when more than two minutes behind. A clock that is
#     ahead is left for NTP: stepping backwards can make files, logs and retry
#     timers disagree, and it is not the failure that locks us out.
#   * ONLY within sane bounds: not before this script was written, not more
#     than ten years after. A header saying 1970 or 2099 is ignored.
#   * ONLY at boot. Run later it refuses, because a clock stepped under a song
#     that is playing corrupts that song's play time.
#   * Every network call has a hard limit, and the unit has one on top.
#
# The header comes over plain HTTP first, on purpose: a clock that is far
# enough behind cannot complete a TLS handshake, which is the whole problem.
# Somebody on the same network could forge that header. What they would get is
# a wrong clock - the same thing they can already cause by blocking NTP - and
# the bounds above cap how wrong.
set -uo pipefail

# Not before 2026-11-01T00:00:00Z, not after ten years on from that.
NOT_BEFORE=1793491200
NOT_AFTER=$((NOT_BEFORE + 315360000))
MIN_BEHIND_S=120
MAX_UPTIME_S=900

PLAIN_URL="${AUXGOAT_CLOCK_URL:-http://captive.apple.com/hotspot-detect.html}"
CONFIG="${AUXGOAT_CONFIG:-/etc/lockerroom/config.toml}"
FALLBACK_HOST="https://auxgoat-hc.mmvinton17.workers.dev"
UPTIME_FILE="${AUXGOAT_UPTIME_FILE:-/proc/uptime}"
# Overridable so the tests can observe the decision without setting a clock.
SET_CMD="${AUXGOAT_CLOCK_SET_CMD:-date -u -s}"

UP="$(cut -d. -f1 "$UPTIME_FILE" 2>/dev/null)"
case "$UP" in ''|*[!0-9]*) UP=0 ;; esac
if [ "$UP" -gt "$MAX_UPTIME_S" ] && [ "${1:-}" != "--force" ]; then
  echo "clock: not at boot (up ${UP}s) - refusing to step the clock under a running box"
  exit 0
fi

# Give NTP first refusal. It is better than this in every way when it works.
for _ in 1 2 3 4 5; do
  SYNCED="$(timeout 5 timedatectl show -p NTPSynchronized --value 2>/dev/null)"
  [ "$SYNCED" = "yes" ] && { echo "clock: NTP is synchronised - nothing to do"; exit 0; }
  sleep 2
done
if [ "$SYNCED" != "no" ]; then
  # Empty or unexpected: we do not know, and not knowing is not a reason to act.
  echo "clock: could not tell whether NTP is synchronised - leaving the clock alone"
  exit 0
fi

header_date() {  # header_date <curl args...> -> epoch seconds, or nothing
  local line
  line="$(timeout 12 curl -sI -m 8 "$@" 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: *//p' | head -1)"
  [ -n "$line" ] || return 1
  date -u -d "$line" +%s 2>/dev/null
}

API="$(sed -n 's/^api_base_url *= *"\(https:[^"]*\)".*/\1/p' "$CONFIG" 2>/dev/null | head -1)"
REMOTE="$(header_date "$PLAIN_URL")" \
  || REMOTE="$(header_date -k "${API:-$FALLBACK_HOST}/")" \
  || REMOTE="$(header_date -k "$FALLBACK_HOST/")" \
  || REMOTE=""
case "$REMOTE" in ''|*[!0-9]*)
  echo "clock: no usable Date header from any source - leaving the clock alone"
  exit 0 ;;
esac

if [ "$REMOTE" -lt "$NOT_BEFORE" ] || [ "$REMOTE" -gt "$NOT_AFTER" ]; then
  echo "clock: the Date header ($REMOTE) is outside sane bounds - ignoring it"
  exit 0
fi

NOW="$(date -u +%s)"
BEHIND=$((REMOTE - NOW))
if [ "$BEHIND" -le "$MIN_BEHIND_S" ]; then
  echo "clock: ${BEHIND}s behind the network's time - within tolerance, or ahead; not stepping"
  exit 0
fi

echo "clock: ${BEHIND}s BEHIND with NTP unsynchronised - stepping forward to $(date -u -d "@$REMOTE" -Is 2>/dev/null)"
# shellcheck disable=SC2086  # SET_CMD is a command plus its flags, on purpose
$SET_CMD "@$REMOTE" >/dev/null 2>&1 || echo "clock: could not set the clock"
exit 0
