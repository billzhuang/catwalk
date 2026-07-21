"""Unit: OwnedHttpClientCleanupMixin.cleanup()'s getattr(self, "_client", None) guard.

The mixin's docstring and inline comment say cleanup() must not raise AttributeError
when _client was never assigned (e.g. __init__ raised before reaching the assignment),
so the original error surfaces instead of being masked. The three concrete users
(FlueLLMProcessor, MaiTranscribeSTT, MaiVoiceTTS) always set _client in __init__, so
their own cleanup tests never exercise this branch. Tested here directly against the
mixin with a minimal dummy base class instead.
"""
from unittest.mock import AsyncMock

import pytest

from bot.http_client_cleanup import OwnedHttpClientCleanupMixin


class _Base:
    async def cleanup(self):
        pass


class _RaisingBase:
    async def cleanup(self):
        raise RuntimeError("boom")


class _NoClient(OwnedHttpClientCleanupMixin, _Base):
    pass


class _NoClientRaisingSuper(OwnedHttpClientCleanupMixin, _RaisingBase):
    pass


@pytest.mark.asyncio
async def test_cleanup_is_a_noop_when_client_was_never_assigned():
    await _NoClient().cleanup()  # must not raise AttributeError


@pytest.mark.asyncio
async def test_cleanup_without_client_still_propagates_super_cleanup_error():
    with pytest.raises(RuntimeError, match="boom"):
        await _NoClientRaisingSuper().cleanup()


@pytest.mark.asyncio
async def test_cleanup_closes_client_when_assigned():
    instance = _NoClient()
    instance._client = AsyncMock()

    await instance.cleanup()

    instance._client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_cleanup_closes_client_even_if_super_cleanup_raises():
    instance = _NoClientRaisingSuper()
    instance._client = AsyncMock()

    with pytest.raises(RuntimeError, match="boom"):
        await instance.cleanup()

    instance._client.aclose.assert_awaited_once()
