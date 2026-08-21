#!/usr/bin/env bash
# Turn a blank Raspberry Pi OS install into an AuxGoat speaker.
#
# Run ON THE PI, once, then use deploy.sh from the laptop for every code change
# after that. deploy.sh deliberately does NOT do any of this — it assumes a
# provisioned box and only ships code, which is what keeps it safe to run
# mid-session.
#
#   scp pi/scripts/provision.sh pi@<host>:
#   ssh pi@<host> 'sudo bash provision.sh'
#
# Written 2026-08-11 after what looked like a card that had stopped accepting
# writes, and the rebuild turned out to be an hour of remembering which
# packages mattered.
#
# CORRECTION (2026-08-12): that card was fine. It reads clean at 91.5 MB/s and
# is not write-protected; the BOARD was failing, and ext4's default
# `errors=remount-ro` made a dying board look exactly like a worn card. So the
# reason this script was written is wrong. Keep the script anyway — the hour it
# saves is real, and it is the only written record of which packages matter.
# Just do not treat it as evidence that cards are the thing that kills this box.
#
# RUN THE ARGON CASE SCRIPT FIRST, if the box lives in an Argon ONE V2.
# `argon1.sh` does `apt-get upgrade -y` and `rpi-eeprom-update`, which you want
# happening on a blank image, not on top of a provisioned listener. It also
# enables i2c and sets enable_uart=1, both of which you want anyway.
# Order: flash -> boot bare -> assemble case -> argon1.sh -> THIS -> deploy.sh
#
# WHAT THIS DOES NOT DO, because both need a human:
#   - wifi. Use `nmcli device wifi connect` or raspi-config; HCGuest is open,
#     so no password, but it must be joined once.
#   - /etc/lockerroom/config.toml. It holds DEVICE_KEY, which is a secret and
#     is NOT in git. Copy it from backend/.secrets.local on the laptop. The
#     script writes a template and refuses to start the listener without it.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo" >&2
  exit 1
fi

SPEAKER_NAME="${SPEAKER_NAME:-AuxGoat}"

echo "== packages =="
apt-get update
# bluez            the stack itself
# bluez-alsa-utils bluealsa + bluealsa-aplay, the A2DP sink and its player
# bluez-tools      bt-agent, which auto-accepts pairing (NoInputNoOutput)
# alsa-utils       amixer/alsactl/speaker-test, and alsa-restore.service, which
#                  is what puts the saved volume back at boot. bluez-alsa-utils
#                  pulls in libasound but NOT these, so on a Lite image the box
#                  can come up with no way to set a level and nothing to restore
#                  one — and no speaker-test to prove the jack independently of
#                  Bluetooth, which is the first thing you want when it is dead.
# python3-venv     the listener runs in its own venv under /opt/lockerroom
# python3-dev, libdbus-1-dev, pkg-config, build-essential
#                  dbus-fast ships wheels for most platforms but falls back to
#                  building, and a failed build here is a confusing way to lose
#                  an evening
apt-get install -y \
  bluez bluez-alsa-utils bluez-tools alsa-utils \
  python3-venv python3-dev python3-pip \
  libdbus-1-dev pkg-config build-essential \
  git curl

echo "== the name phones see =="
# NOT /etc/bluetooth/main.conf's `Name`, which does nothing on BlueZ 5.x —
# verified on the real hardware 2026-08-09, changed it and restarted bluetoothd
# with no effect. BlueZ takes the adapter name from systemd's pretty hostname.
hostnamectl set-hostname --pretty "$SPEAKER_NAME"

echo "== bluetooth adapter =="
# rfkill first. A fresh Raspberry Pi OS image can come up with the Bluetooth
# adapter SOFT-BLOCKED — found on the v2 box, 2026-08-19, on a stock Trixie
# flash. `bluetoothctl show` reports `PowerState: off-blocked`, `power on`
# fails with org.bluez.Error.Failed, and any scan then fails NotReady.
#
# This is worth asserting rather than assuming, because the failure is silent
# in the worst way: bluetoothd is running, the unit is green, the adapter
# enumerates and advertises the right UUIDs — and no phone can see the speaker.
# On a box with no SSH on campus, that is indistinguishable from "it broke".
#
# systemd-rfkill persists the unblocked state across reboots, so this normally
# runs once and is a no-op forever after. Left unguarded on purpose: if rfkill
# is missing the adapter was never blocked in the first place.
if command -v rfkill >/dev/null 2>&1; then
  if rfkill list bluetooth | grep -q "Soft blocked: yes"; then
    rfkill unblock bluetooth
    echo "   bluetooth was soft-blocked — unblocked"
  else
    echo "   bluetooth not soft-blocked"
  fi
else
  echo "   rfkill not present, skipping block check"
fi

# Class 0x200414 makes phones show this as a speaker rather than a generic
# device. The timeouts being 0 is what keeps it permanently visible; BlueZ
# still drops discoverability after some connect/disconnect cycles, which is
# what keep-discoverable.sh is for.
if ! grep -q "^Class = 0x200414" /etc/bluetooth/main.conf; then
  sed -i 's/^#\?Class = .*/Class = 0x200414/' /etc/bluetooth/main.conf
  grep -q "^Class" /etc/bluetooth/main.conf || \
    sed -i '/^\[General\]/a Class = 0x200414' /etc/bluetooth/main.conf
fi
for kv in "DiscoverableTimeout = 0" "PairableTimeout = 0"; do
  key="${kv%% *}"
  if grep -q "^#\?$key" /etc/bluetooth/main.conf; then
    sed -i "s/^#\?$key.*/$kv/" /etc/bluetooth/main.conf
  else
    sed -i "/^\[General\]/a $kv" /etc/bluetooth/main.conf
  fi
done

echo "== audio out =="
# spec.md 4.1 has required this since phase 1 and NOTHING has ever asserted it —
# not this script, not deploy.sh. Whether a provisioned box made a sound has
# always come down to whatever the flashed image happened to default to. On
# 2026-08-21 a fresh provision came up silent, and that is what this section is.
#
# bluealsa-aplay is started with NO -D flag (pi/systemd/bluealsa-aplay-aux.conf,
# and the DAC note in docs/STATE.md about never naming a device on the main
# path), so the ALSA *default* device IS the entire audio path. Left untouched,
# `default` means card 0, and card 0 is whichever card the kernel enumerated
# first. With the KMS video driver loaded that is routinely a vc4-hdmi card —
# so a completely healthy box plays the whole set into an HDMI port with
# nothing plugged into it.
#
# That is the worst failure shape this project keeps producing, and the same
# one as the soft-blocked adapter above: every unit green, the phone pairs,
# AVRCP metadata reaches the site, plays land in D1, and the room is silent.
# Nothing in `systemctl status` can ever show it. Assert it, do not assume it.
#
# pi/scripts/audio-check.sh reports this whole path when it is already broken.
AUDIO_REBOOT=0

# 1. The jack has to exist as a card at all. `dtparam=audio=on` is what loads
#    snd_bcm2835, and the firmware reads config.txt only at boot.
BOOT_CFG=""
for c in /boot/firmware/config.txt /boot/config.txt; do
  if [ -f "$c" ]; then BOOT_CFG="$c"; break; fi
done
if [ -z "$BOOT_CFG" ]; then
  echo "   WARNING: no config.txt at either path; enable analog audio by hand"
elif grep -qE '^[[:space:]]*dtparam=audio=on' "$BOOT_CFG"; then
  echo "   dtparam=audio=on already set in $BOOT_CFG"
else
  # Appended under an explicit [all], never bare. A bare append lands in
  # whichever conditional section the image left open at the end of the file
  # ([pi5], [cm4], [none]...), where it passes a grep and does nothing.
  printf '\n[all]\ndtparam=audio=on\n' >> "$BOOT_CFG"
  echo "   added dtparam=audio=on to $BOOT_CFG — NEEDS A REBOOT"
  AUDIO_REBOOT=1
fi

# 2. Pin the ALSA default to that card BY ID, not by index.
ANALOG_CARD="$(sed -n 's/^ *[0-9]* \[\([^]]*\)\].*bcm2835.*/\1/p' /proc/asound/cards 2>/dev/null | head -1 | tr -d ' ' || true)"
if [ -z "$ANALOG_CARD" ]; then
  ANALOG_CARD="Headphones"
  echo "   no bcm2835 card up yet — assuming the stock id '$ANALOG_CARD'"
  echo "   (expected if dtparam was only just added; verify after the reboot)"
  AUDIO_REBOOT=1
else
  echo "   analog card id: $ANALOG_CARD"
fi

ASOUND_MARK="# managed by lockerroom provision.sh"
if [ -f /etc/asound.conf ] && ! grep -qF "$ASOUND_MARK" /etc/asound.conf; then
  echo "   /etc/asound.conf exists and this script did not write it — left alone"
  echo "   (correct if a DAC was added; confirm it names a card that exists)"
else
  cat > /etc/asound.conf <<EOF
$ASOUND_MARK
#
# Naming the card by ID is the load-bearing part. Card *numbers* are handed out
# in kernel enumeration order, so an image change, a firmware update, or a
# kernel that probes vc4 before bcm2835 renumbers them and the speaker goes
# silent with nothing on disk having changed. "$ANALOG_CARD" is stable.
#
# Set as the DEFAULT rather than passed to bluealsa-aplay with -D, deliberately.
# Every failure path in aux.py and in the systemd drop-in lands on a plain
# bluealsa-aplay with no device argument, so the default is the only setting
# all of them inherit. See the DAC note in docs/STATE.md.
#
# type plug, not raw hw: phones send 44.1k SBC and 48k AAC, and plug resamples
# rather than failing to open the device.
pcm.!default {
    type plug
    slave.pcm {
        type hw
        card "$ANALOG_CARD"
        device 0
    }
}

ctl.!default {
    type hw
    card "$ANALOG_CARD"
}
EOF
  echo "   wrote /etc/asound.conf — default is now card \"$ANALOG_CARD\""
fi

# 3. Unmuted, at a known level, and saved so a reboot keeps it. A fresh image
#    has no /var/lib/alsa/asound.state, so the level is whatever the driver
#    defaulted to and nothing puts it back at boot.
#
#    0dB is unity, not maximum. This output goes to +4dB, which clips a
#    PWM-driven jack; loudness belongs to the powered speaker at the far end of
#    the aux cable, which has its own knob.
if amixer -c "$ANALOG_CARD" scontrols >/dev/null 2>&1; then
  CTL="$(amixer -c "$ANALOG_CARD" scontrols 2>/dev/null | sed -n "s/^Simple mixer control '\([^']*\)'.*/\1/p" | head -1 || true)"
  CTL="${CTL:-PCM}"
  if amixer -c "$ANALOG_CARD" sset "$CTL" unmute >/dev/null 2>&1; then
    echo "   $CTL unmuted"
  else
    echo "   $CTL has no mute switch, nothing to unmute"
  fi
  if amixer -c "$ANALOG_CARD" sset "$CTL" 0dB >/dev/null 2>&1; then
    echo "   $CTL set to 0dB (unity)"
  else
    echo "   WARNING: could not set the $CTL level; check it with alsamixer"
  fi
  if alsactl store >/dev/null 2>&1; then
    echo "   mixer state saved — survives a reboot"
  else
    echo "   WARNING: alsactl store failed; the level will not survive a reboot"
  fi
else
  echo "   mixer not touched — the card is not up yet (reboot, then re-run)"
fi

echo "== audio-check helper =="
# The tool you want when the room is silent and every unit is green. deploy.sh
# installs it too, so a box that only ever gets deploys still has it.
if install -m 755 "$(dirname "$0")/audio-check.sh" /usr/local/bin/audio-check.sh 2>/dev/null; then
  echo "   installed /usr/local/bin/audio-check.sh"
else
  echo "   audio-check.sh not next to this script; deploy.sh will install it"
fi

echo "== directories =="
install -d -m 755 /opt/lockerroom
install -d -m 755 /var/lib/lockerroom
install -d -m 755 /var/log/lockerroom
install -d -m 755 /etc/lockerroom

echo "== python venv =="
# --system-site-packages is deliberate: nothing here needs it, and leaving it
# off keeps a distro upgrade from silently changing what the listener imports.
python3 -m venv /opt/lockerroom/venv
/opt/lockerroom/venv/bin/pip install --upgrade pip
/opt/lockerroom/venv/bin/pip install "dbus-fast>=2.21" "httpx>=0.27"

echo "== stop grinding the SD card =="
# Written when 2026-08-11 looked like a worn card. It was not — see the
# CORRECTION at the top of this file. Keep this section regardless: continuous
# journald writes to an SD card are a genuinely bad idea over a season, and
# this costs nothing. It is prudence now, not a fix for a diagnosed fault.
#
# Volatile journal + a size cap keeps the log in RAM. The cost is that the
# previous boot's log does not survive a reboot, which is a real loss when
# debugging an overnight death — and on THIS box that cost is now covered by
# the serial console, which sees the boot even when nothing is written down.
install -d -m 755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/volatile.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=32M
EOF
rm -rf /var/log/journal

# noatime on root. Raspberry Pi OS has shipped `defaults,noatime` in /etc/fstab
# for years, so on a stock image this is a no-op and prints "already set" —
# that is the expected result, not a failure. It is here to ASSERT the end
# state rather than assume it, because a card restored from an older image, or
# an fstab edited by hand, can lose it silently, and the symptom is invisible:
# every file read writes back an access timestamp, which is pure wear on a box
# that reads its venv and DB constantly.
if grep -qE '^[^#].*\s/\s+ext4\s' /etc/fstab; then
  if grep -qE '^[^#].*\s/\s+ext4\s+\S*noatime' /etc/fstab; then
    echo "   noatime already set on /"
  else
    cp /etc/fstab /etc/fstab.bak
    # Append to the existing option list on the root line only.
    sed -i -E 's|^([^#]\S*\s+/\s+ext4\s+)(\S+)|\1\2,noatime|' /etc/fstab
    echo "   added noatime to / (backup at /etc/fstab.bak) — takes effect on reboot"
  fi
else
  echo "   WARNING: no ext4 root line found in /etc/fstab; check noatime by hand"
fi

echo "== config template =="
if [ ! -f /etc/lockerroom/config.toml ]; then
  cat > /etc/lockerroom/config.toml <<EOF
# Copy DEVICE_KEY from backend/.secrets.local on the laptop. It is a secret and
# is NOT in git; Cloudflare secrets are write-only so this is the only copy.
api_base_url = "https://lockerroom.finestkindfarms.com"
device_key = "REPLACE_ME"
speaker_name = "$SPEAKER_NAME"
sync_interval_s = 5
db_path = "/var/lib/lockerroom/lockerroom.db"
log_path = "/var/log/lockerroom/listener.log"
EOF
  chmod 600 /etc/lockerroom/config.toml
  echo "   wrote template — device_key still needs filling in"
else
  echo "   already present, left alone"
fi

echo "== helper script =="
install -m 755 "$(dirname "$0")/keep-discoverable.sh" /usr/local/bin/keep-discoverable.sh 2>/dev/null \
  || echo "   keep-discoverable.sh not next to this script; deploy.sh will not install it either, copy it by hand"

echo "== services =="
systemctl enable bluetooth
# RESTART, not start. `start` is a no-op when bluetoothd is already running,
# and on a box that has been up since stage 1 it always is — so the pretty
# hostname set above and the Class in main.conf never reach the adapter, and
# the speaker keeps advertising its old name with a generic device class.
# Caught on the v2 box 2026-08-19: everything was correct on disk and wrong
# on the air. docs/spec.md has said "it is not picked up live" since phase 1.
systemctl restart bluetooth

echo
echo "Provisioned. Remaining, in order:"
echo "  1. join wifi:      nmcli device wifi connect HCGuest"
echo "  2. put the real device_key in /etc/lockerroom/config.toml"
echo "  3. from the laptop: pi/scripts/deploy.sh pi@<host>"
echo "     (that installs the units, the aplay drop-in, and the code)"
echo "  4. pair a phone and confirm audio"
echo "     if the room is silent: sudo audio-check.sh   (--tone to prove the jack)"
if [ "$AUDIO_REBOOT" = "1" ]; then
  echo
  echo "  !! REBOOT REQUIRED BEFORE THERE WILL BE ANY SOUND."
  echo "     Analog output was only just enabled in $BOOT_CFG, and the firmware"
  echo "     reads that file at boot. Until then the 3.5mm jack does not exist"
  echo "     as an ALSA card, and every other check will still look green."
  echo "     After rebooting: sudo audio-check.sh --tone"
fi
