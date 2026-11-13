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
# not lean on that. Listener code changes go through auxgoat-update, which this
# script may INSTALL and ASK, and which does the work itself, later, in its own
# unit, with a trial and an automatic way back. See the two "software update"
# blocks below.
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
UNITS="bt-agent keep-discoverable lockerroom-audio-route bluealsa bluealsa-aplay"

# The two watchdogs are ENABLED every time but only started when they are not
# already running. Restarting a healthy watchdog throws away what it has
# counted - netwatch's run of failed probes, btwatch's recovery backoff - so a
# repair pressed during an outage used to reset the very ladders that were
# about to act on it.
WATCHDOGS="lockerroom-btwatch lockerroom-netwatch"

# Over-the-air listener updates, triggered from THIS script.
#
#   off        never
#   bootstrap  only while the box is on code installed by cable, i.e. while its
#              listener has no "update software" command of its own yet. This
#              is how the updater reaches a box for the very first time: the
#              OLD run-repair.sh, already installed, runs this file.
#   always     every repair also asks for an update. The rescue path, for a
#              listener whose own update command is broken - flip it in a
#              commit, press "run repair", flip it back.
OTA_VIA_REPAIR="bootstrap"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
BIN_DIR="${AUXGOAT_BIN_DIR:-/usr/local/bin}"
UNIT_DIR="${AUXGOAT_UNIT_DIR:-/etc/systemd/system}"
UPDATER="$BIN_DIR/auxgoat-update"

# lockerroom-listener is NOT in that list either, for the direct version of the
# same reason. `restart-listener` is its own allowlisted command for when that
# is genuinely what you want.

echo "repair: $(date -Is 2>/dev/null)"
echo

# ---------------------------------------------------------------------------
# Software update, part 1 of 2: make sure the updater itself is installed.
#
# NOTHING HERE TOUCHES THE LISTENER PACKAGE, and that is what lets it run
# under the run-repair.sh that is already on the box - its integrity guard
# sees the package unchanged and passes. Three files go OUTSIDE the package:
# the updater and its two units. Installing them changes nothing about what is
# running; it only makes an update possible.
#
# Written by rename, never in place (a script being rewritten while it runs is
# read half old and half new), and only when the bytes differ, so pressing
# repair twice is a no-op.
# ---------------------------------------------------------------------------
echo "===== software update: installer ====="
put() {  # put <src> <dest> <mode> -> prints "installed" only when it changed something
  local src="$1" dest="$2" mode="$3" tmp
  [ -f "$src" ] || { echo "  missing from the repo: $src"; return 1; }
  cmp -s "$src" "$dest" 2>/dev/null && return 0
  mkdir -p "$(dirname "$dest")" 2>/dev/null
  tmp="$(mktemp "$dest.tmp.XXXXXX" 2>/dev/null)" || { echo "  cannot write $dest"; return 1; }
  if cp "$src" "$tmp" && chmod "$mode" "$tmp" && mv -f "$tmp" "$dest"; then
    echo "  installed $dest"
  else
    rm -f "$tmp"; echo "  FAILED to install $dest"; return 1
  fi
}
UPDATER_OK=0
if [ -n "$REPO_DIR" ] && command -v python3 >/dev/null 2>&1 \
   && timeout 20 python3 -c 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")' \
        "$REPO_DIR/pi/scripts/auxgoat-update" 2>/dev/null; then
  put "$REPO_DIR/pi/scripts/auxgoat-update" "$UPDATER" 755 && UPDATER_OK=1
  # The recovery unit must exist BEFORE the first update ever switches code:
  # it is what finishes or reverts an update that a power cut interrupted.
  put "$REPO_DIR/pi/systemd/auxgoat-update-recover.service" "$UNIT_DIR/auxgoat-update-recover.service" 644 || UPDATER_OK=0
  put "$REPO_DIR/pi/systemd/auxgoat-update-verify.service" "$UNIT_DIR/auxgoat-update-verify.service" 644 || UPDATER_OK=0
  timeout 30 systemctl daemon-reload 2>&1 | sed 's/^/  /'
  timeout 20 systemctl enable auxgoat-update-recover.service auxgoat-update-verify.service >/dev/null 2>&1 \
    || { echo "  could not enable the update units"; UPDATER_OK=0; }
else
  echo "  the updater in this repo does not compile, or python3 is missing - not installing it"
fi
if [ -x "$UPDATER" ]; then
  timeout 20 "$UPDATER" status 2>&1 | sed 's/^/  /'
fi
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

# ---------------------------------------------------------------------------
# 0b. A phone that forgot this box must be able to pair again by itself.
#
# Sets JustWorksRepairing = always; see bt-repair-policy.sh for why and for the
# trade. BEFORE the units block on purpose: when the setting is new it restarts
# bluetoothd (ignore-dependencies, so not the listener), and bt-agent,
# bluealsa and bluealsa-aplay are then restarted below against the new daemon.
# A no-op on every run after the first.
# ---------------------------------------------------------------------------
echo "===== bluetooth: re-pairing policy ====="
if [ -f "$REPO_DIR/pi/scripts/bt-repair-policy.sh" ]; then
  timeout 60 bash "$REPO_DIR/pi/scripts/bt-repair-policy.sh" 2>&1
else
  echo "  bt-repair-policy.sh is missing from $REPO_DIR - skipped"
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
for u in $WATCHDOGS; do
  state="$(systemctl is-active "$u" 2>/dev/null || echo unknown)"
  printf '%-26s was %-10s %s\n' "$u" "$state" "$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)"
  if ! systemctl cat "$u" >/dev/null 2>&1; then
    echo "    (no such unit on this box — skipped)"
    continue
  fi
  timeout 20 systemctl enable "$u" >/dev/null 2>&1 || echo "    enable failed"
  if [ "$state" = "active" ]; then
    echo "    already running - left alone, so it keeps what it has counted"
  else
    timeout 30 systemctl restart "$u" >/dev/null 2>&1 || echo "    start failed"
    printf '    now %s\n' "$(systemctl is-active "$u" 2>/dev/null || echo unknown)"
  fi
done
echo

# ---------------------------------------------------------------------------
# 1b. The wired profile must never take DNS or the default route.
#
# On 2026-08-31 a plugged-in ethernet cable put a dead resolver FIRST in
# /etc/resolv.conf. Every lookup failed in 7ms, every probe read as dead wifi,
# and the watchdog counted toward a reboot for a fault the cable caused. It was
# fixed that night by hand, on that card only. This asserts the same three
# settings on every wired profile, every time, so a rebuilt box has them too.
#
# `modify` only - never `up`. Bouncing the wired link would cut off whoever is
# plugged into it, and the settings apply the next time the cable goes in.
# ---------------------------------------------------------------------------
echo "===== wired network profile ====="
if command -v nmcli >/dev/null 2>&1; then
  timeout 15 nmcli -t -f NAME,TYPE connection show 2>/dev/null | while IFS= read -r line; do
    [ "${line##*:}" = "802-3-ethernet" ] || continue
    name="${line%:*}"
    name="${name//\\:/:}"   # nmcli -t escapes a colon inside a field
    cur="$(timeout 10 nmcli -g ipv4.ignore-auto-dns,ipv6.ignore-auto-dns,ipv4.never-default \
             connection show "$name" 2>/dev/null | tr '\n' ' ')"
    if [ "$cur" = "yes yes yes " ]; then
      echo "  $name: already cannot take DNS or the default route"
    else
      timeout 15 nmcli connection modify "$name" ipv4.ignore-auto-dns yes \
        ipv6.ignore-auto-dns yes ipv4.never-default yes 2>&1 | sed 's/^/    /'
      echo "  $name: set (was: ${cur:-unreadable}) - applies when the cable is next plugged in"
    fi
  done
else
  echo "  nmcli is not installed"
fi
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
  timeout 10 hciconfig hci0 2>/dev/null | grep -q "UP RUNNING" || STILL_DOWN=1
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

# ---------------------------------------------------------------------------
# Software update, part 2 of 2: ask for one. LAST, so a slow fetch can never
# eat the time the repairs above needed.
#
# This only ASKS. `request` checks that the commit is newer than what is
# installed, on the branch this clone tracks, and (when the box has an
# allowed_signers file) signed - then schedules the work in a separate systemd
# unit that starts after this repair has finished and reported. Nothing about
# the running listener changes while this script is alive.
# ---------------------------------------------------------------------------
echo "===== software update: request ====="
WANT=0
case "$OTA_VIA_REPAIR" in
  always) WANT=1 ;;
  bootstrap)
    if [ "$UPDATER_OK" = "1" ] && [ "$(timeout 15 "$UPDATER" status --field commit 2>/dev/null)" = "unknown" ]; then
      WANT=1
    else
      echo "  not requested here: this box updates from the Admin screen (update software)"
    fi ;;
  *) echo "  not requested here (OTA_VIA_REPAIR=$OTA_VIA_REPAIR)" ;;
esac
UPDATE_REQUESTED=0
if [ "$WANT" = "1" ] && [ "$UPDATER_OK" = "1" ]; then
  UPDATE_REQUESTED=1
  timeout 75 "$UPDATER" request --via-repair 2>&1 | sed 's/^/  /'
  echo "  If that says 'scheduled': the speaker restarts its software in about a"
  echo "  minute. Press 'run repair' again afterwards to read the outcome here."
elif [ "$WANT" = "1" ]; then
  echo "  the updater could not be installed (see the top of this report)"
fi
echo

# ---------------------------------------------------------------------------
# Last: the follow-up that makes this ONE button (2026-11-13).
#
# Admin used to offer "try to fix it", "restart the app" and "reboot" for what
# is one situation - the speaker is not working - and left the operator to
# guess which. This is now "Fix the speaker", and it does all three in order:
#
#   1. everything above (Bluetooth, the services, routing)
#   2. a health check of what a phone needs to connect and be heard
#   3. healthy   -> restart the listener, to clear any stale state it holds
#      unhealthy -> reboot the box, the biggest fix there is
#
# Step 3 is SCHEDULED, never run inline, for the reason at the top of this
# file: the listener is the control channel and is running this script.
# systemd-run starts it in its own unit FOLLOWUP_DELAY_S after now, by which
# time this repair has finished and its report has gone up.
# ---------------------------------------------------------------------------
echo "===== health check and follow-up ====="
FOLLOWUP_DELAY_S="${AUXGOAT_FOLLOWUP_DELAY_S:-45}"
SYSTEMD_RUN="${AUXGOAT_SYSTEMD_RUN:-systemd-run}"
HEALTHY=1
for u in bluetooth bt-agent keep-discoverable bluealsa bluealsa-aplay; do
  if [ "$(systemctl is-active "$u" 2>/dev/null)" != "active" ]; then
    echo "  UNHEALTHY: $u is not running"
    HEALTHY=0
  fi
done
if command -v hciconfig >/dev/null 2>&1; then
  HCI_STATE="$(timeout 10 hciconfig hci0 2>/dev/null)"
  if ! printf '%s' "$HCI_STATE" | grep -q "UP RUNNING PSCAN ISCAN"; then
    echo "  UNHEALTHY: the adapter is not up and discoverable (want UP RUNNING PSCAN ISCAN)"
    HEALTHY=0
  fi
else
  BT_SHOW="$(timeout 10 bluetoothctl show 2>/dev/null)"
  if ! printf '%s' "$BT_SHOW" | grep -q "Powered: yes" \
     || ! printf '%s' "$BT_SHOW" | grep -q "Discoverable: yes"; then
    echo "  UNHEALTHY: the adapter is not powered and discoverable"
    HEALTHY=0
  fi
fi

# NEVER while a software update is pending or on trial. The updater restarts
# the listener itself and judges the new release by whether it keeps checking
# in; a restart or a reboot from here in the middle of that would be read as
# the release failing, and roll it back. Caught by test_auxgoat_update.py.
UPDATE_STATE="idle"
if [ "$UPDATER_OK" = "1" ]; then
  UPDATE_STATE="$(timeout 15 "$UPDATER" status --field state 2>/dev/null || echo idle)"
fi
STAMP="$(date +%s 2>/dev/null || echo 0)"
if [ "$UPDATE_REQUESTED" = "1" ] || { [ -n "$UPDATE_STATE" ] && [ "$UPDATE_STATE" != "idle" ]; }; then
  echo "  a software update is scheduled or running (state: ${UPDATE_STATE:-?}) -"
  echo "  no restart or reboot from here, so the update is not interrupted."
  [ "$HEALTHY" = "1" ] || echo "  If the speaker is still not working once the update is done, press Fix the speaker again."
elif [ "$HEALTHY" = "1" ]; then
  echo "  healthy - restarting the speaker app in ${FOLLOWUP_DELAY_S}s to clear any"
  echo "  stuck state (phones reconnect on their own; music stops briefly)."
  timeout 15 "$SYSTEMD_RUN" --unit="auxgoat-fix-followup-$STAMP" --collect \
    --on-active="$FOLLOWUP_DELAY_S" systemctl restart lockerroom-listener 2>&1 | sed 's/^/    /'
else
  echo "  still unhealthy after the repair - REBOOTING the speaker in ${FOLLOWUP_DELAY_S}s."
  echo "  It is offline for one to three minutes; press 'Get a report' after that."
  timeout 15 "$SYSTEMD_RUN" --unit="auxgoat-fix-followup-$STAMP" --collect \
    --on-active="$FOLLOWUP_DELAY_S" systemctl reboot 2>&1 | sed 's/^/    /'
fi
echo

echo "repair finished. Press 'Get a report' in a couple of minutes to see the box's state now."
