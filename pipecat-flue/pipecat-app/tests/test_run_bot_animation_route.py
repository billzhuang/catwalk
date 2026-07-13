"""Unit: GET /animation-svg/{topic}'s title/steps query-param wiring into
bot.animations.render(). No network, no pipeline — calls the route function directly."""
import pytest

from run_bot import animation_svg


@pytest.mark.asyncio
async def test_hand_built_topic_ignores_title_and_steps():
    res = await animation_svg("sine", title="ignored", steps=["ignored"])
    assert res.status_code == 200
    assert res.media_type == "image/svg+xml"


@pytest.mark.asyncio
async def test_on_the_fly_topic_with_title_and_steps_renders():
    res = await animation_svg("fourier_series", title="Fourier series", steps=["Step one"])
    assert res.status_code == 200
    assert b"Fourier series" in res.body


@pytest.mark.asyncio
async def test_on_the_fly_topic_without_title_or_steps_is_404():
    res = await animation_svg("fourier_series", title=None, steps=None)
    assert res.status_code == 404
