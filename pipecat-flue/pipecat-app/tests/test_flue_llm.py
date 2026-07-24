"""Unit: FlueLLMProcessor._emit_usage's numeric-field coercion from flue's raw
usage dict, process_frame's success and fallback-reply paths, its blank-text and
non-TranscriptionFrame branches, ask()'s request/response parsing, and the
barge-in abort path (_abort / _start_interruption). No network, no pipeline —
push_frame/create_task/the parent's _start_interruption are stubbed directly
since a real FrameProcessor requires a StartFrame before it will accept frames;
ask() is exercised against an httpx.MockTransport instead, since it's the one
method here that actually builds the request and parses a response."""
import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pipecat.frames.frames import (
    EndFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    MetricsFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from bot.flue_llm import MODEL_LABEL, FlueLLMProcessor


def test_model_label_matches_flue_agent_default():
    """MODEL_LABEL only feeds Token Usage telemetry (flue itself picks the real model per
    flue-agent's FLUE_MODEL/model-config.ts), but its os.environ fallback is a separate literal
    that has to be hand-kept equal to model-config.ts's DEFAULT_MODEL — nothing but a comment
    claims they agree. Pins the two in sync so a default-model bump on one side without the
    other fails here instead of silently mislabeling usage metrics with the wrong model name."""
    pipecat_flue_root = Path(__file__).resolve().parents[2]
    model_config_ts = (pipecat_flue_root / "flue-agent" / "src" / "model-config.ts").read_text(
        encoding="utf-8"
    )

    default_model = re.search(r"DEFAULT_MODEL\s*=\s*'([^']+)'", model_config_ts)
    assert default_model, "couldn't find DEFAULT_MODEL in model-config.ts"

    assert MODEL_LABEL == default_model.group(1)


def test_model_label_falls_back_to_default_on_blank_flue_model(monkeypatch):
    """os.environ.get(key, default) only substitutes `default` when the key is absent, not when
    it's present-but-blank (e.g. a shell `export FLUE_MODEL=` left over from trying a different
    deployment). flue-agent's twin, model-config.ts's resolveModel(), trims and treats blank as
    unset; MODEL_LABEL must mirror that so an empty/whitespace FLUE_MODEL doesn't silently tag
    every usage-metrics frame with an empty model name instead of the real default."""
    import importlib

    import bot.flue_llm as flue_llm_module

    monkeypatch.setenv("FLUE_MODEL", "   ")
    try:
        importlib.reload(flue_llm_module)
        assert flue_llm_module.MODEL_LABEL == "azure/gpt-5.4"
    finally:
        monkeypatch.delenv("FLUE_MODEL", raising=False)
        importlib.reload(flue_llm_module)


def _make_flue():
    flue = FlueLLMProcessor(conversation_id="test-usage")
    captured = []

    async def fake_push_frame(frame, direction=None):
        captured.append(frame)

    flue.push_frame = fake_push_frame
    # Default no-op: create_task() needs a running pipeline's TaskManager, which
    # these unit tests don't set up. Tests exercising a create_task() call site
    # override this to capture and run the scheduled coroutine themselves.
    flue.create_task = lambda coro, name=None, context=None: coro.close()
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
async def test_ask_posts_message_and_parses_stripped_reply_and_usage():
    """ask() must POST {"message": ...} to `{url}?wait=result`, then return the
    stripped reply text and the raw usage dict from flue's response envelope."""
    flue, _ = _make_flue()
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"result": {"text": "  Sunny in Tokyo.  ", "usage": {"input": 3}}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        flue._client = client
        reply, usage = await flue.ask("weather in tokyo")

    assert reply == "Sunny in Tokyo."
    assert usage == {"input": 3}
    assert requests[0].url.path == "/agents/weather/test-usage"
    assert requests[0].url.params["wait"] == "result"
    assert json.loads(requests[0].content) == {"message": "weather in tokyo"}


@pytest.mark.asyncio
async def test_ask_defaults_missing_result_text_and_usage_to_empty():
    """A response missing `result` (or `text`/`usage` within it) must default to
    an empty string / empty dict rather than raising a KeyError/AttributeError."""
    flue, _ = _make_flue()

    def handler(request):
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        flue._client = client
        reply, usage = await flue.ask("anything")

    assert reply == ""
    assert usage == {}


@pytest.mark.asyncio
async def test_ask_defaults_explicit_none_result_text_and_usage_to_empty():
    """flue may send `text`/`usage` as explicit JSON null rather than omitting
    them; `.get(key, default)` only falls back on a *missing* key, so an
    explicit None must be handled separately or `None.strip()` raises."""
    flue, _ = _make_flue()

    def handler(request):
        return httpx.Response(200, json={"result": {"text": None, "usage": None}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        flue._client = client
        reply, usage = await flue.ask("anything")

    assert reply == ""
    assert usage == {}


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
async def test_process_frame_aborts_flue_turn_when_ask_fails():
    """A client-side give-up on ask() (timeout, connection error, non-2xx) doesn't
    stop flue's server-side turn any more than a client disconnect would (see the
    module docstring) — process_frame must schedule the same /agents/weather/:id/abort
    the barge-in path already fires, or an abandoned turn keeps running server-side
    burning tokens/compute and can still land a stale animation update. Scheduled via
    create_task (like _start_interruption) rather than awaited, so this best-effort
    cleanup call can't delay the apology reply."""
    flue, _ = _make_flue()

    async def failing_ask(message):
        raise httpx.ConnectError("connection refused")

    flue.ask = failing_ask

    scheduled = []
    flue.create_task = lambda coro, name=None, context=None: scheduled.append(coro)

    abort_calls = []

    async def fake_abort():
        abort_calls.append(True)

    flue._abort = fake_abort

    ts = datetime.now(timezone.utc).isoformat()
    await flue.process_frame(TranscriptionFrame("what's the weather", "user", ts), FrameDirection.DOWNSTREAM)

    assert len(scheduled) == 1
    await scheduled[0]
    assert abort_calls == [True]


@pytest.mark.asyncio
async def test_await_pending_abort_noop_when_nothing_pending():
    flue, _ = _make_flue()
    await flue._await_pending_abort()  # must not raise
    assert flue._pending_abort is None


@pytest.mark.asyncio
async def test_await_pending_abort_swallows_task_exceptions_and_clears_it():
    """A pending abort task failing (not just its own internal try/except, but e.g.
    the task itself being torn down oddly) must not propagate into the next turn."""
    flue, _ = _make_flue()

    async def raising():
        raise RuntimeError("boom")

    flue._pending_abort = asyncio.ensure_future(raising())
    await flue._await_pending_abort()  # must not raise

    assert flue._pending_abort is None


@pytest.mark.asyncio
async def test_await_pending_abort_survives_a_second_barge_in_mid_wait():
    """A second barge-in can cancel the *next* turn's process task while it's still
    inside _await_pending_abort, waiting for the previous turn's stale abort. Since
    asyncio delegates a task's cancellation to whatever it's currently awaiting, an
    unshielded `await pending` would take the abort task down with it — silently
    killing the abort mid-flight, right after the reference to it was already
    cleared, so nothing would ever notice or retry it. The abort task must keep
    running detached through that cancellation, and stay tracked in _pending_abort
    so a later turn still waits for it."""
    flue, _ = _make_flue()

    async def slow_abort():
        await asyncio.sleep(10)

    original_abort_task = asyncio.ensure_future(slow_abort())
    flue._pending_abort = original_abort_task
    await asyncio.sleep(0)  # let it start sleeping

    waiter_task = asyncio.ensure_future(flue._await_pending_abort())
    await asyncio.sleep(0)  # let it start awaiting the pending abort

    waiter_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter_task

    assert not original_abort_task.cancelled()
    assert not original_abort_task.done()
    assert flue._pending_abort is original_abort_task

    original_abort_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await original_abort_task


@pytest.mark.asyncio
async def test_process_frame_waits_for_pending_abort_before_next_turns_request():
    """/abort targets the conversation id, not a specific turn — it has no per-turn
    correlation token. If a detached abort left over from a failed/interrupted turn
    is still in flight when the *next* turn's ask() fires, it could land at flue
    after that new turn has already started there and cancel the wrong one. The
    next turn must fully resolve any pending abort (success or its own giveup)
    before sending its own request."""
    flue, _ = _make_flue()

    order = []
    release_abort = asyncio.Event()

    async def slow_abort():
        order.append("abort-start")
        await release_abort.wait()
        order.append("abort-end")

    flue._abort = slow_abort
    flue.create_task = lambda coro, name=None, context=None: asyncio.ensure_future(coro)

    async def failing_ask(message):
        raise httpx.ConnectError("connection refused")

    flue.ask = failing_ask

    ts = datetime.now(timezone.utc).isoformat()
    await flue.process_frame(TranscriptionFrame("first", "user", ts), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0)  # let the detached abort task actually start running

    assert order == ["abort-start"]

    async def second_ask(message):
        order.append("ask-called")
        return "ok", {}

    flue.ask = second_ask

    process_task = asyncio.ensure_future(
        flue.process_frame(TranscriptionFrame("second", "user", ts), FrameDirection.DOWNSTREAM)
    )
    await asyncio.sleep(0)
    # Must be blocked awaiting the still-pending abort, not calling ask() yet.
    assert order == ["abort-start"]

    release_abort.set()
    await process_task

    assert order == ["abort-start", "abort-end", "ask-called"]


@pytest.mark.asyncio
async def test_process_frame_success_pushes_reply_and_usage_in_order():
    """When ask() succeeds, process_frame must push Start -> reply TextFrame ->
    usage MetricsFrame -> End, in that order, and clear _in_flight afterward."""
    flue, captured = _make_flue()

    async def fake_ask(message):
        assert message == "what's the weather"
        return "It's sunny and 72 degrees.", {"input": 10, "output": 5}

    flue.ask = fake_ask

    ts = datetime.now(timezone.utc).isoformat()
    await flue.process_frame(TranscriptionFrame("what's the weather", "user", ts), FrameDirection.DOWNSTREAM)

    assert [type(f) for f in captured] == [
        LLMFullResponseStartFrame,
        TextFrame,
        MetricsFrame,
        LLMFullResponseEndFrame,
    ]
    assert captured[1].text == "It's sunny and 72 degrees."
    assert captured[2].data[0].value.prompt_tokens == 10
    assert not flue._in_flight


@pytest.mark.asyncio
async def test_process_frame_blank_text_pushes_nothing():
    """Whitespace-only transcripts (e.g. a VAD false-positive) must be dropped
    before the flue call, pushing no frames at all."""
    flue, captured = _make_flue()

    async def unexpected_ask(message):
        raise AssertionError("ask() must not be called for a blank transcript")

    flue.ask = unexpected_ask

    ts = datetime.now(timezone.utc).isoformat()
    await flue.process_frame(TranscriptionFrame("   ", "user", ts), FrameDirection.DOWNSTREAM)

    assert captured == []


@pytest.mark.asyncio
async def test_process_frame_forwards_non_transcription_frames_untouched():
    """Frames that aren't a TranscriptionFrame (Start/End/audio/control) must be
    forwarded as-is, with direction preserved, and never reach ask()."""
    flue, captured = _make_flue()
    directions = []

    async def fake_push_frame(frame, direction=None):
        captured.append(frame)
        directions.append(direction)

    flue.push_frame = fake_push_frame

    frame = EndFrame()
    await flue.process_frame(frame, FrameDirection.UPSTREAM)

    assert captured == [frame]
    assert directions == [FrameDirection.UPSTREAM]


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
async def test_cleanup_closes_owned_http_client():
    """FlueLLMProcessor owns its httpx.AsyncClient (built in __init__, not shared) and
    the base FrameProcessor.cleanup() has no way to know about it, so it must be closed
    explicitly here or every call leaks an open connection pool at pipeline teardown.
    Wraps the real aclose (rather than replacing it with a bare stub) so the client's
    underlying connection pool is actually released instead of leaking in the test."""
    flue, _ = _make_flue()
    flue._client.aclose = AsyncMock(wraps=flue._client.aclose)

    await flue.cleanup()

    flue._client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_cleanup_still_closes_client_when_super_cleanup_raises(monkeypatch):
    """The owned client must be closed even if the parent FrameProcessor.cleanup() raises,
    otherwise a failure in the base teardown path leaks the connection pool anyway."""
    flue, _ = _make_flue()
    flue._client.aclose = AsyncMock(wraps=flue._client.aclose)

    async def raising_super_cleanup(self):
        raise RuntimeError("boom")

    monkeypatch.setattr(FrameProcessor, "cleanup", raising_super_cleanup)

    with pytest.raises(RuntimeError, match="boom"):
        await flue.cleanup()

    flue._client.aclose.assert_awaited_once()


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
