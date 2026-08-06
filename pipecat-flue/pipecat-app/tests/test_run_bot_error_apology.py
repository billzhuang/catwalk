"""Unit: bot() wires an on_pipeline_error handler that speaks an apology for non-fatal errors.

Before this handler existed, a non-fatal ErrorFrame from MaiTranscribeSTT/MaiVoiceTTS (an Azure
REST hiccup — see bot/mai_stt.py, bot/mai_tts.py) traveled upstream to PipelineWorker's
_source_push_frame, which just logs a warning; nothing was ever spoken, leaving the student in
silence with no feedback. This pins that a handler is registered and that it queues a
TTSSpeakFrame apology only for non-fatal errors, mirroring FlueLLMProcessor's own apologize-out-
loud fallback (bot/flue_llm.py).
"""
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import ErrorFrame, TTSSpeakFrame

import run_bot
from tests.conftest import FakeRunner as _FakeRunner
from tests.conftest import close_pipeline_http_clients, patch_transport_and_runner


async def _built_task(monkeypatch, tmp_path):
    patch_transport_and_runner(monkeypatch, run_bot, tmp_path)
    await run_bot.bot(SimpleNamespace(body={"clientId": "test-convo"}, session_id="server-session"))
    return _FakeRunner.instances[0].ran_task


def _error_handler(task):
    handlers = task._event_handlers["on_pipeline_error"].handlers
    assert len(handlers) == 1
    return handlers[0]


def _capture_queued_frames(task, monkeypatch) -> list:
    """Stub task.queue_frame to record every frame it's called with instead of actually queuing
    it — the setup every test below otherwise repeats verbatim."""
    queued: list = []

    async def fake_queue_frame(frame, *args, **kwargs):
        queued.append(frame)

    monkeypatch.setattr(task, "queue_frame", fake_queue_frame)
    return queued


@pytest.mark.asyncio
async def test_non_fatal_pipeline_error_speaks_an_apology(monkeypatch, tmp_path):
    task = await _built_task(monkeypatch, tmp_path)
    queued = _capture_queued_frames(task, monkeypatch)

    await _error_handler(task)(task, ErrorFrame("MAI-Transcribe transcription failed: boom"))

    assert len(queued) == 1
    assert isinstance(queued[0], TTSSpeakFrame)
    assert queued[0].text == run_bot.PIPELINE_ERROR_APOLOGY
    assert queued[0].append_to_context is False

    await close_pipeline_http_clients(task._pipeline)


@pytest.mark.asyncio
async def test_apology_can_retrigger_after_cooldown_elapses(monkeypatch, tmp_path):
    task = await _built_task(monkeypatch, tmp_path)
    queued = _capture_queued_frames(task, monkeypatch)
    fake_now = [100.0]
    monkeypatch.setattr(run_bot.time, "monotonic", lambda: fake_now[0])

    handler = _error_handler(task)
    await handler(task, ErrorFrame("MAI-Transcribe transcription failed: boom"))
    fake_now[0] += run_bot.APOLOGY_COOLDOWN_S + 0.1
    await handler(task, ErrorFrame("MAI-Transcribe transcription failed: boom again, later"))

    assert len(queued) == 2

    await close_pipeline_http_clients(task._pipeline)


class _FakeTask:
    """Bare stand-in for PipelineTask exposing just the queue_frame() build_apology_handler
    calls — build_apology_handler only closes over `task.queue_frame`, so unlike the tests
    above it needs no transport/pipeline bootstrap at all."""

    def __init__(self):
        self.queued: list = []

    async def queue_frame(self, frame, *args, **kwargs):
        self.queued.append(frame)


@pytest.mark.asyncio
async def test_build_apology_handler_speaks_for_non_fatal_error():
    task = _FakeTask()
    handler = run_bot.build_apology_handler(task)

    await handler(task, ErrorFrame("MAI-Transcribe transcription failed: boom"))

    assert len(task.queued) == 1
    assert isinstance(task.queued[0], TTSSpeakFrame)
    assert task.queued[0].text == run_bot.PIPELINE_ERROR_APOLOGY
    assert task.queued[0].append_to_context is False


@pytest.mark.asyncio
async def test_build_apology_handler_stays_silent_for_fatal_error():
    task = _FakeTask()
    handler = run_bot.build_apology_handler(task)

    await handler(task, ErrorFrame("unrecoverable", fatal=True))

    assert task.queued == []


@pytest.mark.asyncio
async def test_build_apology_handler_suppresses_repeat_within_cooldown(monkeypatch):
    task = _FakeTask()
    handler = run_bot.build_apology_handler(task)
    fake_now = [100.0]
    monkeypatch.setattr(run_bot.time, "monotonic", lambda: fake_now[0])

    await handler(task, ErrorFrame("boom"))
    fake_now[0] += run_bot.APOLOGY_COOLDOWN_S - 0.1
    await handler(task, ErrorFrame("boom again, still within cooldown"))

    assert len(task.queued) == 1
