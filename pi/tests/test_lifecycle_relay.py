"""The far speaker is a SINK, not a DJ.

This is the finding docs/STATE.md calls "the blocker no tuning fixes". On
2026-08-23 the relay target was granted the aux and opened play sessions:

    lockerroom.bluez: device disconnected: /org/bluez/hci0/dev_78_66_F3_1C_9D_B6
    lockerroom.lifecycle: aux granted to JBL Charge 6 (78:66:F3:1C:9D:B6)
    lockerroom.lifecycle: session closed: JBL Charge 6 (78:66:F3:1C:9D:B6)

So it competed with real phones for the aux and landed in the play data. It
must be excluded BY IDENTITY, before any other logic runs.

Run: python3 -m pytest pi/tests/ -q   (from the repo root)
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.lifecycle import SessionManager  # noqa: E402

SPEAKER = "78:66:F3:1C:9D:B6"
SPEAKER_PATH = "/org/bluez/hci0/dev_78_66_F3_1C_9D_B6"
PHONE = "5C:AD:BA:F0:B2:61"
PHONE_PATH = "/org/bluez/hci0/dev_5C_AD_BA_F0_B2_61"


class FakeStore:
    """Minimal outbox stub. Deliberately records everything, so a test can
    assert the speaker never reaches the play data at all."""

    def __init__(self):
        self.rows: list[dict] = []

    async def enqueue(self, outbox_id, method, endpoint, payload):
        await asyncio.sleep(0)
        self.rows.append({"endpoint": endpoint, "payload": payload})


class FakeRelay:
    def __init__(self):
        self.disconnects = 0

    async def on_disconnected(self):
        self.disconnects += 1


@pytest.mark.asyncio
async def test_relay_speaker_never_opens_a_session():
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    assert mgr._sessions == {}, "the far speaker must never become a session"


@pytest.mark.asyncio
async def test_relay_speaker_never_holds_the_aux():
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    assert mgr._aux_path is None, "this is the exact 08-23 failure"


@pytest.mark.asyncio
async def test_relay_speaker_is_matched_case_insensitively():
    """BlueZ and config may disagree on case; the exclusion must not."""
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER.lower())
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    assert mgr._sessions == {}


@pytest.mark.asyncio
async def test_phone_gets_the_aux_even_though_the_speaker_connected_first():
    """The speaker must not occupy the slot the DJ needs."""
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    await mgr.on_device_connected(PHONE_PATH, PHONE, "Mack's iPhone")
    assert list(mgr._sessions) == [PHONE_PATH]
    assert mgr._aux_path == PHONE_PATH


@pytest.mark.asyncio
async def test_speaker_produces_no_outbox_rows():
    store = FakeStore()
    mgr = SessionManager(store, relay_speaker_mac=SPEAKER)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    await mgr.on_device_disconnected(SPEAKER_PATH)
    assert store.rows == [], "the speaker must never reach the play data"


@pytest.mark.asyncio
async def test_disconnecting_the_speaker_does_not_raise():
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    await mgr.on_device_disconnected(SPEAKER_PATH)


@pytest.mark.asyncio
async def test_relay_disabled_means_nothing_is_excluded():
    """THE safety property: an unconfigured box behaves exactly as before."""
    mgr = SessionManager(FakeStore())
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "JBL Charge 6")
    assert list(mgr._sessions) == [SPEAKER_PATH]
    assert mgr._aux_path == SPEAKER_PATH


@pytest.mark.asyncio
async def test_speaker_disconnect_notifies_the_relay():
    relay = FakeRelay()
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    mgr.set_relay(relay)
    await mgr.on_device_disconnected(SPEAKER_PATH)
    assert relay.disconnects == 1


@pytest.mark.asyncio
async def test_phone_disconnect_does_not_notify_the_relay():
    relay = FakeRelay()
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    mgr.set_relay(relay)
    await mgr.on_device_connected(PHONE_PATH, PHONE, "Mack's iPhone")
    await mgr.on_device_disconnected(PHONE_PATH)
    assert relay.disconnects == 0


# --------------------------------------------------------------------------- #
# The exclusion has to follow a speaker chosen at runtime.
#
# Before the Admin screen, the relay MAC was fixed at construction from
# config.toml. Now it can change mid-run, and if the guard does not move with
# it, the newly chosen speaker is granted the aux and written into the play
# data - which is exactly the 08-23 failure above, reintroduced by the feature
# that was supposed to make the relay usable.
# --------------------------------------------------------------------------- #

SPEAKER2 = "AA:BB:CC:DD:EE:FF"
SPEAKER2_PATH = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"


@pytest.mark.asyncio
async def test_a_speaker_chosen_at_runtime_is_excluded():
    mgr = SessionManager(FakeStore())
    mgr.set_relay_mac(SPEAKER2)
    await mgr.on_device_connected(SPEAKER2_PATH, SPEAKER2, "JBL Charge 6")
    assert mgr._sessions == {}
    assert mgr._aux_path is None


@pytest.mark.asyncio
async def test_the_previous_speaker_stops_being_excluded():
    """Otherwise the exclusion list only ever grows, and a speaker you stopped
    relaying to could never be somebody's phone."""
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    mgr.set_relay_mac(SPEAKER2)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "A Phone")
    assert mgr._sessions != {}


@pytest.mark.asyncio
async def test_clearing_the_speaker_excludes_nobody():
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    mgr.set_relay_mac(None)
    await mgr.on_device_connected(SPEAKER_PATH, SPEAKER, "A Phone")
    assert mgr._sessions != {}


@pytest.mark.asyncio
async def test_the_disconnect_path_follows_the_new_speaker_too():
    """on_device_disconnected matches on the BlueZ path spelling, which is a
    SECOND derived value. Updating one and not the other would leave the relay
    never told its speaker went away - silence with every unit green."""
    relay = FakeRelay()
    mgr = SessionManager(FakeStore(), relay_speaker_mac=SPEAKER)
    mgr.set_relay(relay)
    mgr.set_relay_mac(SPEAKER2)
    await mgr.on_device_disconnected(SPEAKER2_PATH)
    assert relay.disconnects == 1


def test_a_lowercase_mac_chosen_at_runtime_still_excludes():
    """It arrives from BlueZ upper-cased and from the server however the
    operator's browser sent it."""
    mgr = SessionManager(FakeStore())
    mgr.set_relay_mac(SPEAKER2.lower())
    assert mgr.relay_mac == SPEAKER2
