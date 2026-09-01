"""Which speaker the box should be relaying to, and where that answer survives.

The three-state convention is the whole subtlety here: None means "no opinion",
"" means "explicitly off", a MAC means "use this one". Collapsing the first two
into a falsy check is the bug this module exists to prevent - it would make the
"Use wired output" button silently do nothing on any box that has a speaker in
config.toml.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lockerroom import relaytarget  # noqa: E402

MAC_A = "AA:BB:CC:DD:EE:FF"
MAC_B = "11:22:33:44:55:66"


class TestResolve:
    def test_server_wins_over_everything(self):
        assert relaytarget.resolve(MAC_A, MAC_B, MAC_B) == MAC_A

    def test_cache_used_when_server_has_no_opinion(self):
        assert relaytarget.resolve(None, MAC_B, MAC_A) == MAC_B

    def test_config_used_when_nothing_else_has_an_opinion(self):
        assert relaytarget.resolve(None, None, MAC_A) == MAC_A

    def test_all_silent_is_no_relay(self):
        assert relaytarget.resolve(None, None, None) is None

    def test_server_off_beats_a_configured_mac(self):
        """The whole point of distinguishing "" from None. Pressing "Use wired
        output" has to override config.toml, or the button is a lie."""
        assert relaytarget.resolve("", None, MAC_A) is None

    def test_cached_off_beats_a_configured_mac(self):
        """Because the cache is how the off decision survives a reboot with no
        network - which is the state a locker room box comes back in."""
        assert relaytarget.resolve(None, "", MAC_A) is None

    def test_server_mac_overrides_a_cached_off(self):
        assert relaytarget.resolve(MAC_A, "", MAC_B) == MAC_A


class TestCache:
    def test_missing_file_reads_as_no_opinion(self, tmp_path):
        assert relaytarget.read_cache(tmp_path / "nope") is None

    def test_round_trip_a_mac(self, tmp_path):
        p = tmp_path / "target"
        relaytarget.write_cache(p, MAC_A)
        assert relaytarget.read_cache(p) == MAC_A

    def test_round_trip_an_explicit_off(self, tmp_path):
        p = tmp_path / "target"
        relaytarget.write_cache(p, "")
        assert relaytarget.read_cache(p) == ""

    def test_write_none_removes_the_file(self, tmp_path):
        """None is "no opinion", and the only honest way to store that is to
        have nothing stored at all."""
        p = tmp_path / "target"
        relaytarget.write_cache(p, MAC_A)
        relaytarget.write_cache(p, None)
        assert not p.exists()
        assert relaytarget.read_cache(p) is None

    def test_garbage_reads_as_no_opinion_rather_than_raising(self, tmp_path):
        """A corrupt cache must not wedge the listener at startup. The MAC is
        cheap to re-learn from the next beacon; a crash loop is not."""
        p = tmp_path / "target"
        p.write_text("not-a-mac\n")
        assert relaytarget.read_cache(p) is None

    def test_lowercase_is_normalised_on_read(self, tmp_path):
        p = tmp_path / "target"
        p.write_text("aa:bb:cc:dd:ee:ff\n")
        assert relaytarget.read_cache(p) == MAC_A

    def test_write_creates_the_parent_directory(self, tmp_path):
        p = tmp_path / "deep" / "deeper" / "target"
        relaytarget.write_cache(p, MAC_A)
        assert relaytarget.read_cache(p) == MAC_A

    def test_write_is_atomic_leaving_no_temp_files(self, tmp_path):
        p = tmp_path / "target"
        relaytarget.write_cache(p, MAC_A)
        assert [f.name for f in tmp_path.iterdir()] == ["target"]


class TestNormaliseServerValue:
    """What arrives on the beacon is JSON from a server we do not trust to be
    the only gate - the same stance control.py takes on the command allowlist."""

    def test_a_mac_is_accepted_and_upper_cased(self):
        assert relaytarget.from_server("aa:bb:cc:dd:ee:ff") == MAC_A

    def test_empty_string_is_an_explicit_off(self):
        assert relaytarget.from_server("") == ""

    def test_null_is_no_opinion(self):
        assert relaytarget.from_server(None) is None

    def test_garbage_is_refused_as_no_opinion(self):
        assert relaytarget.from_server("; rm -rf /") is None

    def test_wrong_type_is_refused(self):
        assert relaytarget.from_server({"mac": MAC_A}) is None
