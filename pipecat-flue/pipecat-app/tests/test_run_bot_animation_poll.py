"""Unit: GET /animation/{cid}, the proxy that forwards to flue's own /animation/{cid} and
never lets a flue-unreachable/malformed-response failure surface as a 500 to the poller."""
from contextlib import asynccontextmanager

import httpx
import pytest

import run_bot
from run_bot import animation_poll


@asynccontextmanager
async def _mock_flue_client(monkeypatch, handler):
    """Swaps run_bot's module-level `_flue_client` global for one backed by
    httpx.MockTransport(handler) for the block's duration — the setup every test below
    otherwise repeats verbatim. `_flue_client` is a bare module global rather than an
    instance attribute (see test_run_bot_flue_client_shutdown.py), so conftest.py's
    with_mock_transport_client (which swaps an *instance's* `._client`) doesn't fit here."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        monkeypatch.setattr(run_bot, "_flue_client", client)
        yield


@pytest.mark.asyncio
async def test_proxies_flue_response_on_success(monkeypatch):
    def handler(request):
        assert request.url.path == "/animation/abc123"
        return httpx.Response(200, json={"topic": "sine", "revision": 3})

    async with _mock_flue_client(monkeypatch, handler):
        res = await animation_poll("abc123")

        assert res.status_code == 200
        assert res.headers["cache-control"] == "no-store"
        assert res.body == b'{"topic":"sine","revision":3}'


@pytest.mark.asyncio
async def test_falls_back_to_null_topic_when_flue_is_unreachable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    async with _mock_flue_client(monkeypatch, handler):
        res = await animation_poll("abc123")

        assert res.status_code == 200
        assert res.headers["cache-control"] == "no-store"
        assert res.body == b'{"topic":null}'


@pytest.mark.asyncio
async def test_rejects_path_traversal_cid_without_proxying_it(monkeypatch):
    """cid is f-string-interpolated straight into the proxied request URL, the same
    confused-deputy shape resolve_conversation_id's clientId guard exists for (see
    _SAFE_CONVERSATION_ID in run_bot.py) — an unvalidated cid could steer this call at
    flue-agent's internal routes instead of its own /animation/{cid}. Must be rejected before
    ever touching the network, not merely have its result discarded."""
    def handler(request):
        raise AssertionError(f"must not proxy a traversal cid, got {request.url}")

    async with _mock_flue_client(monkeypatch, handler):
        res = await animation_poll("../az/v1/models")

        assert res.status_code == 400
        assert res.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_rejects_cid_containing_a_slash(monkeypatch):
    def handler(request):
        raise AssertionError(f"must not proxy a cid containing a slash, got {request.url}")

    async with _mock_flue_client(monkeypatch, handler):
        res = await animation_poll("a/b")

        assert res.status_code == 400
        assert res.headers["cache-control"] == "no-store"
