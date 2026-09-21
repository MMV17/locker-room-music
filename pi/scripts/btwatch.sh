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

# An rfkill SOFT BLOCK is invisible to everything this watchdog used to do, and
# a rebind actively preserves it. Measured 2026-09-21: 212 rebinds over nine
# hours, every one of which reloaded the BCM4345C0 firmware perfectly and left
# the radio just as blocked.
#
# The mechanism is worth stating exactly, because it is not obvious. Unbinding
# and rebinding DESTROYS the rfkill device and creates a NEW one (the index
# climbs, 933 -> 934 -> 935). systemd-rfkill keys its saved state by the
# device's platform name and faithfully RESTORES the block onto the new device
# every time. So the recovery loop re-applied the fault it was recovering from,
# once a minute, forever - and it would have survived a reboot too, for the
# same reason.
#
# Unblock BEFORE deciding anything is wedged. It is a no-op on a healthy box,
# it costs nothing, and it is the one thing a rebind can never achieve.
# provision.sh already did this ONCE at provision time and documented that a
# fresh registration can come up blocked (2026-08-19, stock Trixie); what was
# missing is that every rebind is a fresh registration.
unblock() {
  command -v rfkill >/dev/null 2>&1 || return 0
  rfkill list bluetooth 2>/dev/null | grep -q "Soft blocked: yes" || return 0
  echo "btwatch: bluetooth is SOFT BLOCKED — unblocking (a rebind cannot fix this)"
  rfkill unblock bluetooth 2>/dev/null
  sleep 2
}

recover() {
  # Cheapest fix first. If the radio was only blocked, this returns it to
  # service without tearing the driver down or restarting the listener.
  unblock
  if healthy; then
    echo "btwatch: recovered by unblocking alone — no rebind needed"
    return
  fi

  echo "btwatch: controller is wedged — rebinding hci_uart_bcm"
  if [ -n "$RECOVER_CMD" ]; then
    $RECOVER_CMD
    return
  fi
  echo serial0-0 > /sys/bus/serial/drivers/hci_uart_bcm/unbind 2>/dev/null
  sleep 3
  echo serial0-0 > /sys/bus/serial/drivers/hci_uart_bcm/bind 2>/dev/null
  sleep 3
  # The device that just appeared is a NEW rfkill device, and systemd-rfkill
  # will have restored the saved state onto it. Clear it again or the rebind
  # has achieved nothing at all.
  unblock
  # Everything that held a handle on the old adapter has to re-bind to the new
  # one, or the radio comes back and nothing is using it — which looks exactly
  # like the fault it just recovered from.
  systemctl restart bluealsa bluealsa-aplay keep-discoverable bt-agent lockerroom-listener 2>/dev/null
  echo "btwatch: rebind complete"
}

# Back off rather than hammering. Each recovery restarts bluealsa, bt-agent,
# keep-discoverable AND lockerroom-listener, so a watchdog that cannot win costs
# far more than it saves: nine hours of minute-by-minute rebinds burned 44s of
# CPU, killed bt-agent on a stop timeout repeatedly, and restarted the control
# channel often enough to lose in-flight commands. If a fault survives several
# recoveries it is not the kind this watchdog fixes, and saying so once a
# quarter hour is more useful than saying it sixty times.
FAILS=0
BACKOFF_AFTER="${BTWATCH_BACKOFF_AFTER:-5}"
BACKOFF_S="${BTWATCH_BACKOFF_S:-900}"

while :; do
  if healthy; then
    FAILS=0
  else
    recover
    if healthy; then
      FAILS=0
    else
      FAILS=$((FAILS + 1))
    fi
  fi

  [ "${BTWATCH_ONESHOT:-0}" = "1" ] && exit 0

  if [ "$FAILS" -ge "$BACKOFF_AFTER" ]; then
    echo "btwatch: $FAILS recoveries have not fixed this — backing off to ${BACKOFF_S}s."
    echo "btwatch: run report-full from the Admin screen; check 'Soft blocked' and dmesg."
    sleep "$BACKOFF_S"
  else
    sleep "$INTERVAL_S"
  fi
done
