"""Shared pytest helpers for pipecat-app tests.

`flue_up`/`requires_flue` were independently redefined, byte-for-byte identical, in
test_interruption.py, test_flue_pipeline.py, and test_e2e_audio.py.
"""
import httpx
import pytest

FLUE_BASE = "http://127.0.0.1:3583"


def flue_up() -> bool:
    try:
        return httpx.get(f"{FLUE_BASE}/health", timeout=3).status_code == 200
    except Exception:
        return False


requires_flue = pytest.mark.skipif(not flue_up(), reason="flue agent service not running on :3583")
