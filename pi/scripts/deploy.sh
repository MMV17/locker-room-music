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
# These two were installed by hand when the first box was built, and were
# therefore missing from every deploy — which only showed up when a card died
# and the rebuild produced a speaker that would not pair or stay visible.
# Shipping them means a provisioned box plus one deploy is a complete speaker.
scp -q "${REPO_ROOT}/pi/systemd/bt-agent.service" "${PI_HOST}:/tmp/bt-agent.service"
scp -q "${REPO_ROOT}/pi/systemd/keep-discoverable.service" "${PI_HOST}:/tmp/keep-discoverable.service"
scp -q "${REPO_ROOT}/pi/scripts/keep-discoverable.sh" "${PI_HOST}:/tmp/keep-discoverable.sh"
# The read-only audio diagnostic. Shipped on every deploy because the box it
# is needed on is the one you cannot easily reach, and because a speaker
# provisioned before 2026-08-21 does not have it.
scp -q "${REPO_ROOT}/pi/scripts/audio-check.sh" "${PI_HOST}:/tmp/audio-check.sh"
# Automatic output routing: USB speaker if one is plugged in, else the 3.5mm
# jack. The udev rule is what makes plugging a cable in take effect at once;
# the unit also runs at boot so a speaker already connected at power-on works.
scp -q "${REPO_ROOT}/pi/scripts/audio-route.sh" "${PI_HOST}:/tmp/audio-route.sh"
scp -q "${REPO_ROOT}/pi/systemd/lockerroom-audio-route.service" "${PI_HOST}:/tmp/lockerroom-audio-route.service"
scp -q "${REPO_ROOT}/pi/systemd/99-lockerroom-audio.rules" "${PI_HOST}:/tmp/99-lockerroom-audio.rules"
# The Bluetooth controller watchdog. A wedged controller is a dead speaker with
# every unit green, and the three obvious recovery commands all fail — see
# btwatch.sh. Shipped on every deploy because the box that needs it is the one
# you cannot reach.
scp -q "${REPO_ROOT}/pi/scripts/btwatch.sh" "${PI_HOST}:/tmp/btwatch.sh"
scp -q "${REPO_ROOT}/pi/systemd/lockerroom-btwatch.service" "${PI_HOST}:/tmp/lockerroom-btwatch.service"

ssh "${PI_HOST}" bash -s <<'REMOTE'
set -euo pipefail
sudo rm -rf /opt/lockerroom/lockerroom
sudo mv /tmp/lockerroom_pkg /opt/lockerroom/lockerroom
sudo find /opt/lockerroom/lockerroom -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
sudo mv /tmp/lockerroom-listener.service /etc/systemd/system/lockerroom-listener.service
sudo mv /tmp/lockerroom-netwatch.service /etc/systemd/system/lockerroom-netwatch.service
# Auto-accept pairing, and stay visible to the next DJ.
sudo mv /tmp/bt-agent.service /etc/systemd/system/bt-agent.service
sudo mv /tmp/keep-discoverable.service /etc/systemd/system/keep-discoverable.service
sudo install -m 755 /tmp/keep-discoverable.sh /usr/local/bin/keep-discoverable.sh
sudo install -m 755 /tmp/audio-check.sh /usr/local/bin/audio-check.sh
sudo install -m 755 /tmp/audio-route.sh /usr/local/bin/audio-route.sh
sudo install -m 755 /tmp/btwatch.sh /usr/local/bin/btwatch.sh
sudo mv /tmp/lockerroom-btwatch.service /etc/systemd/system/lockerroom-btwatch.service
sudo mv /tmp/lockerroom-audio-route.service /etc/systemd/system/lockerroom-audio-route.service
sudo mv /tmp/99-lockerroom-audio.rules /etc/udev/rules.d/99-lockerroom-audio.rules
# udev caches its rules; without this the rule sits on disk doing nothing until
# the next reboot, and plugging a cable in appears to be silently ignored.
sudo udevadm control --reload-rules
# Teaches bluealsa-aplay to play one phone instead of mixing every connected
# one. Restarted below so a changed drop-in actually takes effect; the listener
# re-points it within a second of the next connection either way.
sudo mkdir -p /etc/systemd/system/bluealsa-aplay.service.d
sudo mv /tmp/bluealsa-aplay-aux.conf /etc/systemd/system/bluealsa-aplay.service.d/aux.conf
sudo systemctl daemon-reload
# Route the audio BEFORE restarting the player, so the restart below lands on
# the right card either way. `enable` so a speaker plugged in before power-on
# is picked up at boot rather than depending on coldplug uevent replay ordering
# beating bluealsa-aplay. It exits 1 when there is no card at all (it refuses to
# name one that does not exist), and the audio verification further down is what
# reports that properly — so it must not abort the deploy here.
echo "== audio out: route =="
sudo systemctl enable lockerroom-audio-route
sudo /usr/local/bin/audio-route.sh || true
sudo systemctl restart bluealsa-aplay
# `enable` the listener too. It was missing here until 2026-08-19 and had only
# ever been enabled BY HAND on the first box — the same omission that left
# bt-agent and keep-discoverable out of every deploy, third time now, and this
# time on the core service. A box that is deployed but not enabled plays audio
# perfectly and records NOTHING after the next power cut, with every unit that
# anyone thinks to check still green. That is the silent failure stage 4 of the
# runbook exists to prevent, arriving by a different road.
sudo systemctl enable lockerroom-listener
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
# Pairing and visibility. `enable` so they survive a reboot, `restart` because
# --now only starts a stopped unit and would silently skip a changed one — the
# same trap that made every netwatch deploy a no-op until 2026-08-09.
sudo systemctl enable bt-agent keep-discoverable
sudo systemctl restart bt-agent keep-discoverable
# The controller watchdog. enable + restart separately, same reason as above:
# --now only starts a stopped unit and would silently skip a changed one.
sudo systemctl enable lockerroom-btwatch
sudo systemctl restart lockerroom-btwatch
sleep 3
systemctl is-active lockerroom-listener
systemctl is-active lockerroom-netwatch
systemctl is-active bt-agent
systemctl is-active keep-discoverable
systemctl is-active lockerroom-btwatch

# Audio output drift check. This VERIFICATION is read-only; it diagnoses and
# never fixes.
#
# The "deploy never writes /etc/asound.conf at all" rule was relaxed on
# 2026-08-28, when the routing step above started calling audio-route.sh. The
# reason for the original rule still stands and is still honoured: a deploy must
# not stomp a hand-written config on a box with a DAC. audio-route.sh checks for
# its own "# managed by lockerroom" marker and leaves an unmarked file strictly
# alone, which is what makes it safe to run here. Do not replace that call with
# anything that writes unconditionally.
#
# Why this belongs in a deploy and not only in provisioning: ALSA card NUMBERS
# are handed out in kernel enumeration order, so a kernel or firmware update can
# renumber them and silence a box that has worked for months with nothing on
# disk having changed. That box gets deploys, not provisions. See "CONFIRMED
# (2026-08-22)" in docs/STATE.md.
#
# Never exits non-zero: the code is already deployed by this point and aborting
# here would strand the box mid-deploy for a fault that needs a human anyway.
#
# Verified against the SELECTED card, not the analog one. Since 2026-08-28 a USB
# speaker correctly takes the default away from the jack, and asserting on the
# analog card would print "THIS BOX WILL BE SILENT" on a perfectly healthy box —
# lying in the most alarming possible direction, on the one check that exists
# because nobody can tell silence from health by looking at the units.
echo "== audio out: verify =="
AUDIO_OK=1
# What audio-route.sh actually chose. Falls back to finding the analog card
# directly, so a box that has not had a routing deploy yet still verifies.
SELECTED_CARD="$(sed -n 's/^[a-z]*://p' /run/lockerroom/audio-out 2>/dev/null | head -1 || true)"
if [ -n "$SELECTED_CARD" ]; then
  echo "   routed to: $(cat /run/lockerroom/audio-out)"
else
  SELECTED_CARD="$(sed -n 's/^ *[0-9]* \[\([^]]*\)\].*bcm2835.*/\1/p' /proc/asound/cards 2>/dev/null | head -1 | tr -d ' ' || true)"
  echo "   no /run/lockerroom/audio-out — falling back to the analog card"
fi
ANALOG_IDX=""
if [ -n "$SELECTED_CARD" ]; then
  ANALOG_IDX="$(sed -n "s/^ *\([0-9]*\) \[$SELECTED_CARD *\].*/\1/p" /proc/asound/cards 2>/dev/null | head -1 || true)"
fi
if [ -z "$SELECTED_CARD" ] || [ -z "$ANALOG_IDX" ]; then
  echo "   WARNING: no usable output card present — cannot verify."
  AUDIO_OK=0
elif ! command -v aplay >/dev/null 2>&1; then
  echo "   WARNING: aplay is not installed — cannot verify."
  AUDIO_OK=0
else
  APERR="$(mktemp)"
  APRC=0
  # /dev/zero is silence: safe to run on a live box with people in the room.
  aplay -D default -f S16_LE -r 48000 -c 2 -d 2 /dev/zero >/dev/null 2>"$APERR" &
  APID=$!
  sleep 1
  PCM_STATE="$(sed -n 's/^state: //p' "/proc/asound/card$ANALOG_IDX/pcm0p/sub0/status" 2>/dev/null || true)"
  wait "$APID" || APRC=$?
  if [ "$APRC" != "0" ] && grep -qi 'busy' "$APERR" 2>/dev/null; then
    # NOT a failure, and getting this wrong would cry wolf on every deploy done
    # while a song is playing. Our asound.conf is plug->hw, which does not mix,
    # so a live bluealsa-aplay legitimately holds the device. Something holding
    # the default open is evidence the path is wired up, not that it is broken.
    echo "   default is BUSY — bluealsa-aplay is holding it. Path is live; not a fault."
  elif [ "$APRC" != "0" ]; then
    echo "   ERROR: the ALSA default will not open:"
    sed 's/^/     /' "$APERR" || true
    echo "     -524 (ENOTSUPP) means the default is a vc4-hdmi card, not the jack."
    AUDIO_OK=0
  elif [ "${PCM_STATE:-}" = "RUNNING" ]; then
    echo "   VERIFIED: the default opened card $ANALOG_IDX (\"$SELECTED_CARD\") and ran"
  else
    echo "   ERROR: the default opened, but card $ANALOG_IDX (\"$SELECTED_CARD\")"
    echo "     never started — something ELSE is the ALSA default."
    AUDIO_OK=0
  fi
  rm -f "$APERR" || true
fi
if [ "$AUDIO_OK" = "0" ]; then
  echo
  echo "   !! THIS BOX WILL BE SILENT. The code deployed fine; the audio path"
  echo "      did not. Every service above can be green and the room still"
  echo "      hears nothing — that is the whole failure mode this catches."
  echo "      Fix with:  sudo bash provision.sh     Diagnose:  sudo audio-check.sh"
fi
REMOTE

echo "Deployed."
