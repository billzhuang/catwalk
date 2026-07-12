"""Barge-in: interrupting mid-turn cancels the flue call and drops the reply.

Injects an InterruptionFrame (what UserTurnProcessor broadcasts when the user
starts talking) into a [flue, capture] pipeline while flue is thinking, and
asserts (1) no reply TextFrame is delivered and (2) flue's /abort was called.
Requires the flue agent service on :3583.
"""
import asyncio
from datetime import datetime, timezone

import pytest
from pipecat.frames.frames import InterruptionFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

from bot.flue_llm import FlueLLMProcessor
from tests.conftest import Capture, requires_flue


@requires_flue
@pytest.mark.asyncio
async def test_barge_in_aborts_and_drops_reply():
    flue = FlueLLMProcessor(conversation_id="test-interrupt")
    cap = Capture()
    task = PipelineTask(
        Pipeline([flue, cap]),
        params=PipelineParams(enable_metrics=False),
        enable_rtvi=False,
        enable_turn_tracking=False,
        cancel_on_idle_timeout=False,
    )
    runner = PipelineRunner(handle_sigint=False)
    run = asyncio.create_task(runner.run(task))
    await asyncio.sleep(0.5)  # StartFrame settles

    ts = datetime.now(timezone.utc).isoformat()
    await task.queue_frames([
        TranscriptionFrame(
            "Give me a long, detailed rundown of the weather across many world cities.",
            "user",
            ts,
        ),
    ])

    # Wait until the flue request is actually in flight, then barge in.
    for _ in range(80):
        if flue._in_flight:
            break
        await asyncio.sleep(0.1)
    assert flue._in_flight, "flue request never started"

    await task.queue_frames([InterruptionFrame()])
    await asyncio.sleep(1.5)  # let cancellation + abort settle

    await task.stop_when_done()
    await asyncio.wait_for(run, timeout=15)

    assert flue.abort_count >= 1, "flue /abort was not called on interruption"
    assert not cap.texts, f"reply should have been dropped on barge-in, got {cap.texts!r}"
