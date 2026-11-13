#!/usr/bin/env bash
# Let a phone that forgot this box pair with it again, without anyone having to
# forget the phone here first.
#
#   sudo pi/scripts/bt-repair-policy.sh             # set it, restart bluetoothd if changed
#   sudo pi/scripts/bt-repair-policy.sh --no-restart  # provision.sh: it reboots anyway
#
# WHY. Bluetooth has no "unpair" message. "Forget This Device" on a phone drops
# the phone's link key and never tells us, so this box keeps a bond for a device
# that no longer has one. When the phone then asks for a FRESH pairing, BlueZ's
# default `JustWorksRepairing = never` refuses a Just Works pairing for an
# address it already has a bond for. The link forms and drops, forever, and the
# only way out was Admin -> Pairings -> Forget (bt-forget.sh). Reported again
# 2026-11-13: forgetting on the phone has to forget on the Pi "at the same
# time", and the Pi cannot know it happened.
#
# `always` is the fix: BlueZ accepts the new pairing and overwrites the stale
# bond. That IS forgetting on both sides at once, done the only way possible:
# at the moment the phone comes back.
#
# THE TRADE, written down so nobody has to rediscover it. With `always`,
# something that spoofs a paired phone's address can pair in its place. Here it
# changes nothing: bt-agent runs NoInputNoOutput, so pairing is Just Works and
# ANY device in range can already pair as itself. Nothing is gated on a bond.
#
# THE RESTART. bluetoothd reads main.conf only at startup, so a change needs a
# restart, which drops every connected phone for a few seconds. It is done only
# when this script actually CHANGED the file, so a second run is a no-op, and
# always with --job-mode=ignore-dependencies: lockerroom-listener has
# Requires=bluetooth.service, and a plain restart would take the control channel
# down with it (see remote-repair.sh, and docs/STATE.md "THE REPAIR RESTARTED
# THE LISTENER AND LOST ITS OWN LOG"). Since 2026-11-13 run-repair also runs
# mid-song (it is an Admin "Fix the speaker"), so this can cut a song once.
#
# Overridable so pytest can run this against a fake main.conf.
set -uo pipefail

MAIN_CONF="${BT_MAIN_CONF:-/etc/bluetooth/main.conf}"
RESTART_CMD="${BT_RESTART_CMD:-systemctl restart --job-mode=ignore-dependencies bluetooth}"
WANT="JustWorksRepairing = always"

NO_RESTART=0
[ "${1:-}" = "--no-restart" ] && NO_RESTART=1

if [ ! -f "$MAIN_CONF" ]; then
  echo "  $MAIN_CONF is missing - is bluez installed? Nothing changed."
  exit 1
fi

if grep -qE '^[[:space:]]*JustWorksRepairing[[:space:]]*=[[:space:]]*always[[:space:]]*$' "$MAIN_CONF"; then
  echo "  already set: $WANT"
  exit 0
fi

# Replace an existing line, commented or not (stock Debian ships
# `#JustWorksRepairing = never` under [General]), else add one under [General].
# The key is a [General] setting; BlueZ ignores it anywhere else.
if grep -qE '^[[:space:]]*#?[[:space:]]*JustWorksRepairing[[:space:]]*=' "$MAIN_CONF"; then
  sed -i -E "s/^[[:space:]]*#?[[:space:]]*JustWorksRepairing[[:space:]]*=.*/$WANT/" "$MAIN_CONF"
elif grep -q '^\[General\]' "$MAIN_CONF"; then
  sed -i "/^\[General\]/a $WANT" "$MAIN_CONF"
else
  printf '\n[General]\n%s\n' "$WANT" >> "$MAIN_CONF"
fi

# Verify rather than assume: a sed that matched nothing exits 0 too.
if ! grep -qE '^JustWorksRepairing = always$' "$MAIN_CONF"; then
  echo "  ERROR: could not set $WANT in $MAIN_CONF"
  exit 1
fi
echo "  set: $WANT"

if [ "$NO_RESTART" = "1" ]; then
  echo "  takes effect when bluetooth next starts"
  exit 0
fi

echo "  restarting bluetooth.service so it reads the change"
echo "  (WITHOUT dependency propagation, so the listener survives it)"
timeout 45 $RESTART_CMD 2>&1 | sed 's/^/    /'
exit 0
