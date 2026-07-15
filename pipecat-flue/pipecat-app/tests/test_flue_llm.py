"""Unit: FlueLLMProcessor._emit_usage's numeric-field coercion from flue's raw
usage dict, process_frame's fallback reply when the flue call itself fails, and
the barge-in abort path (_abort / _start_interruption). No network, no pipeline —
push_frame/create_task/the parent's _start_interruption are stubbed directly
since a real FrameProcessor requires a StartFrame before it will accept frames."""
from datetime import datetime, timezone

import httpx
import pytest
from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, TextFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from bot.flue_llm import FlueLLMProcessor


def _make_flue():
    flue = FlueLLMProcessor(conversation_id="test-usage")
    captured = []

    async def fake_push_frame(frame, direction=None):
        captured.append(frame)

    flue.push_frame = fake_push_frame
    return flue, captured


def _tokens(captured):
    return captured[0].data[0].value


@pytest.mark.asyncio
async def test_emit_usage_all_fields_present():
    flue, captured = _make_flue()
    await flue._emit_usage({"input": 10, "output": 5, "totalTokens": 15, "cacheRead": 3, "cacheWrite": 2})
    tokens = _tokens(captured)
    assert tokens.prompt_tokens == 10
    assert tokens.completion_tokens == 5
    assert tokens.total_tokens == 15
    assert tokens.cache_read_input_tokens == 3
    assert tokens.cache_creation_input_tokens == 2


@pytest.mark.asyncio
async def test_emit_usage_missing_fields_default_to_zero_or_fallback():
    flue, captured = _make_flue()
    await flue._emit_usage({"input": 7, "output": 2})
    tokens = _tokens(captured)
    assert tokens.prompt_tokens == 7
    assert tokens.completion_tokens == 2
    assert tokens.total_tokens == 9  # falls back to input + output
    assert tokens.cache_read_input_tokens == 0
    assert tokens.cache_creation_input_tokens == 0


@pytest.mark.asyncio
async def test_emit_usage_explicit_none_values_default_to_zero():
    flue, captured = _make_flue()
    await flue._emit_usage({"input": None, "output": None, "cacheRead": None, "cacheWrite": None})
    tokens = _tokens(captured)
    assert tokens.prompt_tokens == 0
    assert tokens.completion_tokens == 0
    assert tokens.total_tokens == 0
    assert tokens.cache_read_input_tokens == 0
    assert tokens.cache_creation_input_tokens == 0


@pytest.mark.asyncio
async def test_emit_usage_empty_usage_pushes_nothing():
    flue, captured = _make_flue()
    await flue._emit_usage({})
    assert captured == []


@pytest.mark.asyncio
async def test_process_frame_falls_back_to_apology_when_ask_fails():
    """If the flue call raises (network error, non-2xx, ...), process_frame must
    still close out the LLM turn with an apology TextFrame rather than propagating
    the exception, and must not emit a usage MetricsFrame since none was returned."""
    flue, captured = _make_flue()

    async def failing_ask(message):
        raise httpx.ConnectError("connection refused")

    flue.ask = failing_ask

    ts = datetime.now(timezone.utc).isoformat()
    await flue.process_frame(TranscriptionFrame("what's the weather", "user", ts), FrameDirection.DOWNSTREAM)

    assert [type(f) for f in captured] == [LLMFullResponseStartFrame, TextFrame, LLMFullResponseEndFrame]
    assert captured[1].text == "Sorry, I had trouble thinking just now. Could you say that again?"
    assert not flue._in_flight


@pytest.mark.asyncio
async def test_emit_usage_explicit_zero_total_tokens_is_not_overridden():
    flue, captured = _make_flue()
    await flue._emit_usage({"input": 3, "output": 4, "totalTokens": 0})
    tokens = _tokens(captured)
    assert tokens.prompt_tokens == 3
    assert tokens.completion_tokens == 4
    assert tokens.total_tokens == 0  # explicit 0 must win over the input+output fallback


@pytest.mark.asyncio
async def test_abort_posts_to_abort_endpoint_and_increments_count():
    flue, _ = _make_flue()
    calls = []

    async def fake_post(url, timeout=None):
        calls.append((url, timeout))

    flue._client.post = fake_post
    await flue._abort()

    assert flue.abort_count == 1
    assert calls == [(f"{flue._url}/abort", 10)]


@pytest.mark.asyncio
async def test_abort_swallows_post_exceptions():
    """The abort POST is best-effort (barge-in already happened locally); a
    failure here must not raise, only skip the server-side turn cancellation."""
    flue, _ = _make_flue()

    async def failing_post(url, timeout=None):
        raise httpx.ConnectError("connection refused")

    flue._client.post = failing_post
    await flue._abort()  # must not raise

    assert flue.abort_count == 1


@pytest.mark.asyncio
async def test_start_interruption_schedules_abort_when_in_flight(monkeypatch):
    flue, _ = _make_flue()
    flue._in_flight = True

    async def noop_super_start_interruption(self):
        pass

    monkeypatch.setattr(FrameProcessor, "_start_interruption", noop_super_start_interruption)

    scheduled = []
    flue.create_task = lambda coro, name=None, context=None: scheduled.append(coro)

    async def fake_post(url, timeout=None):
        pass

    flue._client.post = fake_post

    await flue._start_interruption()

    assert len(scheduled) == 1
    await scheduled[0]
    assert flue.abort_count == 1


@pytest.mark.asyncio
async def test_start_interruption_skips_abort_when_not_in_flight(monkeypatch):
    flue, _ = _make_flue()
    flue._in_flight = False

    async def noop_super_start_interruption(self):
        pass

    monkeypatch.setattr(FrameProcessor, "_start_interruption", noop_super_start_interruption)

    scheduled = []
    flue.create_task = lambda coro, name=None, context=None: scheduled.append(coro)

    await flue._start_interruption()

    assert scheduled == []
    assert flue.abort_count == 0
