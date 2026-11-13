"""The USB dongle: phones on the dongle, the relay on the built-in chip, and
with no dongle everything exactly as before. See lockerroom/adapters.py."""

from __future__ import annotations

import asyncio
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lockerroom.adapters as adapters_mod  # noqa: E402
import lockerroom.relay as relay_mod  # noqa: E402
from lockerroom import adapter_scan  # noqa: E402
from lockerroom.lifecycle import SessionManager  # noqa: E402

from test_adapters import fake_tree  # noqa: E402
from test_lifecycle import FakeAux, FakeStore  # noqa: E402

PI = Path(__file__).resolve().parents[1]
SCRIPTS = PI / "scripts"
ROLE_SCRIPTS = ["keep-discoverable.sh", "btwatch.sh", "bt-scan.sh", "remote-repair.sh"]


def exe(path: Path, body: str) -> Path:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def roles_env(sysfs: Path) -> dict:
    return {"AUXGOAT_PY": sys.executable, "AUXGOAT_PKG_ROOT": str(PI),
            "AUXGOAT_BT_SYSFS": str(sysfs)}


# --------------------------------------------------------------------------- #
# One shared block, word for word.
# --------------------------------------------------------------------------- #

def _block(text: str) -> str:
    m = re.search(r"# --- adapter roles:.*?# --- end adapter roles -+\n", text, re.S)
    assert m, "bt_roles block missing"
    return m.group(0)


def test_bt_roles_block_is_identical_in_every_script():
    blocks = {name: _block((SCRIPTS / name).read_text()) for name in ROLE_SCRIPTS}
    first = next(iter(blocks.values()))
    for name, block in blocks.items():
        assert block == first, f"{name} has drifted from the shared bt_roles block"


# --------------------------------------------------------------------------- #
# keep-discoverable
# --------------------------------------------------------------------------- #

def run_keep_discoverable(tmp_path, sysfs, extra=None):
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    log = tmp_path / "calls"
    exe(bin_ / "busctl", f'#!/bin/bash\necho "busctl $*" >> {log}\n')
    exe(bin_ / "bluetoothctl", f'#!/bin/bash\necho "bluetoothctl $*" >> {log}\n')
    exe(bin_ / "hciconfig", "#!/bin/bash\necho 'Link mode: PERIPHERAL ACCEPT'\n")
    exe(bin_ / "hostnamectl", "#!/bin/bash\necho 'AuxGoat 0001'\n")
    env = dict(os.environ, PATH=f"{bin_}:{os.environ['PATH']}")
    env.update(roles_env(sysfs))
    env.update(extra or {})
    r = subprocess.run(["bash", str(SCRIPTS / "keep-discoverable.sh"), "--once"],
                       env=env, capture_output=True, text=True, timeout=60)
    return r, (log.read_text() if log.exists() else "")


def test_split_makes_the_dongle_discoverable_and_hides_the_built_in(tmp_path):
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "uart", "hci1": "usb"})
    r, calls = run_keep_discoverable(tmp_path, sysfs)
    assert "/org/bluez/hci1 org.bluez.Adapter1 Discoverable b true" in calls
    assert "/org/bluez/hci1 org.bluez.Adapter1 Pairable b true" in calls
    assert "/org/bluez/hci0 org.bluez.Adapter1 Discoverable b false" in calls
    assert "/org/bluez/hci0 org.bluez.Adapter1 Pairable b false" in calls
    assert "bluetoothctl" not in calls
    assert "phones on hci1" in r.stdout
    # Named as the speaker, not BlueZ's "AuxGoat 0001 #2" for a second adapter.
    assert "/org/bluez/hci1 org.bluez.Adapter1 Alias s AuxGoat 0001\n" in calls
    assert "/org/bluez/hci0 org.bluez.Adapter1 Alias s AuxGoat 0001 (speaker link)" in calls


def test_a_name_that_is_already_right_is_not_rewritten(tmp_path):
    """Alias writes land on flash; the loop runs every 5s."""
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "uart", "hci1": "usb"})
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    log = tmp_path / "calls"
    exe(bin_ / "busctl", f"""#!/bin/bash
echo "busctl $*" >> {log}
if [ "$1" = "get-property" ]; then
  case "$3" in
    /org/bluez/hci1) echo 's "AuxGoat 0001"' ;;
    /org/bluez/hci0) echo 's "AuxGoat 0001 (speaker link)"' ;;
  esac
fi
""")
    exe(bin_ / "hciconfig", "#!/bin/bash\necho 'Link mode: PERIPHERAL ACCEPT'\n")
    exe(bin_ / "hostnamectl", "#!/bin/bash\necho 'AuxGoat 0001'\n")
    env = dict(os.environ, PATH=f"{bin_}:{os.environ['PATH']}")
    env.update(roles_env(sysfs))
    subprocess.run(["bash", str(SCRIPTS / "keep-discoverable.sh"), "--once"],
                   env=env, capture_output=True, text=True, timeout=60)
    calls = log.read_text()
    assert "Alias s" not in calls
    assert "get-property org.bluez /org/bluez/hci1 org.bluez.Adapter1 Alias" in calls


def test_without_a_dongle_it_runs_todays_bluetoothctl_lines(tmp_path):
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "uart"})
    _, calls = run_keep_discoverable(tmp_path, sysfs)
    assert "bluetoothctl discoverable on" in calls
    assert "busctl" not in calls


def test_unreadable_roles_fall_back_to_todays_lines(tmp_path):
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "uart", "hci1": "usb"})
    _, calls = run_keep_discoverable(tmp_path, sysfs, {"AUXGOAT_PY": "/nonexistent/python"})
    assert "bluetoothctl discoverable on" in calls
    assert "busctl" not in calls


# --------------------------------------------------------------------------- #
# btwatch watches the BUILT-IN chip, whatever its number
# --------------------------------------------------------------------------- #

def run_btwatch(tmp_path, sysfs, healthy_hci, extra=None):
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    asked = tmp_path / "asked"
    exe(bin_ / "hciconfig",
        f'#!/bin/bash\necho "$1" >> {asked}\n'
        f'[ "$1" = "{healthy_hci}" ] && echo "$1: UP RUNNING PSCAN ISCAN"\nexit 0\n')
    recovered = tmp_path / "recovered"
    env = {"PATH": f"{bin_}:/usr/bin:/bin", "BTWATCH_ONESHOT": "1",
           "RECOVER_CMD": f"touch {recovered}", **roles_env(sysfs), **(extra or {})}
    subprocess.run(["bash", str(SCRIPTS / "btwatch.sh")], env=env,
                   capture_output=True, text=True, timeout=60)
    return recovered.exists(), (asked.read_text().split() if asked.exists() else [])


def test_btwatch_checks_the_built_in_chip_after_renumbering(tmp_path):
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "usb", "hci1": "uart"})
    recovered, asked = run_btwatch(tmp_path, sysfs, healthy_hci="hci1")
    assert not recovered and asked[0] == "hci1"


def test_btwatch_treats_a_missing_built_in_chip_as_the_wedge(tmp_path):
    """Only the dongle left: the built-in chip has vanished, which is exactly
    what a rebind is for - a healthy dongle must not hide it."""
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "usb"})
    recovered, _ = run_btwatch(tmp_path, sysfs, healthy_hci="hci0")
    assert recovered


def test_btwatch_without_roles_watches_hci0_as_before(tmp_path):
    sysfs = fake_tree(tmp_path / "sys", {"hci0": "uart"})
    recovered, asked = run_btwatch(tmp_path, sysfs, healthy_hci="hci0",
                                   extra={"AUXGOAT_PY": "/nonexistent/python"})
    assert not recovered and asked[0] == "hci0"


# --------------------------------------------------------------------------- #
# bt-scan scans the relay adapter when split
# --------------------------------------------------------------------------- #

def test_bt_scan_uses_the_relay_adapter_when_split(tmp_path):
    fake_py = exe(tmp_path / "py", """#!/bin/bash
if [ "$2" = "lockerroom.adapters" ]; then
  printf 'PHONES=hci1\\nRELAY=hci0\\nUART=hci0\\nSPLIT=1\\n'
elif [ "$2" = "lockerroom.adapter_scan" ]; then
  printf '78:66:F3:1C:9D:B6\\t0x00240414\\t-50\\tJBL Charge 6 (scanned on %s)\\n' "$3"
fi
""")
    btctl = exe(tmp_path / "btctl", "#!/bin/bash\necho SHOULD-NOT-RUN >&2; exit 1\n")
    env = dict(os.environ, AUXGOAT_PY=str(fake_py), BT_SCAN_BLUETOOTHCTL=str(btctl),
               BT_SCAN_SECONDS="1")
    r = subprocess.run(["bash", str(SCRIPTS / "bt-scan.sh")], env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.stdout == "78:66:F3:1C:9D:B6\t0x00240414\t-50\tJBL Charge 6 (scanned on hci0)\n"
    assert "SHOULD-NOT-RUN" not in r.stderr


def test_adapter_scan_formats_lines_btscan_already_parses():
    from lockerroom import btscan
    line = adapter_scan.format_line({"Address": "78:66:F3:1C:9D:B6", "Class": 2360340,
                                     "RSSI": -50, "Name": "JBL\tCharge 6"})
    assert line == "78:66:F3:1C:9D:B6\t0x00240414\t-50\tJBL Charge 6"
    parsed = btscan.parse(line + "\n")
    assert parsed[0]["mac"] == "78:66:F3:1C:9D:B6" and parsed[0]["name"] == "JBL Charge 6"
    assert adapter_scan.format_line({"Name": "no address"}) is None


# --------------------------------------------------------------------------- #
# relay goes through the built-in chip by path when split
# --------------------------------------------------------------------------- #

MAC = "78:66:F3:1C:9D:B6"


@pytest.fixture
def split_roles(monkeypatch):
    monkeypatch.setattr(adapters_mod, "roles",
                        lambda sysfs=None: adapters_mod.Roles("hci1", "hci0", "hci0"))


@pytest.fixture
def busctl_calls(monkeypatch):
    calls = []

    async def fake(*args, timeout=0):
        calls.append(args)
        if args[0] == "call" and args[-1] == "Pair":
            return 1, "Call failed: org.bluez.Error.AlreadyExists"
        return 0, ""

    async def no_btctl(*a, **k):
        raise AssertionError("bluetoothctl must not run when split")

    monkeypatch.setattr(relay_mod, "_busctl", fake)
    monkeypatch.setattr(relay_mod, "_bluetoothctl", no_btctl)
    return calls


@pytest.mark.asyncio
async def test_relay_connects_through_the_relay_adapter(split_roles, busctl_calls):
    assert await relay_mod._bluetoothctl_connect(MAC)
    assert busctl_calls == [("call", "org.bluez", "/org/bluez/hci0/dev_78_66_F3_1C_9D_B6",
                             "org.bluez.Device1", "Connect")]


@pytest.mark.asyncio
async def test_relay_pair_already_paired_counts_and_trusts(split_roles, busctl_calls):
    assert await relay_mod._bluetoothctl_pair(MAC)
    assert busctl_calls[1] == ("set-property", "org.bluez", "/org/bluez/hci0/dev_78_66_F3_1C_9D_B6",
                               "org.bluez.Device1", "Trusted", "b", "true")


@pytest.mark.asyncio
async def test_relay_disconnect_by_path(split_roles, busctl_calls):
    await relay_mod._bluetoothctl_disconnect(MAC)
    assert busctl_calls[0][-1] == "Disconnect"


@pytest.mark.asyncio
async def test_without_a_dongle_the_relay_uses_bluetoothctl(monkeypatch):
    monkeypatch.setattr(adapters_mod, "roles",
                        lambda sysfs=None: adapters_mod.Roles("hci0", "hci0", "hci0"))
    seen = []

    async def btctl(*args, timeout=0):
        seen.append(args)
        return "Connection successful"

    monkeypatch.setattr(relay_mod, "_bluetoothctl", btctl)
    assert await relay_mod._bluetoothctl_connect(MAC)
    assert seen == [("connect", MAC)]


# --------------------------------------------------------------------------- #
# a phone on the built-in chip is turned away when split
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_a_phone_on_the_relay_adapter_is_turned_away(monkeypatch):
    monkeypatch.setattr(adapters_mod, "on_relay_only_adapter", lambda path, sysfs=None: True)
    mgr = SessionManager(FakeStore(), aux=FakeAux())
    gone = []

    async def disconnect(path):
        gone.append(path)

    mgr.set_device_disconnect(disconnect)
    path = "/org/bluez/hci0/dev_5C_AD_BA_F0_B2_61"
    await mgr.on_device_connected(path, "5C:AD:BA:F0:B2:61", "Mack's iPhone")
    assert gone == [path]
    assert path not in mgr._sessions


@pytest.mark.asyncio
async def test_the_relay_speaker_itself_is_never_turned_away(monkeypatch):
    monkeypatch.setattr(adapters_mod, "on_relay_only_adapter", lambda path, sysfs=None: True)
    mgr = SessionManager(FakeStore(), aux=FakeAux(), relay_speaker_mac=MAC)
    gone = []

    async def disconnect(path):
        gone.append(path)

    mgr.set_device_disconnect(disconnect)
    await mgr.on_device_connected("/org/bluez/hci0/dev_78_66_F3_1C_9D_B6", MAC, "JBL Charge 6")
    assert gone == []
