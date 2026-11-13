"""BluezWatcher: a removed A2DP transport is reported, and every removed
object's PropertiesChanged subscription is actually unsubscribed."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom.bluez_watcher import TRANSPORT_IFACE, BluezWatcher  # noqa: E402

DEV = "/org/bluez/hci0/dev_44_09_DA_0F_21_B0"
FD = DEV + "/sep1/fd3"


class Sink:
    def __init__(self):
        self.removed: list[str] = []

    async def on_transport_removed(self, path):
        self.removed.append(path)


class OldSink:
    """A sink from before on_transport_removed existed."""


class FakeProps:
    def __init__(self):
        self.off: list = []

    def off_properties_changed(self, handler):
        self.off.append(handler)


@pytest.mark.asyncio
async def test_a_removed_transport_is_reported_for_its_device_and_unsubscribed():
    sink = Sink()
    w = BluezWatcher(sink)
    w._owner[FD] = DEV
    props, handler = FakeProps(), object()
    w._prop_watches[FD] = (props, handler)

    await w._handle_removed_object(FD, [TRANSPORT_IFACE])

    assert sink.removed == [DEV]
    assert props.off == [handler]
    assert FD not in w._owner and FD not in w._prop_watches


@pytest.mark.asyncio
async def test_an_old_sink_without_the_hook_is_fine():
    w = BluezWatcher(OldSink())
    w._owner[FD] = DEV
    await w._handle_removed_object(FD, [TRANSPORT_IFACE])
    assert FD not in w._owner
