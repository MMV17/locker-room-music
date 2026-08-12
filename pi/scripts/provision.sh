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
# Written 2026-08-11 after a card stopped accepting writes and the rebuild
# turned out to be an hour of remembering which packages mattered. The second
# box will need this too.
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
# python3-venv     the listener runs in its own venv under /opt/lockerroom
# python3-dev, libdbus-1-dev, pkg-config, build-essential
#                  dbus-fast ships wheels for most platforms but falls back to
#                  building, and a failed build here is a confusing way to lose
#                  an evening
apt-get install -y \
  bluez bluez-alsa-utils bluez-tools \
  python3-venv python3-dev python3-pip \
  libdbus-1-dev pkg-config build-essential \
  git curl

echo "== the name phones see =="
# NOT /etc/bluetooth/main.conf's `Name`, which does nothing on BlueZ 5.x —
# verified on the real hardware 2026-08-09, changed it and restarted bluetoothd
# with no effect. BlueZ takes the adapter name from systemd's pretty hostname.
hostnamectl set-hostname --pretty "$SPEAKER_NAME"

echo "== bluetooth adapter =="
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
# The reason this script exists. A card died on 2026-08-11 after a week of
# continuous logging: the filesystem was clean with zero errors, but writes had
# stopped seven hours before the network did, which is what a worn card does.
#
# Volatile journal + a size cap keeps the log in RAM. The cost is that the
# previous boot's log does not survive a reboot, which is a real loss when
# debugging an overnight death — but a card that outlives the season is worth
# more than a log nobody has yet needed.
install -d -m 755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/volatile.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=32M
EOF
rm -rf /var/log/journal

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
systemctl start bluetooth

echo
echo "Provisioned. Remaining, in order:"
echo "  1. join wifi:      nmcli device wifi connect HCGuest"
echo "  2. put the real device_key in /etc/lockerroom/config.toml"
echo "  3. from the laptop: pi/scripts/deploy.sh pi@<host>"
echo "     (that installs the units, the aplay drop-in, and the code)"
echo "  4. pair a phone and confirm audio"
