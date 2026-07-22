"""Unit: `_flue_client` (the animation-poll proxy's shared httpx.AsyncClient, a bare
module-level global rather than a pipeline-stage-owned client) is closed on the FastAPI
app's shutdown event — otherwise it leaks an open connection pool for the process's
lifetime, unlike every other owned httpx.AsyncClient in this codebase (FlueLLMProcessor,
MaiTranscribeSTT, MaiVoiceTTS), which are closed via OwnedHttpClientCleanupMixin at
pipeline teardown."""
from unittest.mock import AsyncMock

import pytest

import run_bot


def test_close_flue_client_is_registered_as_a_shutdown_handler():
    assert run_bot._close_flue_client in run_bot.app.router.on_shutdown


@pytest.mark.asyncio
async def test_close_flue_client_closes_the_shared_client(monkeypatch):
    closed = AsyncMock(wraps=run_bot._flue_client.aclose)
    monkeypatch.setattr(run_bot._flue_client, "aclose", closed)

    await run_bot._close_flue_client()

    closed.assert_awaited_once()
