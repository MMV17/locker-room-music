#!/bin/bash
# Re-asserts discoverable/pairable on a loop. BlueZ sometimes drops
# discoverability after a connect/disconnect cycle even with
# DiscoverableTimeout=0 in main.conf, which would make the speaker
# invisible to the next DJ. Cheap enough to just poll.
#
# It can also hold the adapter's link mode at CENTRAL (2026-11-13, an EXPERIMENT
# that FAILED, now OFF by default). On hardware the link mode took
# ("Link mode: ACCEPT CENTRAL") but both iPhone and iPad reconnected as
# PERIPHERAL anyway: iOS refuses the role switch. Kept, switched off, so
# nobody has to rediscover that. What it was meant to do, for the record:
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

PREFER_CENTRAL="${AUXGOAT_PREFER_CENTRAL:-0}"
HCICONFIG="${HCICONFIG:-hciconfig}"
HCI="${AUXGOAT_HCI:-hci0}"
BUSCTL="${BUSCTL:-busctl}"

# --- adapter roles: lockerroom/adapters.py is the ONE implementation --------
# Sets PHONES / RELAY / UART (hciN or "") and SPLIT (1 = a USB dongle carries
# the phones, the built-in chip only the relay). Anything going wrong leaves
# SPLIT=0 and ROLES_OK=0, and every caller then does exactly what it did before
# the dongle existed. Identical in every script; test_bt_roles_block holds that.
AUXGOAT_PKG_ROOT="${AUXGOAT_PKG_ROOT:-/opt/lockerroom}"
AUXGOAT_PY="${AUXGOAT_PY:-/opt/lockerroom/venv/bin/python}"
# shellcheck disable=SC2034  # not every script uses every role
bt_roles() {
  PHONES=""; RELAY=""; UART=""; SPLIT=0; ROLES_OK=0
  local out k v
  out="$(PYTHONPATH="$AUXGOAT_PKG_ROOT" timeout 10 "$AUXGOAT_PY" -m lockerroom.adapters 2>/dev/null)" || return 0
  while IFS='=' read -r k v; do
    case "$k=$v" in
      PHONES=hci[0-9]*|PHONES=) PHONES="$v" ;;
      RELAY=hci[0-9]*|RELAY=) RELAY="$v" ;;
      UART=hci[0-9]*|UART=) UART="$v" ;;
      SPLIT=1) SPLIT=1 ;;
    esac
  done <<< "$out"
  ROLES_OK=1
}
# --- end adapter roles --------------------------------------------------------

# One adapter property over D-Bus. busctl names the adapter by its object path,
# which bluetoothctl cannot do without an interactive "select" - and with two
# adapters, bluetoothctl's idea of "the" adapter follows probe order.
set_adapter() {
  timeout 10 "$BUSCTL" set-property org.bluez "/org/bluez/$1" org.bluez.Adapter1 "$2" "$3" "$4" >/dev/null 2>&1
}

# The speaker's name, as provision.sh set it. BlueZ names a SECOND adapter
# "<name> #2" by itself, which is what phones saw on the dongle's first day.
speaker_name() {
  local n
  n="$(timeout 5 hostnamectl --pretty 2>/dev/null)"
  [ -n "$n" ] || n="$(hostname 2>/dev/null)"
  printf '%s' "$n"
}

# Written only when it differs: an Alias write goes to BlueZ's storage on
# flash, and this loop runs every 5 seconds.
ensure_alias() {
  local cur
  cur="$(timeout 10 "$BUSCTL" get-property org.bluez "/org/bluez/$1" org.bluez.Adapter1 Alias 2>/dev/null)"
  [ "$cur" = "s \"$2\"" ] && return 0
  set_adapter "$1" Alias s "$2" && echo "keep-discoverable: $1 is now named '$2'"
}

# THE DONGLE (2026-11-13). Split: the dongle is what phones see and pair with;
# the built-in chip carries only the relay, so it is hidden and not pairable,
# and named so a phone that remembers it can tell it is not the one to use.
# Not split: exactly the three bluetoothctl lines this loop always ran.
assert_adapters() {
  if [ "$SPLIT" = "1" ]; then
    set_adapter "$PHONES" Powered b true
    set_adapter "$PHONES" Discoverable b true
    set_adapter "$PHONES" Pairable b true
    set_adapter "$RELAY" Powered b true
    set_adapter "$RELAY" Discoverable b false
    set_adapter "$RELAY" Pairable b false
    local name
    name="$(speaker_name)"
    if [ -n "$name" ]; then
      ensure_alias "$PHONES" "$name"
      ensure_alias "$RELAY" "$name (speaker link)"
    fi
  else
    timeout 10 bluetoothctl power on >/dev/null 2>&1
    timeout 10 bluetoothctl discoverable on >/dev/null 2>&1
    timeout 10 bluetoothctl pairable on >/dev/null 2>&1
  fi
}

# Recomputed only when the set of adapters changes - a dongle plugged in or
# pulled, or a btwatch rebind renumbering the built-in chip - not every 5s.
ROLES_SIG="unset"
refresh_roles() {
  local sig
  sig="$(ls "${AUXGOAT_BT_SYSFS:-/sys/class/bluetooth}" 2>/dev/null | tr '\n' ' ')"
  [ "$sig" = "$ROLES_SIG" ] && return 0
  ROLES_SIG="$sig"
  local was_split="${SPLIT:-0}"
  bt_roles
  if [ "$SPLIT" = "1" ]; then
    HCI="$PHONES"
    echo "keep-discoverable: phones on $PHONES (USB dongle), relay speaker on $RELAY (built-in, hidden)"
  else
    HCI="${PHONES:-${AUXGOAT_HCI:-hci0}}"
    if [ "$was_split" = "1" ]; then
      echo "keep-discoverable: one adapter again ($HCI) - phones and relay share it"
      # Back to the system name (empty Alias = the default), so a built-in chip
      # left named "... (speaker link)" by split mode is not what phones see.
      [ -n "$PHONES" ] && set_adapter "$PHONES" Alias s ""
    fi
  fi
}

# hciconfig says CENTRAL on BlueZ >= 5.62 and MASTER before that, and accepts
# only its own spelling, so both are tried. Silent when nothing changes; one
# journal line when it does, so a report shows it happened.
hold_central() {
  command -v "$HCICONFIG" >/dev/null 2>&1 || return 0
  local lm
  lm="$(timeout 5 "$HCICONFIG" "$HCI" lm 2>/dev/null)" || return 0
  if [ "$PREFER_CENTRAL" != "1" ]; then
    # Switched off - so UNDO it if an earlier run left it set. Turning the
    # experiment off did not reset the adapter on 2026-11-13: it kept reading
    # "Link mode: ACCEPT CENTRAL" until the next rebind or boot.
    case "$lm" in
      *CENTRAL*|*MASTER*)
        timeout 5 "$HCICONFIG" "$HCI" lm accept >/dev/null 2>&1 \
          && echo "keep-discoverable: link mode reset to the default (central-role experiment is off)" ;;
    esac
    return 0
  fi
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

SPLIT=0
while true; do
  # Every call is bounded: bluetoothctl and busctl wait for ever on a
  # bluetoothd that is not answering, and this loop must still be turning when
  # it comes back.
  refresh_roles
  assert_adapters
  hold_central
  [ "$ONCE" = "1" ] && exit 0
  sleep 5
done
