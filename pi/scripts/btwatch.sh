#!/usr/bin/env bash
# Recover a wedged Bluetooth controller without a reboot.
#
#   /usr/local/bin/btwatch.sh          # runs forever, started by systemd
#   BTWATCH_ONESHOT=1 btwatch.sh       # one check and exit (tests)
#
# Written 2026-08-31. On 2026-08-23 the controller hard hung during a relay
# test: both devices dropped in the same instant and dmesg filled with
#
#     Bluetooth: hci0: Opcode 0x0c03 failed: -110
#
# 0x0c03 is HCI_Reset. The controller was not answering a reset. In that state
# the three obvious commands ALL fail — `systemctl restart bluetooth`,
# `hciconfig hci0 up` (Can't init device hci0: Connection timed out (110)) and
# `btmgmt power on` (org.bluez.Error.Failed) — while every service still
# reports `active`. A dead radio with all units green, on a box whose only
# other access is a serial cable. That is the failure class this whole project
# keeps producing, and this is the watchdog for it.
#
# WORTH HAVING EVEN WITHOUT THE RELAY: the same hang kills a plain Bluetooth
# speaker just as dead.
#
# This box has NO hciuart.service; the adapter is serdev-based, with
# hci_uart_bcm bound to serial0-0. Unbinding and rebinding re-runs the firmware
# download and brings it back in about six seconds — which turned a reboot into
# nothing when it was found.
set -uo pipefail

INTERVAL_S="${BTWATCH_INTERVAL_S:-60}"
# Injected by the tests so they never touch /sys or restart real services.
RECOVER_CMD="${RECOVER_CMD:-}"

# "UP RUNNING", not just "UP". The wedged controller can still report UP while
# answering nothing, so UP alone is not evidence of a working radio.
healthy() { hciconfig hci0 2>/dev/null | grep -q "UP RUNNING"; }

recover() {
  echo "btwatch: controller is wedged — rebinding hci_uart_bcm"
  if [ -n "$RECOVER_CMD" ]; then
    $RECOVER_CMD
    return
  fi
  echo serial0-0 > /sys/bus/serial/drivers/hci_uart_bcm/unbind 2>/dev/null
  sleep 3
  echo serial0-0 > /sys/bus/serial/drivers/hci_uart_bcm/bind 2>/dev/null
  sleep 3
  # Everything that held a handle on the old adapter has to re-bind to the new
  # one, or the radio comes back and nothing is using it — which looks exactly
  # like the fault it just recovered from.
  systemctl restart bluealsa bluealsa-aplay keep-discoverable bt-agent lockerroom-listener 2>/dev/null
  echo "btwatch: rebind complete"
}

while :; do
  if ! healthy; then
    recover
  fi
  [ "${BTWATCH_ONESHOT:-0}" = "1" ] && exit 0
  sleep "$INTERVAL_S"
done
