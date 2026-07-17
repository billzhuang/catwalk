"""Unit: GET / (root_to_app) and GET /app, /app/ (app_client) — the two routes that steer
browsers to our custom client instead of pipecat's prebuilt one. No network, no pipeline —
calls the route functions directly."""
import pytest

from run_bot import CLIENT_DIR, app_client, root_to_app


@pytest.mark.asyncio
async def test_root_redirects_to_app():
    res = await root_to_app()
    assert res.status_code == 307
    assert res.headers["location"] == "/app/"


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
