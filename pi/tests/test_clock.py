"""The clock keeper sets the system clock of a box nobody can reach, from a
header on the wire. Every branch is driven here with a fake clock, a fake
network and a fake `date`, and the two properties that matter most are pinned:
it never steps the clock under a song, and a time it could not PROVE never
stays set."""
import asyncio
import ssl
import sys
from email.utils import format_datetime
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import clock  # noqa: E402

T0 = clock.NOT_BEFORE + 30 * 86400.0  # a sane "real now"


def header(epoch: float) -> str:
    return format_datetime(datetime.fromtimestamp(epoch, timezone.utc), usegmt=True)


class World:
    """A wall clock that only moves when `date` is called or time passes."""

    def __init__(self, wall: float):
        self.wall = wall
        self.mono = 1000.0
        self.sets: list[float] = []
        self.set_ok = True
        self.unverified: float | None = None
        self.verified = lambda: None

    def set_clock(self, epoch: float) -> bool:
        if not self.set_ok:
            return False
        self.sets.append(epoch)
        self.wall = epoch
        return True

    def tick(self, seconds: float) -> None:
        self.wall += seconds
        self.mono += seconds

    def keeper(self) -> clock.Keeper:
        async def unverified(url):
            self.tick(1.0)
            return self.unverified

        async def verified(url):
            self.tick(1.0)
            return self.verified()

        return clock.Keeper(set_clock=self.set_clock, wall=lambda: self.wall,
                            mono=lambda: self.mono, unverified_date=unverified,
                            verified_date=verified)


def cert_error(code: int = 9) -> Exception:
    inner = ssl.SSLCertVerificationError(1, "certificate verify failed")
    inner.verify_code = code
    try:
        try:
            raise inner
        except ssl.SSLError as e:
            raise httpx.ConnectError("tls") from e
    except httpx.ConnectError as outer:
        return outer


class TestParsing:
    def test_a_real_http_date(self):
        assert clock.parse_date("Thu, 12 Nov 2026 18:45:04 GMT") == pytest.approx(
            datetime(2026, 11, 12, 18, 45, 4, tzinfo=timezone.utc).timestamp())

    @pytest.mark.parametrize("junk", [None, "", "  ", "yesterday", 12, b"x", "Thu, 99 Foo 2026"])
    def test_junk_is_not_a_time(self, junk):
        assert clock.parse_date(junk) is None

    def test_bounds(self):
        assert clock.sane(T0)
        assert not clock.sane(None)
        assert not clock.sane(0.0)                      # 1970
        assert not clock.sane(clock.NOT_BEFORE - 1)
        assert not clock.sane(clock.NOT_AFTER + 1)      # decades on


class TestOrdinaryCorrection:
    def test_four_minutes_behind_and_idle_is_corrected(self):
        w = World(T0 - 240)
        assert w.keeper().on_good_beacon(header(T0), idle=True) is True
        assert w.sets == [pytest.approx(T0)]

    def test_a_clock_that_is_ahead_is_corrected_too(self):
        w = World(T0 + 300)
        assert w.keeper().on_good_beacon(header(T0), idle=True) is True
        assert w.wall == pytest.approx(T0)

    def test_days_behind_is_corrected(self):
        w = World(T0 - 8.6 * 86400)
        assert w.keeper().on_good_beacon(header(T0), idle=True) is True
        assert w.wall == pytest.approx(T0)

    def test_NEVER_while_a_song_is_open_or_a_phone_is_connected(self):
        """Play time is measured on the wall clock. A step under a song would
        corrupt that song, so the correction waits."""
        w = World(T0 - 240)
        k = w.keeper()
        assert k.on_good_beacon(header(T0), idle=False) is False
        assert w.sets == []
        # ...and happens as soon as the room is quiet.
        assert k.on_good_beacon(header(T0), idle=True) is True

    def test_jitter_is_left_alone(self):
        w = World(T0 - clock.THRESHOLD_S + 1)
        assert w.keeper().on_good_beacon(header(T0), idle=True) is False
        assert w.sets == []

    def test_a_header_outside_sane_bounds_is_ignored(self):
        w = World(T0)
        k = w.keeper()
        assert k.on_good_beacon(header(86400.0), idle=True) is False           # 1970
        assert k.on_good_beacon(header(clock.NOT_AFTER + 86400), idle=True) is False
        assert k.on_good_beacon("not a date", idle=True) is False
        assert k.on_good_beacon(None, idle=True) is False
        assert w.sets == []

    def test_not_twice_in_quick_succession(self):
        w = World(T0 - 240)
        k = w.keeper()
        assert k.on_good_beacon(header(T0), idle=True) is True
        w.wall -= 120                       # something knocks it out again at once
        w.mono += 10
        assert k.on_good_beacon(header(T0 + 10), idle=True) is False
        w.mono += clock.MIN_INTERVAL_S
        assert k.on_good_beacon(header(w.wall + 120), idle=True) is True

    def test_a_date_command_that_fails_changes_nothing_and_is_retried(self):
        w = World(T0 - 240)
        w.set_ok = False
        k = w.keeper()
        assert k.on_good_beacon(header(T0), idle=True) is False
        w.set_ok = True
        assert k.on_good_beacon(header(T0), idle=True) is True


class TestWhichFailuresCount:
    def test_not_yet_valid_and_expired_both_count(self):
        assert clock.is_cert_date_error(cert_error(9))
        assert clock.is_cert_date_error(cert_error(10))
        assert clock.is_cert_date_error(httpx.ConnectError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate is not yet valid"))

    def test_someone_elses_certificate_does_not(self):
        """An unknown issuer or a wrong hostname is not a clock problem, and
        must never lead to the clock being touched."""
        assert not clock.is_cert_date_error(cert_error(20))   # unable to get issuer
        assert not clock.is_cert_date_error(cert_error(62))   # hostname mismatch
        assert not clock.is_cert_date_error(httpx.ConnectTimeout("slow"))
        assert not clock.is_cert_date_error(None)

    def test_three_in_a_row_before_a_rescue_and_a_success_resets_it(self):
        w = World(T0)
        k = w.keeper()
        assert k.on_failure(cert_error()) is False
        assert k.on_failure(cert_error()) is False
        k.on_good_beacon(header(T0), idle=True)
        assert k.on_failure(cert_error()) is False
        assert k.on_failure(cert_error()) is False
        assert k.on_failure(cert_error()) is True

    def test_an_ordinary_outage_never_asks_for_a_rescue(self):
        k = World(T0).keeper()
        assert not any(k.on_failure(httpx.ConnectError("no route")) for _ in range(20))


class TestRescue:
    def run(self, coro):
        return asyncio.run(coro)

    def test_a_clock_weeks_behind_is_set_and_then_proven(self):
        w = World(T0 - 60 * 86400)
        w.unverified = T0
        w.verified = lambda: w.wall          # the real server agrees
        assert self.run(w.keeper().rescue("https://h", idle=True)) is True
        assert w.wall == pytest.approx(T0, abs=5)
        assert len(w.sets) == 1

    def test_A_TIME_THAT_CANNOT_BE_PROVEN_IS_PUT_BACK(self):
        """The property the old boot script lacked. Something on the path
        answers the unverified request with a date years ahead; no verified
        handshake can then succeed, so the clock returns to where it would
        have been - to the second, counting the time the attempt took."""
        start = T0 - 60 * 86400
        w = World(start)
        w.unverified = T0 + 5 * 365 * 86400
        w.verified = lambda: None            # verified request fails
        assert self.run(w.keeper().rescue("https://h", idle=True)) is False
        assert len(w.sets) == 2
        assert w.wall == pytest.approx(start + 2.0, abs=0.01)   # two 1s network calls

    def test_a_verified_answer_that_disagrees_is_also_put_back(self):
        start = T0 - 60 * 86400
        w = World(start)
        w.unverified = T0 + 40 * 86400
        w.verified = lambda: T0              # verified, but it is not the time we set
        assert self.run(w.keeper().rescue("https://h", idle=True)) is False
        assert w.wall == pytest.approx(start + 2.0, abs=0.01)

    def test_never_while_the_room_is_in_use(self):
        w = World(T0 - 60 * 86400)
        w.unverified = T0
        assert self.run(w.keeper().rescue("https://h", idle=False)) is False
        assert w.sets == []

    def test_insane_or_missing_times_are_ignored(self):
        for claimed in (None, 0.0, clock.NOT_AFTER + 1):
            w = World(T0 - 60 * 86400)
            w.unverified = claimed
            assert self.run(w.keeper().rescue("https://h", idle=True)) is False
            assert w.sets == []

    def test_a_small_difference_is_not_what_the_rescue_is_for(self):
        """If the server's time is near ours, the certificate complaint is not
        explained by our clock, and stepping it would fix nothing."""
        w = World(T0 - 600)
        w.unverified = T0
        assert self.run(w.keeper().rescue("https://h", idle=True)) is False
        assert w.sets == []

    def test_it_backs_off_for_an_hour_after_an_attempt(self):
        w = World(T0 - 60 * 86400)
        w.unverified = None
        k = w.keeper()
        for _ in range(3):
            asked = k.on_failure(cert_error())
        assert asked is True
        self.run(k.rescue("https://h", idle=True))
        assert not any(k.on_failure(cert_error()) for _ in range(10))
        w.mono += clock.RESCUE_BACKOFF_S + 1
        assert [k.on_failure(cert_error()) for _ in range(3)][-1] is True


class TestTheWiring:
    def test_only_the_real_entry_point_gets_a_keeper(self):
        """Tests run as root in some environments. A beacon loop built without
        an explicit keeper must not be able to set this machine's clock."""
        import inspect
        from lockerroom import control, main
        assert inspect.signature(control.beacon_loop).parameters["keeper"].default is None
        assert inspect.signature(main.run_listener).parameters["keeper"].default is None
        assert "run_listener(cfg, keeper=clock.Keeper())" in inspect.getsource(main.async_main)


class RecordingKeeper:
    def __init__(self):
        self.good: list[tuple[object, bool]] = []
        self.failures = 0
        self.rescues: list[tuple[str, bool]] = []
        self.ask_for_rescue = False

    def on_good_beacon(self, date_header, idle):
        self.good.append((date_header, idle))
        return False

    def on_failure(self, exc):
        self.failures += 1
        return self.ask_for_rescue

    async def rescue(self, url, idle):
        self.rescues.append((url, idle))
        return False


class TestThroughTheRealBeaconLoop:
    """The keeper is only as good as what the loop tells it. These run the real
    beacon_loop against a fake Worker."""

    async def drive(self, tmp_path, monkeypatch, handler, sessions, keeper, done):
        from types import SimpleNamespace
        from lockerroom import control, software
        from lockerroom.endpoints import HostPool
        monkeypatch.setattr(control, "read_output", lambda *a, **k: None)
        monkeypatch.setattr(control.forgettarget, "write", lambda *a, **k: None)
        cfg = SimpleNamespace(api_base_url="https://one.example", device_key="k",
                              speaker_name="AuxGoat", relay_speaker_mac=None,
                              api_fallback_urls=())
        task = asyncio.create_task(control.beacon_loop(
            cfg, sessions, relay=None, interval_s=0.01, active_interval_s=0.01,
            watch_interval_s=0.01, attentive_interval_s=0.01,
            pool=HostPool(["https://one.example"], state_path=tmp_path / "api-host"),
            marker=software.HealthMarker("r", path=tmp_path / "h.json",
                                         boot_id_path=tmp_path / "none"),
            transport=httpx.MockTransport(handler), keeper=keeper,
            pending_path=tmp_path / "p.json", update_result_path=tmp_path / "u.json",
            update_reported_path=tmp_path / "ur",
        ))
        for _ in range(1000):
            if done():
                break
            await asyncio.sleep(0.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert done(), "the loop never got there"

    @staticmethod
    def ok(request):
        return httpx.Response(200, headers={"date": "Thu, 12 Nov 2026 18:45:04 GMT"}, json={
            "ok": True, "command": None, "relay_speaker": None, "forget_device": None})

    @pytest.mark.asyncio
    async def test_a_good_beacon_hands_over_the_date_and_says_the_room_is_idle(self, tmp_path, monkeypatch):
        k = RecordingKeeper()
        await self.drive(tmp_path, monkeypatch, self.ok, None, k, lambda: k.good)
        assert k.good[0] == ("Thu, 12 Nov 2026 18:45:04 GMT", True)

    @pytest.mark.asyncio
    async def test_an_open_song_is_reported_as_not_idle(self, tmp_path, monkeypatch):
        from types import SimpleNamespace
        sessions = SimpleNamespace(
            open_play_state=lambda: {"id": "p1", "status": "playing"},
            aux_state=lambda: {"holder": None, "waiting": []})
        k = RecordingKeeper()
        await self.drive(tmp_path, monkeypatch, self.ok, sessions, k, lambda: k.good)
        assert k.good[0][1] is False

    @pytest.mark.asyncio
    async def test_a_connected_phone_with_no_song_is_also_not_idle(self, tmp_path, monkeypatch):
        from types import SimpleNamespace
        sessions = SimpleNamespace(
            open_play_state=lambda: None,
            aux_state=lambda: {"holder": {"mac": "AA:BB:CC:00:11:22", "free_in_ms": None},
                               "waiting": []})
        k = RecordingKeeper()
        await self.drive(tmp_path, monkeypatch, self.ok, sessions, k, lambda: k.good)
        assert k.good[0][1] is False

    @pytest.mark.asyncio
    async def test_a_filter_page_is_never_treated_as_a_time_source(self, tmp_path, monkeypatch):
        def page(request):
            return httpx.Response(200, headers={"date": "Thu, 01 Jan 2099 00:00:00 GMT"},
                                  text="<html>blocked</html>")
        k = RecordingKeeper()
        hits = []
        def counting(request):
            hits.append(1)
            return page(request)
        await self.drive(tmp_path, monkeypatch, counting, None, k, lambda: len(hits) >= 3)
        assert k.good == []

    @pytest.mark.asyncio
    async def test_a_failed_beacon_reaches_the_keeper_and_can_start_a_rescue(self, tmp_path, monkeypatch):
        def dead(request):
            raise httpx.ConnectError("tls", request=request)
        k = RecordingKeeper()
        k.ask_for_rescue = True
        await self.drive(tmp_path, monkeypatch, dead, None, k, lambda: k.rescues)
        assert k.rescues[0] == ("https://one.example", True)

    @pytest.mark.asyncio
    async def test_a_keeper_that_throws_does_not_stop_the_beacon(self, tmp_path, monkeypatch):
        class Broken(RecordingKeeper):
            def on_good_beacon(self, date_header, idle):
                super().on_good_beacon(date_header, idle)
                raise RuntimeError("boom")
        k = Broken()
        await self.drive(tmp_path, monkeypatch, self.ok, None, k, lambda: len(k.good) >= 3)
