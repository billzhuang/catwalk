"""Unit: conftest.py's close_pipeline_http_clients() helper.

The four call sites (test_run_bot_build_pipeline.py x3, test_run_bot_bot_entrypoint.py)
only prove the helper doesn't raise against a real build_pipeline() pipeline, where every
stage either has a real _client or doesn't. Tested here directly against fake stages so
the "closes every _client, skips stages without one" contract is pinned independent of
build_pipeline's actual wiring.
"""
from unittest.mock import AsyncMock

import pytest
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameProcessor

from tests.conftest import close_pipeline_http_clients


class _WithClient(FrameProcessor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._client = AsyncMock()


class _WithoutClient(FrameProcessor):
    pass


@pytest.mark.asyncio
async def test_closes_every_stage_that_owns_a_client():
    with_client_a = _WithClient(name="a")
    with_client_b = _WithClient(name="b")
    pipeline = Pipeline([with_client_a, _WithoutClient(name="mid"), with_client_b])

    await close_pipeline_http_clients(pipeline)

    with_client_a._client.aclose.assert_awaited_once()
    with_client_b._client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_is_a_noop_when_no_stage_owns_a_client():
    pipeline = Pipeline([_WithoutClient(name="only")])

    await close_pipeline_http_clients(pipeline)  # must not raise AttributeError
