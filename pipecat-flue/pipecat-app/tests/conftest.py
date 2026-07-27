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

`TWO_REGION_AIFOUNDRY_SH` unifies the byte-for-byte identical two-region `aifoundry.sh`
contents that test_run_bot_build_pipeline.py and test_run_bot_bot_entrypoint.py each
hand-rolled as their own module-level `AIFOUNDRY_SH` constant.

`async_return` unifies the async-value-stub helper that test_mai_stt_transcribe.py and
test_mai_tts_synthesize.py each hand-rolled identically (as `_async_return`).

`FakeTransport` unifies the duck-typed transport stub that test_run_bot_build_pipeline.py
and test_run_bot_bot_entrypoint.py each hand-rolled identically (as `_FakeTransport`).

`requires_aifoundry` guards test_mai_rest.py's live-network integration tests, which call
bot.azure.tts_block()/stt_block() and so need real credentials at ~/env/aifoundry.sh (or
$AIFOUNDRY_ENV) — without a skip guard those tests errored (FileNotFoundError), rather than
skipped, on any machine lacking that uncommitted secrets file.

`assert_cleanup_closes_owned_client`/`assert_cleanup_still_closes_client_when_super_cleanup_raises`
unify the pair of OwnedHttpClientCleanupMixin characterization tests that test_flue_llm.py,
test_mai_stt_transcribe.py, and test_mai_tts_synthesize.py each hand-rolled identically for their
own concrete class (only the instance and base class passed to cleanup() differed).
"""
import asyncio
import os
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from pipecat.frames.frames import Frame, MetricsFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.metrics.metrics import LLMUsageMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from bot.azure import resolve_trimmed_env

FLUE_BASE = "http://127.0.0.1:3583"


def flue_up() -> bool:
    try:
        return httpx.get(f"{FLUE_BASE}/health", timeout=3).status_code == 200
    except Exception:
        return False


requires_flue = pytest.mark.skipif(not flue_up(), reason="flue agent service not running on :3583")


def aifoundry_available() -> bool:
    p = resolve_trimmed_env(os.environ.get("AIFOUNDRY_ENV"), "~/env/aifoundry.sh")
    return Path(p).expanduser().is_file()


requires_aifoundry = pytest.mark.skipif(
    not aifoundry_available(), reason="~/env/aifoundry.sh (or $AIFOUNDRY_ENV) not present"
)


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


TWO_REGION_AIFOUNDRY_SH = (
    "# east-us-2\napikey=key2\nopenai_endpoint=https://res2.openai.azure.com/openai/v1\n"
    "# east-us-1\napikey=key1\nopenai_endpoint=https://res1.openai.azure.com/openai/v1\n"
)


def write_aifoundry_env(tmp_path, contents: str) -> str:
    """Write `contents` to a fake aifoundry.sh under tmp_path and return its path."""
    p = tmp_path / "aifoundry.sh"
    p.write_text(contents, encoding="utf-8")
    return str(p)


async def async_return(value: Any) -> Any:
    return value


async def assert_cleanup_closes_owned_client(instance) -> None:
    """`cleanup()` closes `instance`'s owned httpx.AsyncClient (built in `__init__`, not shared),
    since the base class it's mixed into has no way to know about it on its own. Wraps the real
    aclose (rather than replacing it with a bare stub) so the connection pool is actually
    released, not just faked-closed."""
    instance._client.aclose = AsyncMock(wraps=instance._client.aclose)

    await instance.cleanup()

    instance._client.aclose.assert_awaited_once()


async def assert_cleanup_still_closes_client_when_super_cleanup_raises(instance, base_cls, monkeypatch) -> None:
    """The owned client must still be closed even if `base_cls.cleanup()` raises, otherwise a
    failure in the base teardown path leaks the connection pool anyway."""
    instance._client.aclose = AsyncMock(wraps=instance._client.aclose)

    async def raising_super_cleanup(self):
        raise RuntimeError("boom")

    monkeypatch.setattr(base_cls, "cleanup", raising_super_cleanup)

    with pytest.raises(RuntimeError, match="boom"):
        await instance.cleanup()

    instance._client.aclose.assert_awaited_once()


class FakeTransport:
    """Duck-typed stand-in for pipecat's transport: just needs input()/output(), each a real
    FrameProcessor so Pipeline's linking (which sets _prev/_next) works."""

    def __init__(self):
        self._input = FrameProcessor(name="transport-input")
        self._output = FrameProcessor(name="transport-output")

    def input(self):
        return self._input

    def output(self):
        return self._output
