"""The thing that decides which OUTPUT the speaker plays into.

A USB speaker enumerates as its own ALSA card; the 3.5mm jack cannot be sensed
at all on a Pi 4. So the rule is one-sided — USB if present, else the jack —
and `audio-route.sh` is the only writer of /etc/asound.conf.

The script is bash, so it is driven here as a subprocess against a fake
/proc/asound tree. The fake goes through the script's OWN environment overrides
(ASOUND_ROOT, ASOUND_CONF, STATE_FILE, RESTART_CMD) rather than
ALSA_CONFIG_PATH, which docs/STATE.md records as having silently not worked:
the system alsa.conf includes /etc/asound.conf itself.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "audio-route.sh"

MARK = "# managed by lockerroom"


def make_cards(root: Path, cards: list[tuple[int, str, str]]) -> None:
    """Build a fake /proc/asound.

    `cards` is (index, id, driver_blurb). A card directory gets a `usbid` file
    when the blurb mentions USB, and a `pcm0p` entry unless the blurb says
    "capture-only" — those two files are what the script actually keys on, and
    keying on them rather than the name is the point.
    """
    lines = []
    for idx, cid, blurb in cards:
        lines.append(f" {idx} [{cid:<14}]: {blurb} - {blurb}")
        lines.append(f"                      {blurb}")
        d = root / f"card{idx}"
        d.mkdir(parents=True, exist_ok=True)
        if "USB" in blurb:
            (d / "usbid").write_text("1234:5678\n")
        if "capture-only" not in blurb:
            (d / "pcm0p").mkdir(exist_ok=True)
    (root / "cards").write_text("\n".join(lines) + "\n")


def run(tmp_path: Path, *args: str, conf_text: str | None = None) -> dict:
    root = tmp_path / "asound"
    conf = tmp_path / "asound.conf"
    state = tmp_path / "run" / "audio-out"
    flag = tmp_path / "restarted"
    if conf_text is not None:
        conf.write_text(conf_text)
    proc = subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/bin:/bin",
            "ASOUND_ROOT": str(root),
            "ASOUND_CONF": str(conf),
            "STATE_FILE": str(state),
            # Unquoted $RESTART_CMD in the script, so this word-splits into a
            # real command and the flag file proves whether it ran.
            "RESTART_CMD": f"touch {flag}",
        },
    )
    return {
        "rc": proc.returncode,
        "out": proc.stdout + proc.stderr,
        "conf": conf.read_text() if conf.exists() else None,
        "state": state.read_text().strip() if state.exists() else None,
        "restarted": flag.exists(),
        "conf_path": conf,
        "root": root,
        "tmp": tmp_path,
    }


ANALOG = (2, "Headphones", "bcm2835_headpho")
USB_SPEAKER = (1, "Charge", "USB-Audio")
HDMI = (0, "vc4hdmi0", "vc4-hdmi")


def test_usb_playback_card_wins(tmp_path):
    make_cards(tmp_path / "asound", [HDMI, USB_SPEAKER, ANALOG])
    r = run(tmp_path)
    assert r["rc"] == 0
    assert 'card "Charge"' in r["conf"]
    assert r["state"] == "usb:Charge"
    assert r["restarted"]


def test_no_usb_falls_back_to_the_jack(tmp_path):
    make_cards(tmp_path / "asound", [HDMI, ANALOG])
    r = run(tmp_path)
    assert r["rc"] == 0
    assert 'card "Headphones"' in r["conf"]
    assert r["state"] == "jack:Headphones"


def test_usb_capture_only_device_is_ignored(tmp_path):
    """A USB microphone has a usbid but no playback PCM. It must not win.

    This is why the check is `usbid` AND a pcm*p entry rather than matching the
    string "USB" in /proc/asound/cards.
    """
    make_cards(
        tmp_path / "asound",
        [HDMI, (1, "Mic", "USB-Audio capture-only"), ANALOG],
    )
    r = run(tmp_path)
    assert r["rc"] == 0
    assert 'card "Headphones"' in r["conf"]
    assert r["state"] == "jack:Headphones"


def test_two_usb_cards_lowest_index_wins_deterministically(tmp_path):
    make_cards(
        tmp_path / "asound",
        [HDMI, (1, "Charge", "USB-Audio"), (3, "Dongle", "USB-Audio"), ANALOG],
    )
    r = run(tmp_path)
    assert r["state"] == "usb:Charge"


def test_no_card_at_all_refuses_to_write(tmp_path):
    """The catastrophic state in STATE.md is a config naming a card that does
    not exist: every playback open fails, room silent, all units green. A stale
    config naming a card that DOES exist is strictly better."""
    make_cards(tmp_path / "asound", [HDMI])
    stale = f'{MARK}\npcm.!default {{ type hw card "Headphones" }}\n'
    r = run(tmp_path, conf_text=stale)
    assert r["rc"] == 1
    assert r["conf"] == stale, "existing config must be left exactly as it was"
    assert not r["restarted"]


def test_bootstrap_writes_the_stock_id_when_nothing_is_enumerated(tmp_path):
    """provision.sh's pre-reboot case: dtparam=audio=on was only just added."""
    make_cards(tmp_path / "asound", [HDMI])
    r = run(tmp_path, "--bootstrap")
    assert r["rc"] == 0
    assert 'card "Headphones"' in r["conf"]


def test_hand_written_config_is_left_alone(tmp_path):
    """Correct for a box with a real DAC someone configured by hand."""
    make_cards(tmp_path / "asound", [HDMI, USB_SPEAKER, ANALOG])
    hand = 'pcm.!default { type hw card "SomeDAC" }\n'
    r = run(tmp_path, conf_text=hand)
    assert r["rc"] == 0
    assert r["conf"] == hand
    assert not r["restarted"]


def test_config_from_the_old_provision_marker_is_adopted(tmp_path):
    """Boxes provisioned before 2026-08-28 carry the longer provision.sh
    marker. It contains the shared substring, so they must be adopted rather
    than mistaken for hand-written."""
    make_cards(tmp_path / "asound", [HDMI, USB_SPEAKER, ANALOG])
    old = f'{MARK} provision.sh\npcm.!default {{ type hw card "Headphones" }}\n'
    r = run(tmp_path, conf_text=old)
    assert r["rc"] == 0
    assert 'card "Charge"' in r["conf"]
    assert r["restarted"]


def test_unchanged_selection_does_not_rewrite_or_restart(tmp_path):
    """No pointless restart mid-song. udev fires several events per plug."""
    make_cards(tmp_path / "asound", [HDMI, ANALOG])
    same = f'{MARK}\npcm.!default {{ type hw card "Headphones" }}\n'
    r = run(tmp_path, conf_text=same)
    assert r["rc"] == 0
    assert r["conf"] == same, "the file must not be rewritten"
    assert not r["restarted"]


def test_state_file_is_refreshed_even_when_nothing_changed(tmp_path):
    """/run is tmpfs and is cleared at boot while asound.conf persists, so the
    boot run takes the unchanged branch. If the state file were only written on
    a change, it would be missing for the whole session."""
    make_cards(tmp_path / "asound", [HDMI, ANALOG])
    same = f'{MARK}\npcm.!default {{ type hw card "Headphones" }}\n'
    r = run(tmp_path, conf_text=same)
    assert r["state"] == "jack:Headphones"


@pytest.mark.parametrize(
    "cards",
    [[HDMI, USB_SPEAKER, ANALOG], [HDMI, ANALOG], [HDMI]],
    ids=["usb", "jack", "none"],
)
def test_no_temp_file_is_ever_left_behind(tmp_path, cards):
    """The write is temp-then-rename so a crash cannot leave a truncated
    config. Nothing should survive the run either way."""
    make_cards(tmp_path / "asound", cards)
    r = run(tmp_path)
    leftovers = list(tmp_path.glob("asound.conf.tmp.*"))
    assert leftovers == []


def test_written_config_names_the_card_by_id_not_index(tmp_path):
    """Card numbers move between boots and images. Pinning by index is the bug
    that silenced the box on 2026-08-22."""
    make_cards(tmp_path / "asound", [HDMI, USB_SPEAKER, ANALOG])
    r = run(tmp_path)
    assert 'card "Charge"' in r["conf"]
    assert "card 1" not in r["conf"]
    assert "type plug" in r["conf"], "plug, so 44.1k phones and 48k-only USB both open"
    assert MARK in r["conf"], "must be adoptable by the next run"
