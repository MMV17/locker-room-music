#!/usr/bin/env bash
# Discover nearby Bluetooth devices, for the Admin screen's speaker picker.
#
#   /usr/local/bin/bt-scan.sh          # started by the listener, via ALLOWED
#   BT_SCAN_SECONDS=5 bt-scan.sh       # shorter sweep (tests, bench work)
#
# Emits one device per line, tab separated:
#
#     MAC<TAB>CLASS<TAB>RSSI<TAB>NAME
#
# Parsed by pi/lockerroom/btscan.py, which treats this output as untrusted:
# NAME is chosen by a stranger's phone and ends up on a web page. Keep the
# format exactly this — NAME is last precisely so a device that names itself
# with a tab cannot add columns.
#
# Written 2026-08-31, for the speaker selection UI. Before it, choosing the
# relay speaker meant editing /etc/lockerroom/config.toml over SSH, which on
# the campus network does not exist.
#
# WHY A SCRIPT AND NOT A COMMAND STRING: control.py's ALLOWED maps a fixed name
# to a fixed argv, and that is the property that stops this channel becoming a
# remote shell. A script keeps the argv fixed no matter how complicated the
# scanning gets.
set -uo pipefail

SECONDS_TO_SCAN="${BT_SCAN_SECONDS:-15}"
BTCTL="${BT_SCAN_BLUETOOTHCTL:-bluetoothctl}"

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

# THE DONGLE (2026-11-13): when a USB dongle carries the phones, the speaker
# has to be found by the BUILT-IN chip - the adapter the relay pairs and
# connects through - and bluetoothctl only scans whichever adapter it treats as
# default. lockerroom.adapter_scan scans one named adapter and prints the same
# format. Not split: the bluetoothctl sweep below, unchanged.
bt_roles
if [ "$SPLIT" = "1" ] && [ -n "$RELAY" ]; then
  PYTHONPATH="$AUXGOAT_PKG_ROOT" timeout "$((SECONDS_TO_SCAN + 20))" \
    "$AUXGOAT_PY" -m lockerroom.adapter_scan "$RELAY" "$SECONDS_TO_SCAN" 2>/dev/null
  exit 0
fi

# Discovery is a sweep, not a subscription: it has to run for a while and then
# be read. --timeout makes bluetoothctl do exactly that and exit, which is what
# lets this be a plain blocking command instead of a background process someone
# has to remember to kill.
# The outer `timeout` is for a bluetoothd that is not answering at all: then
# bluetoothctl never reaches the point where its own --timeout starts counting.
timeout "$((SECONDS_TO_SCAN + 10))" "$BTCTL" --timeout "$SECONDS_TO_SCAN" scan on >/dev/null 2>&1

# `devices` lists everything the controller knows about, which after a scan is
# everything nearby plus everything ever paired. That is deliberate: a speaker
# that is already paired but switched off should still be selectable, so the
# operator can re-point the box at it before walking over to turn it on.
mac_list="$(timeout 10 "$BTCTL" devices 2>/dev/null | awk '$1 == "Device" { print $2 }')"

[ -z "$mac_list" ] && exit 0

while IFS= read -r mac; do
  [ -z "$mac" ] && continue

  # One info call per device. Class and RSSI are not in `devices` output, and
  # the class is what sorts speakers to the top of the list.
  info="$(timeout 5 "$BTCTL" info "$mac" 2>/dev/null)"

  # Everything below tolerates a missing field. A device that reports no class
  # is still a device, and dropping it would hide the exact speaker somebody is
  # holding in front of the box.
  name="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*Name:[[:space:]]*//p' | head -1)"
  # bluetoothctl prints "Class: 0x00240414 (2360340)" - hex AND decimal on one
  # line. Measured on the box 2026-08-31; taking the whole field made every
  # device unparseable and silently killed the audio-first sort. First token
  # only. The parser defends against this too, because both is cheap.
  class="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*Class:[[:space:]]*//p' | head -1 | awk '{print $1}')"
  rssi="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*RSSI:[[:space:]]*//p' | head -1 | awk '{print $1}')"

  # Strip tabs so the field separator stays the field separator. The parser
  # also defends against this; both, because this is the cheap half.
  name="${name//$'\t'/ }"

  printf '%s\t%s\t%s\t%s\n' "$mac" "$class" "$rssi" "$name"
done <<< "$mac_list"
