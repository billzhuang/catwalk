"""Shared pytest helpers for pipecat-app tests.

`flue_up`/`requires_flue` were independently redefined, byte-for-byte identical, in
test_interruption.py, test_flue_pipeline.py, and test_e2e_audio.py.

`Capture` was also independently redefined in all three files, each tapping a different
subset of frame types into its own fields; unified here so a test just reads whichever
fields it cares about and leaves the rest empty.

`start_pipeline_task`/`stop_pipeline_task` unify the runner-with-settle-delay dance that
test_interruption.py and test_e2e_audio.py (two call sites) each hand-rolled identically.

`write_aifoundry_env` unifies the "write a fake ~/env/aifoundry.sh under tmp_path" fixture
that test_azure.py, test_mai_stt_transcribe.py, and test_mai_tts_synthesize.py each
hand-rolled identically (only the file contents differed).

`async_return` unifies the async-value-stub helper that test_mai_stt_transcribe.py and
test_mai_tts_synthesize.py each hand-rolled identically (as `_async_return`).
"""
import asyncio
from typing import Any

import httpx
import pytest
from pipecat.frames.frames import Frame, MetricsFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.metrics.metrics import LLMUsageMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

FLUE_BASE = "http://127.0.0.1:3583"


def flue_up() -> bool:
    try:
        return httpx.get(f"{FLUE_BASE}/health", timeout=3).status_code == 200
    except Exception:
        return False


requires_flue = pytest.mark.skipif(not flue_up(), reason="flue agent service not running on :3583")


class Capture(FrameProcessor):
    """Test double that records frames of interest and passes everything through unmodified."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.texts: list[str] = []
        self.transcripts: list[str] = []
        self.prompt_tokens = 0
        self.tts_bytes = bytearray()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self.transcripts.append(frame.text)
        elif isinstance(frame, TextFrame):
            self.texts.append(frame.text)
        elif isinstance(frame, TTSAudioRawFrame):
            self.tts_bytes.extend(frame.audio)
        elif isinstance(frame, MetricsFrame):
            for d in frame.data:
                if isinstance(d, LLMUsageMetricsData):
                    self.prompt_tokens += d.value.prompt_tokens
        await self.push_frame(frame, direction)


async def start_pipeline_task(
    processors: list[FrameProcessor], params: PipelineParams, *, settle: float = 0.5
) -> tuple[PipelineTask, "asyncio.Task"]:
    """Build and start a PipelineTask the way these integration tests need it run: no RTVI,
    no turn tracking, no idle-timeout cancellation, plus `settle` seconds for StartFrame to
    propagate before the caller queues frames."""
    task = PipelineTask(
        Pipeline(processors),
        params=params,
        enable_rtvi=False,
        enable_turn_tracking=False,
        cancel_on_idle_timeout=False,
    )
    run = asyncio.create_task(PipelineRunner(handle_sigint=False).run(task))
    await asyncio.sleep(settle)
    return task, run


async def stop_pipeline_task(task: PipelineTask, run: "asyncio.Task", *, timeout: float) -> None:
    await task.stop_when_done()
    await asyncio.wait_for(run, timeout=timeout)


def write_aifoundry_env(tmp_path, contents: str) -> str:
    """Write `contents` to a fake aifoundry.sh under tmp_path and return its path."""
    p = tmp_path / "aifoundry.sh"
    p.write_text(contents, encoding="utf-8")
    return str(p)


async def async_return(value: Any) -> Any:
    return value
