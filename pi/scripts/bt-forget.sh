#!/usr/bin/env bash
# Forget one paired device, so a phone that forgot US can pair again.
#
# WHY THIS EXISTS. Bluetooth has no "unpair" message: forgetting is local and
# one-sided. When somebody hits "Forget This Device" on their phone, iOS drops
# its link key and never tells us, so this box keeps a bond for a device that
# no longer has one. The phone then asks for a FRESH pairing, and BlueZ's
# default — JustWorksRepairing = never — refuses a Just Works re-pair for an
# address it already has a bond for. The link forms and drops, forever.
#
# The only cure is removing the bond HERE, and before this script that needed a
# serial cable. On campus there is no other way in, which is the whole reason
# the 443 escape hatch exists. Measured 2026-09-21: one phone, one evening.
#
# NO ARGUMENTS, like every entry on the command allowlist. The MAC arrives as
# STATE on the beacon response, is validated by the listener
# (lockerroom/forgettarget.py) and written here. See that module's docstring
# for why the action and the target travel separately.
set -uo pipefail

TARGET_FILE="${LOCKERROOM_FORGET_TARGET:-/run/lockerroom/forget-target}"
RELAY_FILE="${LOCKERROOM_RELAY_TARGET:-/run/lockerroom/relay-target}"
BTCTL="${BTCTL:-bluetoothctl}"

MAC="$(head -1 "$TARGET_FILE" 2>/dev/null | tr -d '[:space:]')"

if [ -z "$MAC" ]; then
  echo "nothing to forget: no target was set"
  exit 1
fi

# Re-validate rather than trust the file. The listener already checked, and
# this is the same double-gating the allowlist uses: the thing that writes
# this file is not the only thing standing between a string and bluetoothctl.
if ! printf '%s' "$MAC" | grep -qiE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'; then
  echo "refusing: $MAC is not a MAC address"
  exit 1
fi

# REFUSE THE SPEAKER WE ARE PLAYING THROUGH. Forgetting it would drop audio
# with no error anywhere and cost the one-tap return the pairing exists for —
# a silent self-inflicted outage. Clear the speaker selection first if that is
# genuinely what you want.
LIVE_RELAY="$(head -1 "$RELAY_FILE" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$LIVE_RELAY" ] && [ "${MAC^^}" = "${LIVE_RELAY^^}" ]; then
  echo "refusing: $MAC is the speaker this box is playing through."
  echo "Switch the speaker (or choose wired output) first, then forget it."
  exit 1
fi

NAME="$($BTCTL info "$MAC" 2>/dev/null | sed -n 's/^\s*Alias:\s*//p' | head -1)"
echo "forgetting ${NAME:-$MAC} ($MAC)"

# Disconnect first so the removal is not racing a live ACL link.
timeout 20 $BTCTL disconnect "$MAC" 2>&1 | tail -1
sleep 1
timeout 20 $BTCTL remove "$MAC" 2>&1 | tail -1
sleep 1

# VERIFY, because `remove` dropping the device from the list while leaving its
# link keys on disk reproduces the exact symptom this is meant to cure. Found
# worth checking on 2026-09-21.
STILL_LISTED=0
$BTCTL devices Paired 2>/dev/null | grep -qi "$MAC" && STILL_LISTED=1
KEYS_LEFT=0
ls /var/lib/bluetooth/*/"${MAC^^}" >/dev/null 2>&1 && KEYS_LEFT=1
ls /var/lib/bluetooth/*/"${MAC,,}" >/dev/null 2>&1 && KEYS_LEFT=1

if [ "$STILL_LISTED" = "1" ] || [ "$KEYS_LEFT" = "1" ]; then
  echo "FAILED: still paired=$STILL_LISTED, keys on disk=$KEYS_LEFT"
  echo "The phone will still be refused. This needs a shell."
  exit 1
fi

# One-shot: clear the request so a later run cannot silently re-forget a phone
# that has since re-paired.
rm -f "$TARGET_FILE"

echo "forgotten. ${NAME:-$MAC} can pair again now."
$BTCTL show 2>/dev/null | grep -iE 'discoverable:|pairable:' | sed 's/^/  /'
exit 0
