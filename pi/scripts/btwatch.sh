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
# Unbinding and rebinding DESTROYS the rfkill device and creates a NEW one (the
# index climbs, 933 -> 934 -> 935). systemd-rfkill keys its saved state by the
# device's platform name and RESTORES the block onto the new device. So the
# recovery loop re-applied the fault it was recovering from, once a minute,
# and would have done the same through a reboot.
#
# Returns 0 ONLY when it actually cleared a block. Callers must not report
# "recovered by unblocking" on any other status, or the journal will send the
# next reader down the rfkill path for an unrelated transient.
unblock() {
  command -v rfkill >/dev/null 2>&1 || return 1

  local before after
  before="$(rfkill list bluetooth 2>/dev/null)"

  # A HARD block is a kill switch, not software state, and `rfkill unblock`
  # cannot clear it. Name it, because otherwise it presents exactly like the
  # soft case and the backoff message below would point at the one field that
  # reads fine.
  if printf '%s' "$before" | grep -q "Hard blocked: yes"; then
    echo "btwatch: bluetooth is HARD BLOCKED — rfkill cannot clear that."
    echo "btwatch: this is a kill switch or firmware state; a rebind will not help either."
    return 1
  fi

  # UNCONDITIONAL, and deliberately not gated on observing "Soft blocked: yes".
  # systemd-rfkill restores the saved state onto a newly registered device
  # asynchronously, so checking first races it: after a rebind the block can
  # land milliseconds AFTER the check, and a guarded clear would skip and leave
  # the radio off — which is precisely the bug this function exists to fix.
  # The clear is a no-op on a healthy adapter, which is what makes it safe to
  # run every time. remote-repair.sh runs it unconditionally for this reason.
  rfkill unblock bluetooth 2>/dev/null

  after="$(rfkill list bluetooth 2>/dev/null)"
  if printf '%s' "$after" | grep -q "Soft blocked: yes"; then
    # Never let a failed clear look like a successful one. That specific
    # blindness is what cost nine hours on 2026-09-21.
    echo "btwatch: rfkill unblock DID NOT TAKE — still soft blocked."
    return 1
  fi
  if printf '%s' "$before" | grep -q "Soft blocked: yes"; then
    echo "btwatch: bluetooth was SOFT BLOCKED — cleared (a rebind cannot do this)"
    return 0
  fi
  return 1   # nothing was blocked, so nothing was cleared
}

# Unblocking only PERMITS the radio; something still has to power it on, and
# this script never did. keep-discoverable does it on a 5 second loop, so
# waiting for it is a race btwatch loses more often than it wins - and losing
# means falling through to a rebind that restarts the listener for nothing.
power_up() {
  hciconfig hci0 up 2>/dev/null
  command -v bluetoothctl >/dev/null 2>&1 && bluetoothctl power on >/dev/null 2>&1
  return 0
}

recover() {
  # Cheapest fix first: if the radio was only blocked, this returns it to
  # service without tearing the driver down or restarting the listener.
  if unblock; then
    power_up
    sleep 2
    if healthy; then
      echo "btwatch: recovered by clearing the rfkill block — no rebind needed"
      return
    fi
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
  # The device that just appeared is a NEW rfkill device and systemd-rfkill
  # will have restored the saved state onto it. Clear it again - unconditionally
  # - or the rebind has achieved nothing at all.
  unblock
  power_up
  # Everything that held a handle on the old adapter has to re-bind to the new
  # one, or the radio comes back and nothing is using it — which looks exactly
  # like the fault it just recovered from.
  systemctl restart bluealsa bluealsa-aplay keep-discoverable bt-agent lockerroom-listener 2>/dev/null
  echo "btwatch: rebind complete"
}

# Rate-limit RECOVERY, never detection. Each recovery restarts bluealsa,
# bt-agent, keep-discoverable AND lockerroom-listener, so a watchdog that
# cannot win is expensive: nine hours of minute-by-minute rebinds burned 44s of
# CPU and restarted the control channel often enough to lose in-flight
# commands. But sleeping through the quiet period would also blind the
# watchdog to an ordinary HCI_Reset wedge it CAN fix in six seconds, so the
# health check keeps running at INTERVAL_S and only `recover` backs off.
FAILS=0
LAST_RECOVER=0
BACKOFF_AFTER="${BTWATCH_BACKOFF_AFTER:-5}"
BACKOFF_S="${BTWATCH_BACKOFF_S:-900}"
# A non-numeric override would make every `[ -ge ]` below print "integer
# expression expected" once a minute and silently never back off at all.
case "$BACKOFF_AFTER" in ''|*[!0-9]*) BACKOFF_AFTER=5 ;; esac
case "$BACKOFF_S"     in ''|*[!0-9]*) BACKOFF_S=900 ;; esac

# Bounded runs, so the backoff branch is reachable from a test. Without this
# the oneshot exit fires first and lines below it never execute under pytest.
MAX_CYCLES="${BTWATCH_MAX_CYCLES:-0}"
CYCLES=0

while :; do
  if healthy; then
    FAILS=0
  else
    NOW="$(date +%s)"
    if [ "$FAILS" -lt "$BACKOFF_AFTER" ] || [ $((NOW - LAST_RECOVER)) -ge "$BACKOFF_S" ]; then
      recover
      LAST_RECOVER="$(date +%s)"
      if healthy; then
        FAILS=0
      else
        FAILS=$((FAILS + 1))
        if [ "$FAILS" -eq "$BACKOFF_AFTER" ]; then
          echo "btwatch: $FAILS recoveries have not fixed this — rate-limiting recovery to ${BACKOFF_S}s."
          echo "btwatch: run report-full; check BOTH 'Soft blocked' AND 'Hard blocked', and dmesg."
        fi
      fi
    fi
  fi

  CYCLES=$((CYCLES + 1))
  [ "${BTWATCH_ONESHOT:-0}" = "1" ] && exit 0
  [ "$MAX_CYCLES" -gt 0 ] && [ "$CYCLES" -ge "$MAX_CYCLES" ] && exit 0
  sleep "$INTERVAL_S"
done
