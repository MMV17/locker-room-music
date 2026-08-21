#!/usr/bin/env bash
# Why is the room silent? Run this ON THE PI.
#
#   sudo bash /usr/local/bin/audio-check.sh
#   sudo bash /usr/local/bin/audio-check.sh --tone
#
# Written 2026-08-21, after a freshly provisioned box paired as AuxGoat, showed
# AVRCP track metadata on the site, beaconed 200 OK — and played nothing out of
# the jack. Every unit was green. That combination has exactly one shape: the
# Bluetooth half is fine and the ALSA half is pointed somewhere that is not the
# 3.5mm jack, so nothing in `systemctl status` can ever show it.
#
# This walks the path in the order it breaks and ends with a verdict. It only
# reads state; it changes nothing. `provision.sh` is what fixes things.
#
# --tone plays three seconds of 440Hz straight at the ALSA default device,
# which is the single test that separates "the analog side is broken" from
# "Bluetooth is not reaching the analog side". DO NOT run --tone in a room with
# people in it.
set -uo pipefail   # deliberately NOT -e: a diagnostic must survive its own
                   # failing checks and still print the verdict at the bottom.

TONE=0
[ "${1:-}" = "--tone" ] && TONE=1

PROBLEMS=()
problem() { PROBLEMS+=("$1"); }

hr() { printf '\n== %s ==\n' "$1"; }

# The ALSA id (not index) of the Pi's own analog output. Index is useless here:
# it is whatever the kernel enumerated first and it moves between boots and
# images, which is the whole bug this script was written for.
analog_card() {
  sed -n 's/^ *[0-9]* \[\([^]]*\)\].*bcm2835.*/\1/p' /proc/asound/cards 2>/dev/null \
    | head -1 | tr -d ' '
}
card_index() {
  sed -n "s/^ *\([0-9]*\) \[$1 *\].*/\1/p" /proc/asound/cards 2>/dev/null | head -1
}

hr "sound cards the kernel knows about"
if [ -r /proc/asound/cards ]; then
  cat /proc/asound/cards
else
  echo "no /proc/asound/cards — no sound support in the running kernel at all"
fi
ANALOG="$(analog_card)"
if [ -n "$ANALOG" ]; then
  echo "analog (bcm2835) card id: $ANALOG   index: $(card_index "$ANALOG")"
else
  echo "NO bcm2835 card present."
  problem "The Pi's analog output does not exist as an ALSA card. Either
     dtparam=audio=on is missing from config.txt, or it was added and the box
     has not rebooted since. Nothing downstream can work until this is fixed."
fi

hr "analog audio enabled in firmware config"
BOOT_CFG=""
for c in /boot/firmware/config.txt /boot/config.txt; do
  [ -f "$c" ] && { BOOT_CFG="$c"; break; }
done
if [ -z "$BOOT_CFG" ]; then
  echo "no config.txt found at either path"
  problem "No config.txt found; analog audio cannot be asserted."
elif grep -qE '^[[:space:]]*dtparam=audio=on' "$BOOT_CFG"; then
  echo "$BOOT_CFG: dtparam=audio=on   (set)"
  # Being set but inside a conditional section that does not match this board
  # is the non-obvious way this passes a grep and still does nothing.
  awk '/^\[/{sec=$0} /^[[:space:]]*dtparam=audio=on/{print "   ...under section: " (sec==""?"[none/global]":sec)}' "$BOOT_CFG"
else
  echo "$BOOT_CFG: dtparam=audio=on is NOT set"
  problem "dtparam=audio=on missing from $BOOT_CFG. Re-run provision.sh, then
     REBOOT — the firmware only reads this file at boot."
fi

hr "where the ALSA 'default' device actually goes"
# This is the section that matters. bluealsa-aplay is started with no -D (see
# pi/systemd/bluealsa-aplay-aux.conf, and the note in STATE.md about never
# naming a device on the main path), so `default` IS the audio path. Untouched,
# `default` is card 0 — and with the KMS video driver loaded, card 0 is
# routinely a vc4-hdmi card. A completely healthy box then plays the whole set
# into an HDMI port with nothing plugged into it.
if [ -f /etc/asound.conf ]; then
  echo "/etc/asound.conf:"
  sed 's/^/   /' /etc/asound.conf
  NAMED="$(sed -n 's/.*card[[:space:]]*"\([^"]*\)".*/\1/p' /etc/asound.conf | head -1)"
  if [ -n "$NAMED" ]; then
    if grep -qE "^ *[0-9]+ \[$NAMED *\]" /proc/asound/cards 2>/dev/null; then
      echo "   -> default is pinned to card \"$NAMED\", which exists. Good."
    else
      problem "/etc/asound.conf pins the default device to card \"$NAMED\", and
     no such card exists. Every playback open fails and the room is silent."
    fi
  fi
else
  echo "no /etc/asound.conf — the ALSA default is card 0, whatever card 0 is."
  CARD0="$(sed -n 's/^ *0 \[\([^]]*\)\].*/\1/p' /proc/asound/cards 2>/dev/null | tr -d ' ')"
  echo "card 0 is: ${CARD0:-<none>}"
  if [ -n "$ANALOG" ] && [ "$CARD0" != "$ANALOG" ]; then
    problem "THIS IS ALMOST CERTAINLY IT. There is no /etc/asound.conf, so the
     ALSA default is card 0 = \"$CARD0\", but the 3.5mm jack is \"$ANALOG\".
     bluealsa-aplay is therefore playing into $CARD0 (an HDMI port with nothing
     in it) while Bluetooth, AVRCP and the website all work perfectly.
     Fix: re-run provision.sh, which writes /etc/asound.conf pinning the
     default to the analog card BY NAME."
  fi
fi
[ -f /root/.asoundrc ] && { echo "NOTE: /root/.asoundrc exists and overrides the above for root:"; sed 's/^/   /' /root/.asoundrc; }

hr "output volume and mute"
if [ -n "$ANALOG" ]; then
  amixer -c "$ANALOG" 2>/dev/null | sed 's/^/   /'
  # A fresh image has no saved ALSA state, so the level is whatever the driver
  # defaulted to, and nothing has ever asserted it on this project.
  if amixer -c "$ANALOG" 2>/dev/null | grep -q '\[off\]'; then
    problem "The analog output is MUTED. Re-run provision.sh, which unmutes it
     and saves the state so a reboot keeps it."
  fi
else
  echo "skipped — no analog card"
fi
if [ -f /var/lib/alsa/asound.state ]; then
  echo "   saved mixer state: /var/lib/alsa/asound.state (restored at boot)"
else
  echo "   no /var/lib/alsa/asound.state — nothing restores the volume at boot"
  problem "No saved ALSA mixer state, so volume and mute are not preserved
     across a reboot. provision.sh now runs alsactl store."
fi

hr "the units that carry the audio"
for u in bluetooth bluealsa bluealsa-aplay lockerroom-listener; do
  printf '%-22s %-10s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)" "$(systemctl is-enabled "$u" 2>/dev/null)"
  [ "$(systemctl is-active "$u" 2>/dev/null)" != "active" ] && \
    problem "$u is not active. journalctl -u $u -n 50"
done
echo
echo "bluealsa-aplay is really being run as:"
systemctl show -p ExecStart --value bluealsa-aplay 2>/dev/null | sed 's/^/   /'

hr "the aux allowlist (which phone is allowed to be heard)"
# A MAC here that is not the phone actually playing is silence with every unit
# green. It should be ABSENT whenever fewer than two phones are connected —
# see SessionManager._aux_target.
if [ -f /run/lockerroom/aux.env ]; then
  sed 's/^/   /' /run/lockerroom/aux.env
  MAC="$(sed -n 's/^AUX_MAC=//p' /run/lockerroom/aux.env | tr -d ' ')"
  if [ -n "$MAC" ]; then
    echo "   -> only $MAC is audible right now."
    problem "The speaker is filtered to $MAC. If that is not the phone you are
     playing from, that phone is muted by design. Disconnect the other phone,
     or check the listener log for who holds the aux."
  fi
else
  echo "   no /run/lockerroom/aux.env — no filter, anything connected plays."
fi

hr "A2DP streams bluealsa can see"
timeout 5 bluealsa-aplay -L 2>&1 | sed 's/^/   /' || echo "   (bluealsa-aplay -L failed)"
echo
echo "connected devices:"
timeout 5 bluetoothctl devices Connected 2>/dev/null | sed 's/^/   /' || echo "   (bluetoothctl unavailable)"

hr "recent bluealsa-aplay log"
journalctl -u bluealsa-aplay -n 25 --no-pager 2>/dev/null | sed 's/^/   /'

if [ "$TONE" = "1" ]; then
  hr "test tone (440Hz, straight at the ALSA default)"
  echo "If you hear this, the analog path is fine and the fault is in Bluetooth."
  echo "If you do not, the fault is everything above and Bluetooth is innocent."
  speaker-test -D default -t sine -f 440 -c 2 -l 1 2>&1 | tail -5 | sed 's/^/   /'
fi

hr "verdict"
if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  echo "Nothing found. The audio path looks correct."
  echo "Next: re-run with --tone to prove the analog side end to end."
else
  i=1
  for p in "${PROBLEMS[@]}"; do
    echo "$i. $p"
    i=$((i+1))
  done
fi
echo
