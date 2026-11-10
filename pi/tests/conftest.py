"""Shared fixtures. `lockerroom` is importable via pythonpath in pyproject.toml."""

from __future__ import annotations

import pytest

from lockerroom import netwatch as _netwatch

_REAL_PCM_RUNNING = _netwatch.pcm_running


@pytest.fixture(autouse=True)
def no_real_audio_state(monkeypatch):
    """netwatch asks /proc/asound whether music is playing before it reboots.

    On a laptop with a song on, that would change what these tests see. No
    test may depend on what the machine running it happens to be doing.
    """
    from lockerroom import netwatch

    monkeypatch.setattr(netwatch, "pcm_running", lambda *a, **k: False)


@pytest.fixture
def real_pcm_running():
    """The real function, for the test that is about the function itself."""
    return _REAL_PCM_RUNNING
