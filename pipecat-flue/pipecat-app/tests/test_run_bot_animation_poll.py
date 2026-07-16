"""Unit: GET /animation/{cid}, the proxy that forwards to flue's own /animation/{cid} and
never lets a flue-unreachable/malformed-response failure surface as a 500 to the poller."""
import httpx
import pytest

import run_bot
from run_bot import animation_poll


@pytest.mark.asyncio
async def test_proxies_flue_response_on_success(monkeypatch):
    def handler(request):
        assert request.url.path == "/animation/abc123"
        return httpx.Response(200, json={"topic": "sine", "revision": 3})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(run_bot, "_flue_client", client)

        res = await animation_poll("abc123")

        assert res.status_code == 200
        assert res.headers["cache-control"] == "no-store"
        assert res.body == b'{"topic":"sine","revision":3}'


@pytest.mark.asyncio
async def test_falls_back_to_null_topic_when_flue_is_unreachable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(run_bot, "_flue_client", client)

        res = await animation_poll("abc123")

        assert res.status_code == 200
        assert res.headers["cache-control"] == "no-store"
        assert res.body == b'{"topic":null}'
