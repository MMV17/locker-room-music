#!/usr/bin/env bash
# Read-only diagnostic dump, for reading on a phone over the 443 beacon.
#
# WHY THIS EXISTS, precisely. On 2026-09-20 the speaker stopped accepting
# Bluetooth pairings. The box was online and beaconing, the controller was
# healthy (a scan found 4 devices), the listener took commands, and nobody was
# connected — the adapter simply was not ADVERTISING, so no phone could see
# `AuxGoat 0001`. Cause was almost certainly `keep-discoverable` and/or
# `bt-agent` not running.
#
# `report-status` could not have found that. It checks lockerroom-listener,
# bluetooth and bluealsa — none of which were the broken units — and it never
# looks at `hciconfig hci0`, whose PSCAN/ISCAN flags ARE the answer. So this
# script collects the things that were missing, and it collects them for every
# unit rather than the three somebody happened to pick.
#
# IS-ENABLED MATTERS AS MUCH AS IS-ACTIVE. Units coming up disabled after a
# reboot has bitten this project three times: bt-agent and keep-discoverable
# were missing from every deploy until 2026-08-19, lockerroom-listener was
# never enabled until the same day, and lockerroom-netwatch deploys were silent
# no-ops until 2026-08-09. An active-but-disabled unit is a box that works
# perfectly until the next power cut.
#
# READ-ONLY. Nothing here writes, restarts, or reconfigures anything, which is
# what makes it safe to run while a song is playing — unlike a scan, which
# occupies the radio, or a repair, which restarts services. audio-check.sh is
# read-only too; deploy.sh relies on that same property.
#
# Every section is bounded by `timeout`, so one wedged binary costs its own
# seconds rather than the whole dump. A section that times out says so.
set -uo pipefail   # deliberately NOT -e: a failing section must not truncate
                   # the report. A dump that stops early is the failure mode
                   # this whole feature exists to stop repeating.

UNITS="bt-agent keep-discoverable lockerroom-btwatch lockerroom-listener \
lockerroom-netwatch lockerroom-audio-route bluetooth bluealsa bluealsa-aplay"

section() { printf '\n===== %s =====\n' "$1"; }

# Run a command with a bound, and say so when it does not finish. `|| true` on
# every call: see the note about -e above.
run() {
  local secs="$1"; shift
  timeout "$secs" "$@" 2>&1 || {
    local rc=$?
    [ "$rc" = "124" ] && echo "(timed out after ${secs}s: $*)" || echo "(exit $rc: $*)"
  }
}

echo "AuxGoat full report"
echo "host:      $(hostname 2>/dev/null)"
echo "collected: $(date -Is 2>/dev/null || date 2>/dev/null)"
echo "uptime:    $(uptime 2>/dev/null)"

# ---------------------------------------------------------------------------
# Units. Both states, for every unit — the whole point.
# ---------------------------------------------------------------------------
section "UNITS (active / enabled)"
printf '%-23s %-13s %s\n' "UNIT" "ACTIVE" "ENABLED"
for u in $UNITS; do
  # `systemctl is-active` exits NON-ZERO for every state that is not active -
  # including "deactivating", "failed" and "inactive", which are the states
  # this table exists to show. A naive `|| echo unknown` therefore appends a
  # second word to exactly the rows that matter, and the table stops lining up
  # precisely when something is wrong. Substitute only when there is NO answer.
  act="$(systemctl is-active "$u" 2>/dev/null)"; [ -n "$act" ] || act=unknown
  ena="$(systemctl is-enabled "$u" 2>/dev/null)"; [ -n "$ena" ] || ena=unknown
  printf '%-23s %-13s %s\n' "$u" "$act" "$ena"
done

# ---------------------------------------------------------------------------
# The adapter. This section is the reason the script exists.
# ---------------------------------------------------------------------------
section "BLUETOOTH ADAPTER"
if command -v hciconfig >/dev/null 2>&1; then
  run 10 hciconfig hci0
  echo
  echo "READ THIS LINE: 'UP RUNNING PSCAN ISCAN' is a discoverable box."
  echo "  UP RUNNING with NO PSCAN/ISCAN is the 2026-09-20 fault exactly — the"
  echo "  controller is healthy and no phone can see it. keep-discoverable"
  echo "  and/or bt-agent are the units to look at, and run-repair restarts them."
else
  # hciconfig is deprecated in BlueZ and may not be installed on a rebuilt box.
  # bluetoothctl carries the same two facts under different names.
  echo "(hciconfig is not installed — it is deprecated in BlueZ and a rebuilt"
  echo " box may not have it. bluetoothctl below carries the same two facts.)"
  echo
  echo "READ THESE LINES: 'Discoverable: yes' and 'Pairable: yes' are the"
  echo "  equivalent of PSCAN/ISCAN — and 'Discoverable: no' on a powered"
  echo "  adapter is the 2026-09-20 fault. run-repair restarts the units that"
  echo "  set them (keep-discoverable, bt-agent)."
fi
echo
run 10 bluetoothctl show

# ---------------------------------------------------------------------------
# Audio. audio-check.sh already walks the whole path and is read-only.
# ---------------------------------------------------------------------------
section "AUDIO PATH (audio-check.sh)"
if [ -x /usr/local/bin/audio-check.sh ]; then
  run 60 /usr/local/bin/audio-check.sh
else
  echo "(/usr/local/bin/audio-check.sh is missing — this box predates it, or a"
  echo " deploy did not land. It ships on every deploy; see deploy.sh.)"
fi

# ---------------------------------------------------------------------------
# Network. resolv.conf is here because of the ethernet DNS trap: the USB-C
# cable used to poison DNS and make healthy wifi look dead while netwatch
# counted toward a reboot. `iw` is NOT installed on this box — nmcli and
# ip route are what work.
# ---------------------------------------------------------------------------
section "NETWORK"
run 15 nmcli -t -f NAME,DEVICE,TYPE,STATE connection show --active
echo
run 15 nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status
echo
run 10 ip route
echo
echo "--- /etc/resolv.conf ---"
run 5 cat /etc/resolv.conf

# ---------------------------------------------------------------------------
# Kernel and journals.
# ---------------------------------------------------------------------------
section "DMESG (bluetooth)"
run 15 sh -c "dmesg 2>/dev/null | grep -i bluetooth | tail -n 25"

section "JOURNAL (recent, per unit)"
for u in $UNITS; do
  echo "--- $u ---"
  run 10 journalctl -u "$u" -n 12 --no-pager -o short-iso
  echo
done

echo
echo "===== END OF REPORT ====="
