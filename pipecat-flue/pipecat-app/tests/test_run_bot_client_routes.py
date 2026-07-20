"""Unit: GET / (root_to_app) and GET /app, /app/ (app_client) — the two routes that steer
browsers to our custom client instead of pipecat's prebuilt one. No network, no pipeline —
calls the route functions directly."""
import httpx
import pytest

from pipecat.runner.run import _setup_frontend_routes
from run_bot import CLIENT_DIR, app, app_client, root_to_app


@pytest.mark.asyncio
async def test_root_redirects_to_app():
    res = await root_to_app()
    assert res.status_code == 307
    assert res.headers["location"] == "/app/"


@pytest.mark.asyncio
async def test_root_route_wins_over_prebuilt_client_redirect_through_real_routing():
    """`root_to_app` (registered at import time, before `main()` runs) is meant to win the
    route-resolution race against pipecat's own `/` -> /client/ redirect, which `main()` only
    registers later via `_setup_frontend_routes`. The plain-function unit test above can't
    observe that race at all — it calls `root_to_app` directly, bypassing Starlette's route
    table entirely. Exercise the real app through ASGI so a route-registration-order
    regression (e.g. from reordering `run_bot.py`'s imports/calls, or a pipecat upgrade that
    registers its redirect earlier) would actually be caught."""
    original_routes = list(app.router.routes)
    try:
        _setup_frontend_routes(app)  # simulates what main() does, registering the competing route

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/", follow_redirects=False)

        assert res.status_code == 307
        assert res.headers["location"] == "/app/"
    finally:
        app.router.routes[:] = original_routes


@pytest.mark.asyncio
async def test_app_client_serves_index_html_no_store():
    res = await app_client()
    assert res.status_code == 200
    assert res.media_type == "text/html"
    assert res.headers["cache-control"] == "no-store"
    assert res.path == CLIENT_DIR / "index.html"


@pytest.mark.asyncio
async def test_app_client_404s_when_index_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr("run_bot.CLIENT_DIR", tmp_path)

    res = await app_client()

    assert res.status_code == 404
    assert res.media_type == "text/plain"
