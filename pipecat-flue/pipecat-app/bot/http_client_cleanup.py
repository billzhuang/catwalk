"""Shared teardown for classes that own an httpx.AsyncClient the base class
doesn't know about (built in __init__, not shared, so cleanup() must close it
explicitly or every instance leaks an open connection pool at pipeline teardown).
"""
from __future__ import annotations

import httpx


class OwnedHttpClientCleanupMixin:
    """Close self._client at teardown, even if super().cleanup() raises.

    List before any base class that defines cleanup() (e.g. STTService,
    TTSService, FrameProcessor) so this cleanup() runs first in the MRO.
    """

    _client: httpx.AsyncClient

    async def cleanup(self):
        try:
            await super().cleanup()
        finally:
            # getattr, not self._client directly: if __init__ raised before
            # _client was assigned, we must not mask that original error with
            # an unrelated AttributeError here.
            client = getattr(self, "_client", None)
            if client is not None:
                await client.aclose()
