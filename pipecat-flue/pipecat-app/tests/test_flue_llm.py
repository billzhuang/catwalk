"""Unit: FlueLLMProcessor._emit_usage's numeric-field coercion from flue's raw
usage dict. No network, no pipeline — push_frame is stubbed directly since a
real FrameProcessor requires a StartFrame before it will accept frames."""
import pytest

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
async def test_emit_usage_explicit_zero_total_tokens_is_not_overridden():
    flue, captured = _make_flue()
    await flue._emit_usage({"input": 3, "output": 4, "totalTokens": 0})
    tokens = _tokens(captured)
    assert tokens.prompt_tokens == 3
    assert tokens.completion_tokens == 4
    assert tokens.total_tokens == 0  # explicit 0 must win over the input+output fallback
