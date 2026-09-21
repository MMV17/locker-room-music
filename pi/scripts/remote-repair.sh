#!/usr/bin/env bash
# The repair the box runs when someone presses "run repair" on the Admin screen.
#
# HOW TO USE THIS FILE. It is the one piece of the system you can change without
# a shell: edit it, commit, push, press the button. run-repair.sh pulls this
# repo on the Pi and runs THIS path. So when a new fault shows up on campus and
# nobody can reach the box, the fix goes here.
#
# WHAT IT MUST NOT DO. It must never write to /opt/lockerroom/lockerroom. The
# listener is the control channel and replacing it can lock everyone out of the
# box mid-repair. run-repair.sh snapshots that directory before this runs and
# restores it afterwards if it changed, so an accident here is caught — but do
# not lean on that. Listener code changes go over serial or the cable.
#
# KEEP IT IDEMPOTENT. Nobody watches this run. Pressing it twice must be safe,
# and every step should be a no-op on a healthy box.
set -uo pipefail   # not -e: fix what can be fixed and report the rest.

# Units that must be running AND enabled for the box to be a speaker. `enable`
# matters as much as `restart`: an active-but-disabled unit works perfectly
# until the next power cut, which has bitten this project three times.
# NOTE WHAT IS NOT IN THIS LIST: `bluetooth`.
#
# lockerroom-listener.service declares `Requires=bluetooth.service`, and
# systemd PROPAGATES a restart across Requires= - so `systemctl restart
# bluetooth` restarts the listener too. The listener is the control channel, so
# that is a repair which kills the thing reporting it and loses its own log
# every single time. Measured on 2026-09-21: the run-repair that found the
# rfkill block never reported, and the listener journal showed it stopped and
# started mid-command.
#
# This is the same hazard the "never modify the listener package" rule exists
# for, arriving by a different road - not replacing the listener, but
# restarting it out from under itself. Restarting bluetooth is handled
# separately and deliberately at the bottom of this script.
UNITS="bt-agent keep-discoverable lockerroom-btwatch \
lockerroom-netwatch lockerroom-audio-route bluealsa bluealsa-aplay"

# lockerroom-listener is NOT in that list either, for the direct version of the
# same reason. `restart-listener` is its own allowlisted command for when that
# is genuinely what you want.

echo "repair: $(date -Is 2>/dev/null)"
echo

# ---------------------------------------------------------------------------
# 1. The 2026-09-20 fault: healthy controller, not advertising.
#
# The box was online, beaconing, and taking commands; the adapter was UP
# RUNNING but had no PSCAN/ISCAN, so no phone could see `AuxGoat 0001`.
# keep-discoverable and bt-agent are what set and hold those flags.
# lockerroom-btwatch never fired because it only triggers when the controller
# is NOT UP RUNNING — a healthy-but-silent adapter is exactly its blind spot.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 0. Unblock the radio. This comes FIRST because nothing below it can work
#    while the adapter is soft-blocked - hci0 stays DOWN and "Powered: no"
#    through any number of service restarts, which is exactly how 2026-09-21
#    presented: every unit green, the box invisible to every phone.
# ---------------------------------------------------------------------------
echo "===== rfkill ====="
if command -v rfkill >/dev/null 2>&1; then
  echo "  before:"; timeout 10 rfkill list bluetooth 2>&1 | sed 's/^/    /'
  timeout 10 rfkill unblock bluetooth 2>&1 | sed 's/^/    /'
  echo "  after:";  timeout 10 rfkill list bluetooth 2>&1 | sed 's/^/    /'
else
  echo "  rfkill is not installed - cannot check or clear a soft block"
fi
echo

echo "===== units: enable + restart ====="
for u in $UNITS; do
  state="$(systemctl is-active "$u" 2>/dev/null || echo unknown)"
  enabled="$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)"
  printf '%-26s was %-10s %s\n' "$u" "$state" "$enabled"

  # Only units that exist. A box provisioned before a unit was introduced
  # should report that, not fail the whole repair.
  if ! systemctl cat "$u" >/dev/null 2>&1; then
    echo "    (no such unit on this box — skipped)"
    continue
  fi
  timeout 20 systemctl enable "$u" >/dev/null 2>&1 \
    || echo "    enable failed"
  timeout 30 systemctl restart "$u" >/dev/null 2>&1 \
    || echo "    restart failed"
  printf '    now %s / %s\n' \
    "$(systemctl is-active "$u" 2>/dev/null || echo unknown)" \
    "$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)"
done
echo

# ---------------------------------------------------------------------------
# 2. Put the adapter back into the state a DJ's phone can find.
#
# Belt and braces with keep-discoverable above: if that unit is broken for a
# reason this script did not fix, setting the flags directly still gets the
# room through tonight.
# ---------------------------------------------------------------------------
echo "===== adapter ====="
if command -v bluetoothctl >/dev/null 2>&1; then
  timeout 15 bluetoothctl power on        2>&1 | sed 's/^/  /'
  timeout 15 bluetoothctl discoverable on 2>&1 | sed 's/^/  /'
  timeout 15 bluetoothctl pairable on     2>&1 | sed 's/^/  /'
  echo
  timeout 10 bluetoothctl show 2>&1 | grep -Ei 'powered|discoverable|pairable|alias' | sed 's/^/  /'
else
  echo "  bluetoothctl is missing — this box needs a shell."
fi
if command -v hciconfig >/dev/null 2>&1; then
  echo
  echo "  hciconfig hci0 (want: UP RUNNING PSCAN ISCAN)"
  timeout 10 hciconfig hci0 2>&1 | sed 's/^/    /'
fi
echo

# ---------------------------------------------------------------------------
# 3. Audio routing, which is read-only unless it owns the config.
#
# audio-route.sh checks for its own "# managed by lockerroom" marker and leaves
# a hand-written /etc/asound.conf strictly alone. deploy.sh relies on the same
# property. Do not replace this with anything that writes unconditionally.
# ---------------------------------------------------------------------------
echo "===== audio routing ====="
if [ -x /usr/local/bin/audio-route.sh ]; then
  timeout 30 /usr/local/bin/audio-route.sh 2>&1 | sed 's/^/  /'
  echo "  selected: $(cat /run/lockerroom/audio-out 2>/dev/null || echo unknown)"
else
  echo "  /usr/local/bin/audio-route.sh is missing"
fi
echo

# ---------------------------------------------------------------------------
# 4. Only if the adapter is STILL down, restart bluetooth itself - and do it
#    without propagating to the listener.
#
# `--job-mode=ignore-dependencies` is the whole point of this block. A plain
# restart here takes the control channel down with it (Requires=), so the
# operator loses the log of the repair they are watching. This is a last
# resort, after unblocking and powering on have both failed.
# ---------------------------------------------------------------------------
echo "===== bluetooth service (last resort) ====="
STILL_DOWN=0
if command -v hciconfig >/dev/null 2>&1; then
  hciconfig hci0 2>/dev/null | grep -q "UP RUNNING" || STILL_DOWN=1
else
  timeout 10 bluetoothctl show 2>/dev/null | grep -q "Powered: yes" || STILL_DOWN=1
fi

if [ "$STILL_DOWN" = "1" ]; then
  echo "  adapter still down after unblocking - restarting bluetooth.service"
  echo "  WITHOUT dependency propagation, so the listener survives it."
  timeout 45 systemctl restart --job-mode=ignore-dependencies bluetooth 2>&1 | sed 's/^/    /'
  sleep 3
  timeout 15 bluetoothctl power on 2>&1 | sed 's/^/    /'
  timeout 15 bluetoothctl discoverable on 2>&1 | sed 's/^/    /'
  timeout 15 bluetoothctl pairable on 2>&1 | sed 's/^/    /'
  if command -v hciconfig >/dev/null 2>&1; then
    timeout 10 hciconfig hci0 2>&1 | sed 's/^/    /'
  fi
else
  echo "  adapter is up - leaving bluetooth.service alone."
  echo "  (restarting it would restart the listener too, via Requires=)"
fi
echo

echo "repair finished. Run report-full to see the box's state now."
