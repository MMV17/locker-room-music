#!/bin/bash
# Re-asserts discoverable/pairable on a loop. BlueZ sometimes drops
# discoverability after a connect/disconnect cycle even with
# DiscoverableTimeout=0 in main.conf, which would make the speaker
# invisible to the next DJ. Cheap enough to just poll.
set -uo pipefail

while true; do
  bluetoothctl power on >/dev/null 2>&1
  bluetoothctl discoverable on >/dev/null 2>&1
  bluetoothctl pairable on >/dev/null 2>&1
  sleep 5
done
