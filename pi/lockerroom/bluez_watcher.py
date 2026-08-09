from __future__ import annotations

import logging
from typing import Any, Callable, Protocol

from dbus_fast import BusType, Variant
from dbus_fast.aio import MessageBus, ProxyObject

BLUEZ_SERVICE = "org.bluez"
DEVICE_IFACE = "org.bluez.Device1"
PLAYER_IFACE = "org.bluez.MediaPlayer1"
TRANSPORT_IFACE = "org.bluez.MediaTransport1"
PROPS_IFACE = "org.freedesktop.DBus.Properties"
OM_IFACE = "org.freedesktop.DBus.ObjectManager"

log = logging.getLogger("lockerroom.bluez")


def unwrap(value: Any) -> Any:
    """dbus-fast hands back Variant wrappers in some contexts; strip them.

    Must recurse into a Variant's payload, not just return it: `Track`
    arrives as a Variant wrapping a dict whose values are themselves
    Variants, so a single-level unwrap leaves Title/Artist as Variants.
    """
    if isinstance(value, Variant):
        return unwrap(value.value)
    if isinstance(value, dict):
        return {k: unwrap(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unwrap(v) for v in value]
    return value


class LifecycleSink(Protocol):
    async def on_device_connected(self, device_path: str, mac: str, alias: str) -> None: ...
    async def on_device_disconnected(self, device_path: str) -> None: ...
    async def on_track_changed(
        self, device_path: str, track: dict[str, Any], position_ms: int | None
    ) -> None: ...
    async def on_status_changed(self, device_path: str, status: str) -> None: ...
    async def on_transport_state_changed(self, device_path: str, state: str) -> None: ...


def _device_path_for(child_path: str, device_paths: set[str]) -> str | None:
    """MediaPlayer1/MediaTransport1 objects live at sub-paths of their
    owning Device1 object, e.g. /org/bluez/hci0/dev_AA_BB/player0."""
    for dp in device_paths:
        if child_path == dp or child_path.startswith(dp + "/"):
            return dp
    return None


class BluezWatcher:
    def __init__(self, sink: LifecycleSink):
        self._sink = sink
        self._bus: MessageBus | None = None
        self._device_paths: set[str] = set()
        self._device_aliases: dict[str, str] = {}
        # child object path -> owning device path, for MediaPlayer1/MediaTransport1
        self._owner: dict[str, str] = {}
        self._prop_watches: dict[str, Callable] = {}
        # player object path -> org.bluez.MediaPlayer1 interface, kept so we
        # can read Position when a Track change arrives
        self._players: dict[str, Any] = {}

    async def start(self) -> None:
        self._bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        om = await self._get_proxy("/")
        om_iface = om.get_interface(OM_IFACE)

        objects = await om_iface.call_get_managed_objects()
        for path, ifaces in objects.items():
            await self._handle_new_object(path, ifaces)

        om_iface.on_interfaces_added(self._on_interfaces_added)
        om_iface.on_interfaces_removed(self._on_interfaces_removed)
        log.info("bluez watcher started, tracking %d existing device(s)", len(self._device_paths))

    async def pause(self, device_path: str) -> None:
        """Pause a phone over AVRCP.

        Wired into SessionManager.set_pause, for a phone that is connected but
        not routed to the speaker: without it their music runs through a whole
        playlist into nothing, and silence is the only feedback they get.

        This is a courtesy, not the enforcement — the audio is already going
        nowhere (see aux.py). Raises on failure; the caller treats a phone it
        cannot pause as an annoyance rather than an error.
        """
        player = self._player_for(device_path)
        if player is None:
            raise RuntimeError(f"no MediaPlayer1 for {device_path}")
        await player.call_pause()
        log.info("paused %s over AVRCP", device_path)

    def _player_for(self, device_path: str):
        """The MediaPlayer1 interface belonging to a device, if it has one.

        Players live at sub-paths of their device (dev_AA_BB/player0) and are
        cached by path in _players, so this walks the ownership map rather
        than guessing the child path.
        """
        for player_path, owner in self._owner.items():
            if owner == device_path and player_path in self._players:
                return self._players[player_path]
        return None

    async def _get_proxy(self, path: str) -> ProxyObject:
        assert self._bus is not None
        introspection = await self._bus.introspect(BLUEZ_SERVICE, path)
        return self._bus.get_proxy_object(BLUEZ_SERVICE, path, introspection)

    def _on_interfaces_added(self, path: str, interfaces: dict[str, dict[str, Any]]) -> None:
        import asyncio
        asyncio.create_task(self._handle_new_object(path, interfaces))

    def _on_interfaces_removed(self, path: str, interfaces: list[str]) -> None:
        import asyncio
        asyncio.create_task(self._handle_removed_object(path, interfaces))

    async def _handle_new_object(self, path: str, interfaces: dict[str, dict[str, Any]]) -> None:
        if DEVICE_IFACE in interfaces:
            props = {k: unwrap(v) for k, v in interfaces[DEVICE_IFACE].items()}
            self._device_paths.add(path)
            self._device_aliases[path] = props.get("Alias", "")
            await self._watch_properties(path, DEVICE_IFACE)
            if props.get("Connected"):
                mac = props.get("Address", "")
                alias = props.get("Alias", "")
                log.info("device connected (pre-existing): %s %s", mac, alias)
                await self._sink.on_device_connected(path, mac, alias)

        if PLAYER_IFACE in interfaces:
            owner = _device_path_for(path, self._device_paths) or path.rsplit("/", 1)[0]
            self._owner[path] = owner
            await self._cache_player(path)
            await self._watch_properties(path, PLAYER_IFACE)
            props = {k: unwrap(v) for k, v in interfaces[PLAYER_IFACE].items()}
            # Adopt the in-flight track only if it is actually playing. On a
            # mid-session restart BlueZ still reports the last Track even when
            # paused or stopped, and adopting that fabricates a play.
            status = props.get("Status")
            if "Track" in props and status == "playing":
                await self._sink.on_track_changed(owner, props["Track"], await self._position(path))
            elif "Track" in props:
                log.info("not adopting existing track, player status is %r", status)
            if status is not None:
                await self._sink.on_status_changed(owner, status)

        if TRANSPORT_IFACE in interfaces:
            owner = _device_path_for(path, self._device_paths) or path.rsplit("/", 1)[0]
            self._owner[path] = owner
            await self._watch_properties(path, TRANSPORT_IFACE)
            props = {k: unwrap(v) for k, v in interfaces[TRANSPORT_IFACE].items()}
            if "State" in props:
                await self._sink.on_transport_state_changed(owner, props["State"])

    async def _handle_removed_object(self, path: str, interfaces: list[str]) -> None:
        if DEVICE_IFACE in interfaces and path in self._device_paths:
            self._device_paths.discard(path)
            self._device_aliases.pop(path, None)
            log.info("device object removed: %s", path)
            await self._sink.on_device_disconnected(path)
        self._owner.pop(path, None)
        self._prop_watches.pop(path, None)
        self._players.pop(path, None)

    async def _cache_player(self, path: str) -> None:
        if path in self._players:
            return
        try:
            proxy = await self._get_proxy(path)
            self._players[path] = proxy.get_interface(PLAYER_IFACE)
        except Exception:
            log.warning("could not cache MediaPlayer1 at %s", path, exc_info=True)

    async def _position(self, path: str) -> int | None:
        """Playback position in ms, or None if the player does not expose it.
        Position is optional in AVRCP, so callers must handle None."""
        iface = self._players.get(path)
        if iface is None:
            await self._cache_player(path)
            iface = self._players.get(path)
        if iface is None:
            return None
        try:
            return int(unwrap(await iface.get_position()))
        except Exception:
            return None

    def _make_props_handler(self, path: str) -> Callable:
        """dbus-fast introspects the callback signature and requires exactly
        the signal's 3 positional parameters, so bind `path` via closure
        rather than default arguments."""

        def handler(iface: str, changed: dict[str, Any], invalidated: list[str]):
            import asyncio
            asyncio.create_task(
                self._handle_props_changed(path, iface, {k: unwrap(v) for k, v in changed.items()})
            )

        return handler

    async def _watch_properties(self, path: str, interface_name: str) -> None:
        # One PropertiesChanged subscription per object path covers every
        # interface on it; _handle_props_changed dispatches on the reported
        # interface name.
        if path in self._prop_watches:
            return
        proxy = await self._get_proxy(path)
        props_iface = proxy.get_interface(PROPS_IFACE)

        handler = self._make_props_handler(path)
        props_iface.on_properties_changed(handler)
        self._prop_watches[path] = handler

    async def _handle_props_changed(self, path: str, iface: str, changed: dict[str, Any]) -> None:
        if iface == DEVICE_IFACE:
            if "Connected" in changed:
                if changed["Connected"]:
                    device = await self._get_proxy(path)
                    dev_iface = device.get_interface(DEVICE_IFACE)
                    mac = unwrap(await dev_iface.get_address())
                    alias = unwrap(await dev_iface.get_alias())
                    log.info("device connected: %s %s", mac, alias)
                    await self._sink.on_device_connected(path, mac, alias)
                else:
                    log.info("device disconnected: %s", path)
                    await self._sink.on_device_disconnected(path)

        elif iface == PLAYER_IFACE:
            owner = self._owner.get(path, path)
            if "Track" in changed:
                # Position must be read now, alongside the Track change, so
                # the lifecycle can tell a genuine restart from a re-emit.
                position = changed.get("Position")
                if position is None:
                    position = await self._position(path)
                await self._sink.on_track_changed(owner, changed["Track"], position)
            if "Status" in changed:
                await self._sink.on_status_changed(owner, changed["Status"])

        elif iface == TRANSPORT_IFACE:
            owner = self._owner.get(path, path)
            if "State" in changed:
                await self._sink.on_transport_state_changed(owner, changed["State"])
