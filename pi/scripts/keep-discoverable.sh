#!/bin/bash
# Re-asserts discoverable/pairable on a loop. BlueZ sometimes drops
# discoverability after a connect/disconnect cycle even with
# DiscoverableTimeout=0 in main.conf, which would make the speaker
# invisible to the next DJ. Cheap enough to just poll.
#
# It also holds the adapter's link mode at CENTRAL (2026-11-13, an EXPERIMENT).
#
# WHY. The two-device test on 2026-11-12 (docs/STATE.md, "Two phones: the
# second stream knocks out the first") caught the box in a scatternet:
#
#   < ACL 78:66:F3:...  lm CENTRAL      the JBL (relay out)
#   > ACL 5C:AD:BA:...  lm PERIPHERAL   the DJ's iPhone
#   > ACL 44:09:DA:...  lm CENTRAL      the waiting iPad
#
# As a PERIPHERAL the radio must follow the iPhone's clock and hop sequence
# while running its own piconet for the other two, and the Pi 4's Broadcom
# combo chip time-slices that badly. Two seconds after the iPad opened a stream
# the iPhone's stream dropped. With link mode CENTRAL the kernel asks for a
# role switch when it accepts an incoming connection, so every link lands in
# ONE piconet on ONE clock. A phone may refuse the switch; nothing breaks if it
# does, the link simply stays as it was.
#
# Only NEW connections are affected: reconnect phones after this takes hold.
#
# WHY IN THIS LOOP. The link mode lives on the kernel's hci device, which is
# rebuilt on every btwatch rebind and every boot, and nothing else would put it
# back. This loop already runs for ever and is restarted on both.
#
# TO TURN IT OFF: set PREFER_CENTRAL=0 below, commit, Admin -> Update software.
set -uo pipefail

PREFER_CENTRAL="${AUXGOAT_PREFER_CENTRAL:-1}"
HCICONFIG="${HCICONFIG:-hciconfig}"
HCI="${AUXGOAT_HCI:-hci0}"

# hciconfig says CENTRAL on BlueZ >= 5.62 and MASTER before that, and accepts
# only its own spelling, so both are tried. Silent when nothing changes; one
# journal line when it does, so a report shows it happened.
hold_central() {
  [ "$PREFER_CENTRAL" = "1" ] || return 0
  command -v "$HCICONFIG" >/dev/null 2>&1 || return 0
  local lm
  lm="$(timeout 5 "$HCICONFIG" "$HCI" lm 2>/dev/null)" || return 0
  case "$lm" in
    *CENTRAL*|*MASTER*) return 0 ;;
  esac
  if timeout 5 "$HCICONFIG" "$HCI" lm accept,central >/dev/null 2>&1 \
     || timeout 5 "$HCICONFIG" "$HCI" lm accept,master >/dev/null 2>&1; then
    echo "keep-discoverable: link mode set to central ($(timeout 5 "$HCICONFIG" "$HCI" lm 2>/dev/null | tr -s '[:space:]' ' '))"
  else
    echo "keep-discoverable: could not set link mode to central (was: $(printf '%s' "$lm" | tr -s '[:space:]' ' '))"
  fi
}

# One pass, for the tests. The service never passes this.
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

while true; do
  # Bounded: bluetoothctl waits for ever on a bluetoothd that is not answering,
  # and this loop must still be turning when it comes back.
  timeout 10 bluetoothctl power on >/dev/null 2>&1
  timeout 10 bluetoothctl discoverable on >/dev/null 2>&1
  timeout 10 bluetoothctl pairable on >/dev/null 2>&1
  hold_central
  [ "$ONCE" = "1" ] && exit 0
  sleep 5
done
