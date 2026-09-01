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

# Discovery is a sweep, not a subscription: it has to run for a while and then
# be read. --timeout makes bluetoothctl do exactly that and exit, which is what
# lets this be a plain blocking command instead of a background process someone
# has to remember to kill.
"$BTCTL" --timeout "$SECONDS_TO_SCAN" scan on >/dev/null 2>&1

# `devices` lists everything the controller knows about, which after a scan is
# everything nearby plus everything ever paired. That is deliberate: a speaker
# that is already paired but switched off should still be selectable, so the
# operator can re-point the box at it before walking over to turn it on.
mac_list="$("$BTCTL" devices 2>/dev/null | awk '$1 == "Device" { print $2 }')"

[ -z "$mac_list" ] && exit 0

while IFS= read -r mac; do
  [ -z "$mac" ] && continue

  # One info call per device. Class and RSSI are not in `devices` output, and
  # the class is what sorts speakers to the top of the list.
  info="$("$BTCTL" info "$mac" 2>/dev/null)"

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
