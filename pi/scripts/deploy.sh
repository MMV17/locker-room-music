#!/usr/bin/env bash
# Push the listener package to the Pi and restart the service.
# Usage: pi/scripts/deploy.sh [pi-host]
set -euo pipefail

# Pass the host explicitly. There is no good default any more:
#
#   pi/scripts/deploy.sh pi@192.168.1.6     # home wifi (alive again as of
#                                           # 2026-08-09, despite older notes)
#   pi/scripts/deploy.sh pi@192.168.2.2     # USB-C ethernet + Internet Sharing
#
# 192.168.2.2 used to be the default, and that is now actively wrong to reach
# for first: the cable creates a `default via ... dev eth0 metric 100` route
# that beats wlan0, and if Internet Sharing is not actually sharing to that
# adapter the Pi goes silent while looking perfectly healthy. That cost an hour
# on 2026-08-09. Prefer wifi; use the cable only when wifi genuinely cannot
# reach it, and unplug it afterwards.
#
# Over HCGuest the Pi is NOT reachable at all - TCP/22 is filtered between
# guest clients - so on campus the cable is the only way in. See docs/STATE.md,
# and note there are TWO Pis: identify by MAC (e4:5f:01:*), never by
# raspberrypi.local, which resolves to the other one.
if [ $# -lt 1 ]; then
  echo "usage: $0 pi@<host>   (e.g. pi@192.168.1.6)" >&2
  exit 2
fi
PI_HOST="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Deploying to ${PI_HOST}..."
scp -q -r "${REPO_ROOT}/pi/lockerroom" "${PI_HOST}:/tmp/lockerroom_pkg"
scp -q "${REPO_ROOT}/pi/systemd/lockerroom-listener.service" "${PI_HOST}:/tmp/lockerroom-listener.service"
scp -q "${REPO_ROOT}/pi/systemd/lockerroom-netwatch.service" "${PI_HOST}:/tmp/lockerroom-netwatch.service"
scp -q "${REPO_ROOT}/pi/systemd/bluealsa-aplay-aux.conf" "${PI_HOST}:/tmp/bluealsa-aplay-aux.conf"

ssh "${PI_HOST}" bash -s <<'REMOTE'
set -euo pipefail
sudo rm -rf /opt/lockerroom/lockerroom
sudo mv /tmp/lockerroom_pkg /opt/lockerroom/lockerroom
sudo find /opt/lockerroom/lockerroom -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
sudo mv /tmp/lockerroom-listener.service /etc/systemd/system/lockerroom-listener.service
sudo mv /tmp/lockerroom-netwatch.service /etc/systemd/system/lockerroom-netwatch.service
# Teaches bluealsa-aplay to play one phone instead of mixing every connected
# one. Restarted below so a changed drop-in actually takes effect; the listener
# re-points it within a second of the next connection either way.
sudo mkdir -p /etc/systemd/system/bluealsa-aplay.service.d
sudo mv /tmp/bluealsa-aplay-aux.conf /etc/systemd/system/bluealsa-aplay.service.d/aux.conf
sudo systemctl daemon-reload
sudo systemctl restart bluealsa-aplay
sudo systemctl restart lockerroom-listener
# `enable` so it survives an unattended reboot, which is exactly when nobody is
# here to start it — and `restart` SEPARATELY, which is the part that matters.
#
# This used to be `enable --now`, and that silently never picked up new code:
# --now only STARTS a stopped unit, so on any box where the watchdog was
# already running the deploy copied new files into /opt/lockerroom and left the
# old process running. Caught 2026-08-09 when a freshly deployed fix did
# nothing and the journal still showed a PID from 49 minutes earlier.
sudo systemctl enable lockerroom-netwatch
sudo systemctl restart lockerroom-netwatch
sleep 3
systemctl is-active lockerroom-listener
systemctl is-active lockerroom-netwatch
REMOTE

echo "Deployed."
