"""One hostname must never again be the whole control channel.

The campus filter has blocked a zone by SNI before, and the hostname this box
was first configured with is being retired. These hold the rules that let
either happen without a cable: an ordered list, sticky last-good, and a pool
that only moves for the right reasons.
"""

from __future__ import annotations

from lockerroom import endpoints
from lockerroom.endpoints import HostPool, build_urls

A, B, C = "https://a.example", "https://b.example", "https://c.example"


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def pool(tmp_path, urls=(A, B, C), clock=None):
    return HostPool(urls, state_path=tmp_path / "api-host", clock=clock or Clock())


class TestTheList:
    def test_order_is_config_then_extras_then_built_ins(self):
        urls = build_urls("https://primary.example/", ["https://extra.example"])
        assert urls[:2] == ["https://primary.example", "https://extra.example"]
        assert urls[2:] == list(endpoints.DEFAULT_FALLBACKS)

    def test_the_built_in_fallbacks_are_the_two_agreed_hosts(self):
        assert endpoints.DEFAULT_FALLBACKS == (
            "https://auxgoat-hc.mmvinton17.workers.dev",
            "https://hc.auxgoat.com",
        )

    def test_plain_http_is_never_used(self):
        """The device key rides every request."""
        urls = build_urls("http://primary.example", ["http://extra.example", "ftp://x"])
        assert urls == list(endpoints.DEFAULT_FALLBACKS)

    def test_a_url_with_a_path_or_credentials_is_refused(self):
        for bad in ("https://a.example/api", "https://user:pw@a.example", "https://", 7, None):
            assert endpoints.normalise(bad) is None

    def test_duplicates_collapse(self):
        first = endpoints.DEFAULT_FALLBACKS[0]
        assert build_urls(first, [first]).count(first) == 1

    def test_an_unreadable_config_still_yields_hosts(self, tmp_path):
        assert endpoints.configured_urls(tmp_path / "missing.toml") == list(
            endpoints.DEFAULT_FALLBACKS
        )

    def test_the_config_file_is_read(self, tmp_path):
        cfg = tmp_path / "config.toml"
        cfg.write_text('api_base_url = "https://p.example"\n'
                       'api_fallback_urls = ["https://q.example"]\n')
        assert endpoints.configured_urls(cfg)[:2] == ["https://p.example", "https://q.example"]


class TestThePool:
    def test_starts_on_the_primary(self, tmp_path):
        assert pool(tmp_path).pick() == A

    def test_two_failures_do_not_move_it(self, tmp_path):
        p = pool(tmp_path)
        p.failure(A)
        p.failure(A)
        assert p.pick() == A

    def test_three_failures_in_a_row_move_to_the_next_host(self, tmp_path):
        p = pool(tmp_path)
        for _ in range(3):
            p.failure(A)
        assert p.pick() == B

    def test_a_success_in_between_resets_the_count(self, tmp_path):
        p = pool(tmp_path)
        p.failure(A)
        p.failure(A)
        p.success(A)
        p.failure(A)
        p.failure(A)
        assert p.pick() == A

    def test_it_walks_the_whole_list_and_wraps(self, tmp_path):
        p = pool(tmp_path)
        seen = []
        for _ in range(4):
            seen.append(p.pick())
            for _ in range(3):
                p.failure(p.current)
        assert seen == [A, B, C, A]

    def test_the_last_good_host_is_remembered_across_a_restart(self, tmp_path):
        p = pool(tmp_path)
        for _ in range(3):
            p.failure(A)
        p.success(B)
        assert (tmp_path / "api-host").read_text().strip() == B
        assert pool(tmp_path).pick() == B

    def test_moving_without_a_success_is_not_remembered(self, tmp_path):
        """Sticky last-GOOD: a host that never answered is not worth restoring."""
        p = pool(tmp_path)
        for _ in range(3):
            p.failure(A)
        assert not (tmp_path / "api-host").exists()
        assert pool(tmp_path).pick() == A

    def test_a_remembered_host_no_longer_on_the_list_is_ignored(self, tmp_path):
        (tmp_path / "api-host").write_text("https://gone.example\n")
        assert pool(tmp_path).pick() == A

    def test_the_primary_is_looked_at_again_after_half_an_hour(self, tmp_path):
        clock = Clock()
        p = pool(tmp_path, clock=clock)
        for _ in range(3):
            p.failure(A)
        p.success(B)
        clock.t += endpoints.PRIMARY_RETRY_S - 1
        assert p.pick() == B
        clock.t += 2
        assert p.pick() == A          # one look
        assert p.pick() == B          # and straight back until the next window

    def test_a_failed_look_back_costs_nothing(self, tmp_path):
        clock = Clock()
        p = pool(tmp_path, clock=clock)
        for _ in range(3):
            p.failure(A)
        p.success(B)
        clock.t += endpoints.PRIMARY_RETRY_S + 1
        assert p.pick() == A
        for _ in range(5):
            p.failure(A)
        assert p.current == B

    def test_a_successful_look_back_returns_to_the_primary(self, tmp_path):
        clock = Clock()
        p = pool(tmp_path, clock=clock)
        for _ in range(3):
            p.failure(A)
        p.success(B)
        clock.t += endpoints.PRIMARY_RETRY_S + 1
        p.success(p.pick())
        assert p.current == A
        assert (tmp_path / "api-host").read_text().strip() == A

    def test_a_single_host_never_moves(self, tmp_path):
        p = pool(tmp_path, urls=(A,))
        for _ in range(10):
            p.failure(A)
        assert p.pick() == A


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class TestIsThatOurWorker:
    def test_a_json_object_is_ours_whatever_the_status(self):
        assert endpoints.json_object(FakeResponse(401, {"error": "Unauthorized"})) is not None
        assert not endpoints.not_our_worker(FakeResponse(401, {"error": "Unauthorized"}))

    def test_a_filter_page_with_a_200_is_not_ours(self):
        assert endpoints.not_our_worker(FakeResponse(200, ValueError("html")))
        assert endpoints.not_our_worker(FakeResponse(403, ValueError("blocked")))

    def test_json_that_is_not_an_object_is_not_ours(self):
        assert endpoints.not_our_worker(FakeResponse(200, ["a", "list"]))

    def test_a_non_json_5xx_is_the_worker_having_a_bad_moment(self):
        """Every hostname fronts the same Worker, so failing over cannot help."""
        assert not endpoints.not_our_worker(FakeResponse(500, ValueError("text")))
