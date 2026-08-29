#!/usr/bin/env bash
# Point the ALSA default at whichever output is actually plugged in.
#
#   sudo /usr/local/bin/audio-route.sh              # normal: udev, boot, deploy
#   sudo /usr/local/bin/audio-route.sh --bootstrap  # provision.sh, pre-reboot
#
# Written 2026-08-28. Speakers disagree about how they take a wired input: some
# have only a 3.5mm aux jack, and some — the JBL Charge 6 among them — have only
# USB-C digital audio and no analog input at all. We carry both cables. This
# makes the box follow the cable instead of needing /etc/asound.conf edited by
# hand on a Pi that campus makes hard to reach.
#
# THE RULE IS ONE-SIDED, AND NOT BY CHOICE:
#
#   if a USB playback card is present -> use it
#   otherwise                         -> the analog jack
#
# The Pi 4's 3.5mm jack has NO jack-detect pin and exposes no jack kcontrol, so
# nothing on this box can tell whether a cable is in it. "Detect which one is
# plugged in" is not implementable for the jack, only for USB. The jack is
# therefore a FALLBACK, not a detection — which is also the safe direction, and
# matches the rest of this project: every failure path lands on the analog card.
#
# Sending audio to BOTH outputs was considered and rejected: ALSA's `multi`
# plugin opens all of its slaves or none, so an unplugged USB cable would take
# the working jack down with it — silence on every output with all units green,
# the exact failure this project keeps hitting. See the design doc at
# docs/superpowers/specs/2026-08-28-audio-output-routing-design.md.
#
# This script is THE ONLY WRITER of /etc/asound.conf. provision.sh calls it
# rather than writing its own; that is deliberate, so the two cannot drift.
set -uo pipefail   # deliberately NOT -e: this runs from udev on a hot path and
                   # must reach its own error handling rather than dying inside
                   # a subshell and leaving the box on a stale config.

# Overridable so pytest can drive this against a fake card tree. The fake goes
# through OUR variables and not ALSA_CONFIG_PATH, which docs/STATE.md records
# as having silently not worked — the system alsa.conf includes
# /etc/asound.conf itself, so pointing ALSA elsewhere does not unconfigure it.
ASOUND_ROOT="${ASOUND_ROOT:-/proc/asound}"
ASOUND_CONF="${ASOUND_CONF:-/etc/asound.conf}"
STATE_FILE="${STATE_FILE:-/run/lockerroom/audio-out}"
RESTART_CMD="${RESTART_CMD:-systemctl restart bluealsa-aplay}"

# Substring, not the whole line. Boxes provisioned before today carry
# "# managed by lockerroom provision.sh", which contains this and is therefore
# adopted automatically. A hand-written config for a real DAC contains neither
# and is left alone.
MARK="# managed by lockerroom"

BOOTSTRAP=0
[ "${1:-}" = "--bootstrap" ] && BOOTSTRAP=1

say() { printf '   %s\n' "$*"; }
die() { printf '   ERROR: %s\n' "$*" >&2; exit 1; }

# "<index> <id>" per card, lowest index first. Card ids never contain spaces,
# so the id is captured without the padding /proc/asound/cards puts inside the
# brackets.
card_list() {
  sed -n 's/^ *\([0-9][0-9]*\) \[\([^] ]*\) *\].*/\1 \2/p' "$ASOUND_ROOT/cards" 2>/dev/null | sort -n
}

# A card counts as a USB output only with BOTH of these. Matching the string
# "USB" in /proc/asound/cards would be matching a NAME, and names lie; usbid is
# the kernel's own answer. The playback check is what stops a USB microphone or
# a webcam from capturing the audio path.
is_usb()      { [ -f "$ASOUND_ROOT/card$1/usbid" ]; }
has_playback() { compgen -G "$ASOUND_ROOT/card$1/pcm*p" >/dev/null 2>&1; }

usb_card() {
  local idx id
  while read -r idx id; do
    is_usb "$idx" && has_playback "$idx" && { printf '%s\n' "$id"; return 0; }
  done < <(card_list)
  return 1
}

# A USB card that has not grown its playback PCM yet. The `card` uevent can beat
# the pcm subdevices into existence by a few hundred milliseconds, and without
# retrying on this a freshly plugged speaker is occasionally misread as "no
# playback" and ignored until the next event that never comes.
usb_pending() {
  local idx id
  while read -r idx id; do
    is_usb "$idx" && ! has_playback "$idx" && return 0
  done < <(card_list)
  return 1
}

analog_card() {
  sed -n 's/^ *[0-9]* \[\([^] ]*\) *\].*bcm2835.*/\1/p' "$ASOUND_ROOT/cards" 2>/dev/null | head -1
}

# Echoes "<kind> <card-id>"; nonzero if there is no usable output at all.
select_target() {
  local attempt usb analog
  for attempt in 1 2 3; do
    usb="$(usb_card)" && { printf 'usb %s\n' "$usb"; return 0; }
    if [ "$attempt" -lt 3 ] && usb_pending; then
      sleep 1
      continue
    fi
    break
  done
  analog="$(analog_card)"
  [ -n "$analog" ] && { printf 'jack %s\n' "$analog"; return 0; }
  return 1
}

configured_card() {
  [ -f "$ASOUND_CONF" ] || return 0
  sed -n 's/.*card[[:space:]]*"\([^"]*\)".*/\1/p' "$ASOUND_CONF" | head -1
}

# Written to a temp file in the SAME directory and renamed into place, so a
# crash or a power cut can never leave a half-written config behind. A truncated
# asound.conf is not a degraded speaker, it is a silent one.
write_conf() {
  local id="$1" tmp rc
  tmp="$(mktemp "${ASOUND_CONF}.tmp.XXXXXX" 2>/dev/null)" || return 1
  cat > "$tmp" <<EOF
$MARK audio-route.sh — DO NOT EDIT, it is rewritten when a cable is plugged in.
#
# Naming the card by ID is the load-bearing part. Card *numbers* are handed out
# in kernel enumeration order, so an image change, a firmware update, or a
# kernel that probes vc4 before bcm2835 renumbers them and the speaker goes
# silent with nothing on disk having changed. "$id" is stable.
#
# Set as the DEFAULT rather than passed to bluealsa-aplay with -D, deliberately.
# Every failure path in aux.py and in the systemd drop-in lands on a plain
# bluealsa-aplay with no device argument, so the default is the only setting
# all of them inherit — and it keeps audio-check.sh --tone honest, because the
# tone plays at -D default and therefore follows this routing automatically.
#
# type plug, not raw hw: phones send 44.1k SBC and 48k AAC, and plug resamples
# rather than failing to open the device. It also covers the rate a USB speaker
# insists on, which is often 48k only.
pcm.!default {
    type plug
    slave.pcm {
        type hw
        card "$id"
        device 0
    }
}

ctl.!default {
    type hw
    card "$id"
}
EOF
  rc=$?
  if [ "$rc" != "0" ]; then
    rm -f "$tmp"
    return 1
  fi
  chmod 0644 "$tmp" 2>/dev/null
  mv -f "$tmp" "$ASOUND_CONF" || { rm -f "$tmp"; return 1; }
  return 0
}

# ---------------------------------------------------------------- main

TARGET="$(select_target)"
if [ -z "$TARGET" ]; then
  if [ "$BOOTSTRAP" = "1" ]; then
    # provision.sh's pre-reboot case: dtparam=audio=on was only just added, so
    # the analog card does not exist yet and will not until the box reboots.
    # Writing the stock id on faith is what provision.sh already did here, and
    # its own verification block re-checks it after the reboot.
    TARGET="jack Headphones"
    say "no cards enumerated yet — bootstrapping to the stock id 'Headphones'"
  else
    # NEVER write a config naming a card that does not exist. That is the
    # catastrophic state in docs/STATE.md: every playback open fails and the
    # room is silent with all units green. A stale config that names a card
    # that DOES exist is strictly better than a fresh one that names nothing.
    die "no USB playback card and no bcm2835 analog card. Leaving $ASOUND_CONF
     alone. Either dtparam=audio=on is missing from config.txt, or it was
     added and the box has not rebooted since."
  fi
fi

KIND="${TARGET%% *}"
CARD="${TARGET#* }"
say "selected: $KIND ($CARD)"

# Always refresh, even on the unchanged path. /run is tmpfs and is cleared at
# every boot while asound.conf persists, so the boot run takes the unchanged
# branch and would otherwise leave no state file at all.
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null
printf '%s:%s\n' "$KIND" "$CARD" > "$STATE_FILE" 2>/dev/null \
  || say "WARNING: could not write $STATE_FILE"

if [ -f "$ASOUND_CONF" ] && ! grep -qF "$MARK" "$ASOUND_CONF" 2>/dev/null; then
  # Correct behaviour for a box with a real DAC someone configured by hand.
  say "$ASOUND_CONF is hand-written — left alone, routing not changed."
  say "(confirm it names a card that exists, or this box is silent)"
  exit 0
fi

CURRENT="$(configured_card)"
if [ "$CURRENT" = "$CARD" ]; then
  say "already routed to \"$CARD\" — nothing to do"
  exit 0
fi

write_conf "$CARD" || die "could not write $ASOUND_CONF"
say "wrote $ASOUND_CONF: default is now card \"$CARD\"${CURRENT:+ (was \"$CURRENT\")}"

# Only bluealsa-aplay restarts. The A2DP link is held by `bluealsa`, which is
# not touched, so a phone streaming right now keeps its connection and hears a
# gap of about a second rather than dropping and needing to reconnect.
if $RESTART_CMD; then
  say "restarted the player onto the new output"
else
  say "WARNING: '$RESTART_CMD' failed — the config is correct but the running"
  say "         player is still on the old card. Restart it by hand."
fi
