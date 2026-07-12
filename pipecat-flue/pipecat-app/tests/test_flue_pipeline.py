"""Integration: flue sits in the LLM slot of a real pipecat pipeline.

Runs an actual Pipeline headlessly (no audio transport): inject a
TranscriptionFrame as if STT produced it, and capture the TextFrame the flue
harness emits for TTS. Requires the flue agent service running on :3583.
"""
from datetime import datetime, timezone

import pytest
from pipecat.frames.frames import EndFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask

from bot.flue_llm import FlueLLMProcessor
from tests.conftest import Capture, requires_flue


@requires_flue
@pytest.mark.asyncio
async def test_flue_ask_direct():
    flue = FlueLLMProcessor(conversation_id="test-direct")
    reply, usage = await flue.ask("What is the weather in Tokyo right now?")
    assert reply, "empty reply"
    assert usage.get("input", 0) > 0, "flue usage not returned"
    assert any(w in reply.lower() for w in ["degree", "tokyo", "cloud", "clear", "rain", "warm", "cool"])


@requires_flue
@pytest.mark.asyncio
async def test_flue_in_pipeline():
    flue = FlueLLMProcessor(conversation_id="test-pipeline")
    cap = Capture()
    task = PipelineTask(Pipeline([flue, cap]), enable_rtvi=False, enable_turn_tracking=False)
    ts = datetime.now(timezone.utc).isoformat()
    await task.queue_frames([
        TranscriptionFrame("What is the weather in Paris right now?", "user", ts),
        EndFrame(),
    ])
    await PipelineRunner().run(task)
    joined = " ".join(cap.texts).lower()
    assert cap.texts, "no TextFrame emitted by flue processor"
    assert "paris" in joined or "degree" in joined, f"unexpected reply: {cap.texts!r}"
    assert cap.prompt_tokens > 0, "no LLM token-usage metric emitted (Token Usage panel would be empty)"
