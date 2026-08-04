#!/usr/bin/env bash
# Push the listener package to the Pi and restart the service.
# Usage: pi/scripts/deploy.sh [pi-host]
set -euo pipefail

# 192.168.1.6 was the old home network and is dead. The dependable route is
# USB-C ethernet with macOS Internet Sharing, which hands the Pi 192.168.2.2.
# Over HCGuest wifi the Pi is NOT reachable at all - TCP/22 is filtered
# between guest clients - so this is the only way in. See docs/STATE.md.
PI_HOST="${1:-pi@192.168.2.2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Deploying to ${PI_HOST}..."
scp -q -r "${REPO_ROOT}/pi/lockerroom" "${PI_HOST}:/tmp/lockerroom_pkg"
scp -q "${REPO_ROOT}/pi/systemd/lockerroom-listener.service" "${PI_HOST}:/tmp/lockerroom-listener.service"

ssh "${PI_HOST}" bash -s <<'REMOTE'
set -euo pipefail
sudo rm -rf /opt/lockerroom/lockerroom
sudo mv /tmp/lockerroom_pkg /opt/lockerroom/lockerroom
sudo find /opt/lockerroom/lockerroom -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
sudo mv /tmp/lockerroom-listener.service /etc/systemd/system/lockerroom-listener.service
sudo systemctl daemon-reload
sudo systemctl restart lockerroom-listener
sleep 3
systemctl is-active lockerroom-listener
REMOTE

echo "Deployed."
