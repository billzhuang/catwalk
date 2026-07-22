"""Unit: `_flue_client` (the animation-poll proxy's shared httpx.AsyncClient, a bare
module-level global rather than a pipeline-stage-owned client) is closed on the FastAPI
app's shutdown event — otherwise it leaks an open connection pool for the process's
lifetime, unlike every other owned httpx.AsyncClient in this codebase (FlueLLMProcessor,
MaiTranscribeSTT, MaiVoiceTTS), which are closed via OwnedHttpClientCleanupMixin at
pipeline teardown. It's also recreated on startup, so a second lifespan cycle in the same
interpreter doesn't leave animation_poll silently proxying through an already-closed client."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import run_bot


def test_close_flue_client_is_registered_as_a_shutdown_handler():
    assert run_bot._close_flue_client in run_bot.app.router.on_shutdown


def test_open_flue_client_is_registered_as_a_startup_handler():
    assert run_bot._open_flue_client in run_bot.app.router.on_startup


@pytest.mark.asyncio
async def test_close_flue_client_closes_the_shared_client(monkeypatch):
    # A fake stand-in, not the real shared client: closing the actual module-level
    # httpx.AsyncClient here would leave it closed for the rest of the test session, since
    # monkeypatch only restores the attribute reference, not the closed connection pool.
    closed = AsyncMock()
    monkeypatch.setattr(run_bot, "_flue_client", SimpleNamespace(aclose=closed))

    await run_bot._close_flue_client()

    closed.assert_awaited_once()


@pytest.mark.asyncio
async def test_open_flue_client_replaces_a_closed_client_with_a_usable_one():
    original = run_bot._flue_client
    try:
        await original.aclose()

        await run_bot._open_flue_client()

        assert run_bot._flue_client is not original
        assert run_bot._flue_client.is_closed is False
    finally:
        await run_bot._flue_client.aclose()
        run_bot._flue_client = original
