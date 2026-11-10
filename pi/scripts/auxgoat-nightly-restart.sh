#!/usr/bin/env bash
# Restart the listener, unless that would interrupt something.
#
#   /usr/local/bin/auxgoat-nightly-restart.sh     # run by auxgoat-nightly-restart.timer
#
# See auxgoat-nightly-restart.service for why this exists at all. It is
# deliberately `try-restart`: a listener that is stopped is somebody else's
# decision (or somebody else's bug), and this must not be the thing that
# starts it.
set -uo pipefail

ASOUND_ROOT="${ASOUND_ROOT:-/proc/asound}"
UPDATER="${AUXGOAT_UPDATER:-/usr/local/bin/auxgoat-update}"
HEALTH="${AUXGOAT_HEALTH:-/run/lockerroom/health.json}"

# An update on trial is being judged on whether its listener stays up. A
# restart here would be counted against it.
if [ -x "$UPDATER" ]; then
  STATE="$(timeout 20 "$UPDATER" status --field state 2>/dev/null)"
  if [ -n "$STATE" ] && [ "$STATE" != "idle" ]; then
    echo "skipped: a software update is in progress (state: $STATE)"
    exit 0
  fi
fi

# Music through a wired output shows up as a running ALSA playback stream.
if grep -qs "state: RUNNING" "$ASOUND_ROOT"/card*/pcm*p/sub*/status 2>/dev/null; then
  echo "skipped: audio is playing"
  exit 0
fi

# Music through the Bluetooth relay never touches an ALSA card, so ask the
# listener itself. It writes this file on every beacon.
if grep -qs '"open_play": *true' "$HEALTH" 2>/dev/null; then
  echo "skipped: a song is open on the speaker"
  exit 0
fi

echo "restarting the listener"
timeout 90 systemctl try-restart lockerroom-listener
