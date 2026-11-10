"""The beacon loop itself, driven end to end against a fake Worker.

control.py's helpers have always been tested; the loop that calls them had
not, and it is the only way into the box. These run the real `beacon_loop`
over httpx's MockTransport, so the request it builds and the way it treats
each kind of answer are the things under test.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from lockerroom import control, software
from lockerroom.endpoints import HostPool

PRIMARY = "https://old-primary.example"
FALLBACK = "https://fallback.example"


def config(**kw):
    base = dict(api_base_url=PRIMARY, device_key="k", speaker_name="AuxGoat",
                relay_speaker_mac=None, api_fallback_urls=())
    base.update(kw)
    return SimpleNamespace(**base)


class Worker:
    """A fake of the deployed Worker's beacon route, per hostname."""

    def __init__(self):
        self.beacons: list[tuple[str, dict]] = []
        self.dead: set[str] = set()
        self.html: set[str] = set()       # answers 200 text/html, like a filter page
        self.status = 200
        self.commands: list[dict] = []
        self.results: list[dict] = []
        self.reports: list[dict] = []
        # Called the moment a command has been handed out, so a test can make
        # the network fail BEFORE the result comes back, with no race.
        self.after_command = None

    def handle(self, request: httpx.Request) -> httpx.Response:
        host = f"https://{request.url.host}"
        if host in self.dead:
            raise httpx.ConnectError("no route", request=request)
        if host in self.html:
            return httpx.Response(200, text="<html>This site is blocked</html>")
        body = json.loads(request.content)
        self.beacons.append((host, body))
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "Unauthorized"})
        if "result" in body:
            self.results.append(body["result"])
        if "report" in body:
            self.reports.append(body["report"])
        command = self.commands.pop(0) if self.commands else None
        if command and self.after_command:
            self.after_command()
        # Exactly what the Worker deployed today answers with.
        return httpx.Response(200, json={
            "ok": True, "command": command, "relay_speaker": None, "forget_device": None,
        })


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(control, "read_output", lambda *a, **k: None)
    monkeypatch.setattr(control.forgettarget, "write", lambda *a, **k: None)
    worker = Worker()
    paths = dict(
        pending_path=tmp_path / "pending.json",
        update_result_path=tmp_path / "last-result.json",
        update_reported_path=tmp_path / "update-reported",
    )

    def start(sessions=None, cfg=None, pool=None):
        pool = pool or HostPool([PRIMARY, FALLBACK], state_path=tmp_path / "api-host")
        marker = software.HealthMarker("rel-1", path=tmp_path / "health.json",
                                       boot_id_path=tmp_path / "no-boot-id")
        task = asyncio.create_task(control.beacon_loop(
            cfg or config(), sessions, relay=None, interval_s=0.01, active_interval_s=0.01,
            watch_interval_s=0.01, attentive_interval_s=0.01, pool=pool, marker=marker,
            transport=httpx.MockTransport(worker.handle), **paths,
        ))
        return task, pool

    return SimpleNamespace(worker=worker, start=start, tmp=tmp_path, **paths)


async def until(predicate, timeout=5.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition was never met")
        await asyncio.sleep(0.005)


async def stop(task):
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


class TestWhatEveryBeaconCarries:
    @pytest.mark.asyncio
    async def test_software_has_exactly_the_two_agreed_keys(self, env):
        task, _ = env.start()
        await until(lambda: env.worker.beacons)
        await stop(task)
        _, body = env.worker.beacons[0]
        assert set(body["software"]) == {"commit", "installed_at"}
        assert body["software"]["commit"] == "unknown"   # a dev checkout has no RELEASE.json
        assert body["software"]["installed_at"] is None
        # No other new top-level key rides the beacon.
        assert set(body) <= {"speaker_name", "at", "software", "current_play", "aux",
                             "result", "scan", "report", "output", "relay"}

    @pytest.mark.asyncio
    async def test_a_good_beacon_is_recorded_in_the_health_marker(self, env):
        task, _ = env.start()
        await until(lambda: len(env.worker.beacons) >= 3)
        await stop(task)
        marker = json.loads((env.tmp / "health.json").read_text())
        assert marker["release_id"] == "rel-1"
        assert marker["good_beacons"] >= 2
        assert marker["last_good_boottime"] >= marker["first_good_boottime"]

    @pytest.mark.asyncio
    async def test_a_rejected_beacon_is_not_a_good_one(self, env):
        env.worker.status = 401
        task, pool = env.start()
        await until(lambda: len(env.worker.beacons) >= 5)
        await stop(task)
        marker = json.loads((env.tmp / "health.json").read_text())
        assert marker["good_beacons"] == 0
        # A 401 from OUR Worker is the same on every hostname. Never fail over.
        assert pool.current == PRIMARY


class TestFailover:
    @pytest.mark.asyncio
    async def test_a_dead_primary_moves_the_beacon_to_the_fallback(self, env):
        env.worker.dead.add(PRIMARY)
        task, pool = env.start()
        await until(lambda: env.worker.beacons)
        await stop(task)
        assert env.worker.beacons[0][0] == FALLBACK
        assert pool.current == FALLBACK
        assert (env.tmp / "api-host").read_text().strip() == FALLBACK

    @pytest.mark.asyncio
    async def test_and_it_stays_there_across_a_restart(self, env):
        env.worker.dead.add(PRIMARY)
        task, _ = env.start()
        await until(lambda: env.worker.beacons)
        await stop(task)

        env.worker.beacons.clear()
        fresh = HostPool([PRIMARY, FALLBACK], state_path=env.tmp / "api-host")
        task, _ = env.start(pool=fresh)
        await until(lambda: env.worker.beacons)
        await stop(task)
        # The very first beacon after the restart, with no failures to wait out.
        assert env.worker.beacons[0][0] == FALLBACK

    @pytest.mark.asyncio
    async def test_a_filter_page_answering_200_also_moves_it(self, env):
        env.worker.html.add(PRIMARY)
        task, pool = env.start()
        await until(lambda: env.worker.beacons)
        await stop(task)
        assert pool.current == FALLBACK


class TestCommandsAndTheirResults:
    @pytest.mark.asyncio
    async def test_a_result_is_reported_on_the_next_beacon(self, env, monkeypatch):
        monkeypatch.setattr(control, "run_command", lambda name: (True, "up 3 days", None))
        env.worker.commands.append({"id": "c1", "name": "report-status"})
        task, _ = env.start()
        await until(lambda: env.worker.results)
        await stop(task)
        assert env.worker.results == [{"id": "c1", "ok": True, "output": "up 3 days"}]
        assert not env.pending_path.exists(), "a delivered result was left on disk"

    @pytest.mark.asyncio
    async def test_a_filter_page_does_not_swallow_the_result(self, env, monkeypatch):
        """A9. A 200 that is not our Worker's used to clear the pending result."""
        monkeypatch.setattr(control, "run_command", lambda name: (True, "done", None))
        env.worker.commands.append({"id": "c1", "name": "report-status"})
        pool = HostPool([PRIMARY], state_path=env.tmp / "api-host")
        # The filter arrives while the command is running.
        env.worker.after_command = lambda: env.worker.html.add(PRIMARY)
        task, _ = env.start(pool=pool)
        await until(lambda: env.pending_path.exists())
        await asyncio.sleep(0.1)              # several filtered beacons go by
        assert env.pending_path.exists() and not env.worker.results
        env.worker.html.clear()
        await until(lambda: env.worker.results)
        await stop(task)
        assert env.worker.results[-1]["id"] == "c1"

    @pytest.mark.asyncio
    async def test_a_result_survives_a_listener_restart(self, env, monkeypatch):
        """A10. A watchdog restarting the listener must not take the answer."""
        monkeypatch.setattr(control, "run_command", lambda name: (True, "repaired", None))
        env.worker.commands.append({"id": "c7", "name": "report-status"})
        # The network drops while the command runs, then the listener is killed.
        env.worker.after_command = lambda: env.worker.dead.update({PRIMARY, FALLBACK})
        task, _ = env.start()
        await until(lambda: env.pending_path.exists())
        await stop(task)
        assert not env.worker.results

        env.worker.dead.clear()
        task, _ = env.start()
        await until(lambda: env.worker.results)
        await stop(task)
        assert env.worker.results[0] == {"id": "c7", "ok": True, "output": "repaired"}

    @pytest.mark.asyncio
    async def test_restart_listener_leaves_its_answer_on_disk_before_it_runs(
        self, env, monkeypatch
    ):
        seen = {}

        def dying(name):
            # What the disk holds at the moment the command would kill us.
            seen.update(software.load_pending(env.pending_path))
            return True, "", None

        monkeypatch.setattr(control, "run_command", dying)
        env.worker.commands.append({"id": "c9", "name": "restart-listener"})
        task, _ = env.start()
        await until(lambda: seen)
        await stop(task)
        assert seen["result"]["id"] == "c9" and seen["result"]["ok"] is True
        assert "restarted" in seen["result"]["output"]

    @pytest.mark.asyncio
    async def test_an_unknown_command_is_refused_without_running_anything(self, env):
        env.worker.commands.append({"id": "c2", "name": "rm -rf /"})
        task, _ = env.start()
        await until(lambda: env.worker.results)
        await stop(task)
        assert env.worker.results[0]["ok"] is False
        assert "not an allowed command" in env.worker.results[0]["output"]


class TestTheUpdateReport:
    RESULT = {"id": "u1", "at": "2026-11-10T12:00:00+00:00", "outcome": "committed",
              "ok": True, "reason": "now running abc1234", "from_commit": "a" * 40,
              "to_commit": "b" * 40, "signature": "commit signature not checked",
              "log": "12:00:00 switched\n"}

    @pytest.mark.asyncio
    async def test_it_is_sent_once_as_a_report_of_kind_update(self, env):
        env.update_result_path.write_text(json.dumps(self.RESULT))
        task, _ = env.start()
        await until(lambda: len(env.worker.beacons) >= 6)
        await stop(task)
        assert len(env.worker.reports) == 1
        report = env.worker.reports[0]
        assert set(report) == {"kind", "at", "body", "ok"}
        assert report["kind"] == "update" and report["ok"] is True
        assert "committed" in report["body"] and "switched" in report["body"]
        assert "aaaaaaa to bbbbbbb" in report["body"]

    @pytest.mark.asyncio
    async def test_it_is_not_sent_again_after_a_restart(self, env):
        env.update_result_path.write_text(json.dumps(self.RESULT))
        for _ in range(2):
            task, _ = env.start()
            await until(lambda: len(env.worker.beacons) >= 3)
            await stop(task)
            env.worker.beacons.clear()
        assert len(env.worker.reports) == 1

    @pytest.mark.asyncio
    async def test_a_failed_beacon_does_not_count_as_reported(self, env):
        env.update_result_path.write_text(json.dumps(self.RESULT))
        env.worker.dead.update({PRIMARY, FALLBACK})
        task, _ = env.start()
        await asyncio.sleep(0.1)
        assert not env.update_reported_path.exists()
        env.worker.dead.clear()
        await until(lambda: env.worker.reports)
        await stop(task)
        assert env.update_reported_path.read_text().strip() == "u1"

    def test_a_long_log_is_cut_with_the_cut_announced(self, tmp_path):
        result = dict(self.RESULT, log="x" * 200_000)
        (tmp_path / "r.json").write_text(json.dumps(result))
        _, report = software.unreported_update(
            control.MAX_REPORT_CHARS, control.TRUNCATION_NOTICE,
            tmp_path / "r.json", tmp_path / "reported",
        )
        assert len(report["body"]) == control.MAX_REPORT_CHARS
        assert report["body"].endswith(control.TRUNCATION_NOTICE)


class FakeSessions:
    def __init__(self, state):
        self.state = state

    def open_play_state(self):
        return self.state

    def aux_state(self):
        return {"holder": None, "waiting": []}


class TestTheUpdateCommand:
    def test_it_is_a_fixed_argv_with_no_parameter(self):
        argv, timeout = control.ALLOWED["update-software"]
        assert argv == ["sudo", "/usr/local/bin/auxgoat-update", "request"]
        assert timeout >= 60

    @pytest.mark.parametrize("status", ["playing", "paused"])
    def test_it_is_refused_while_a_song_is_open_even_a_paused_one(self, status):
        allowed, why = control.may_run(
            "update-software", FakeSessions({"id": "p1", "status": status})
        )
        assert allowed is False and "song is playing" in why

    def test_it_is_allowed_when_nothing_is_playing(self):
        assert control.may_run("update-software", FakeSessions(None)) == (True, "")


class TestCadence:
    def test_the_idle_interval_is_ten_seconds(self):
        """Pinned. It was 60, and the first tap of anything waited a minute.
        Do not go below about 5 without re-checking the D1 write budget."""
        assert control.IDLE_INTERVAL_S == 10.0
        assert control.IDLE_INTERVAL_S >= control.ATTENTIVE_INTERVAL_S

    def test_the_loop_asks_next_interval_for_its_delay(self):
        """A16. The tested function used to be a copy of what the loop did."""
        import inspect
        source = inspect.getsource(control.beacon_loop)
        assert "next_interval(" in source
        assert "IDLE_INTERVAL_S" not in source.split('"""')[2]

    def test_next_interval_honours_injected_intervals(self):
        assert control.next_interval(None, False, now=1.0, idle_s=3, active_s=2) == 3
        assert control.next_interval(None, True, now=1.0, idle_s=3, active_s=2) == 2
        assert control.next_interval(9.0, True, now=1.0, attentive_s=0.5) == 0.5
