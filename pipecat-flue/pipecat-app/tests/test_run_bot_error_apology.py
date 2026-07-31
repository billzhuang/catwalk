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
from tests.conftest import TWO_REGION_AIFOUNDRY_SH as AIFOUNDRY_SH
from tests.conftest import FakeTransport as _FakeTransport
from tests.conftest import close_pipeline_http_clients, write_aifoundry_env


class _FakeRunner:
    """Stand-in for PipelineRunner: records the task it's asked to run instead of actually
    driving frames through the pipeline (copied from test_run_bot_bot_entrypoint.py's fixture)."""

    instances: list["_FakeRunner"] = []

    def __init__(self, *args, **kwargs):
        self.ran_task = None
        _FakeRunner.instances.append(self)

    async def run(self, task):
        self.ran_task = task


async def _built_task(monkeypatch, tmp_path):
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    transport = _FakeTransport()

    async def fake_create_transport(runner_args, params):
        return transport

    monkeypatch.setattr(run_bot, "create_transport", fake_create_transport)
    _FakeRunner.instances.clear()
    monkeypatch.setattr(run_bot, "PipelineRunner", _FakeRunner)

    await run_bot.bot(SimpleNamespace(body={"clientId": "test-convo"}, session_id="server-session"))
    return _FakeRunner.instances[0].ran_task


def _error_handler(task):
    handlers = task._event_handlers["on_pipeline_error"].handlers
    assert len(handlers) == 1
    return handlers[0]


@pytest.mark.asyncio
async def test_non_fatal_pipeline_error_speaks_an_apology(monkeypatch, tmp_path):
    task = await _built_task(monkeypatch, tmp_path)
    queued: list = []

    async def fake_queue_frame(frame, *args, **kwargs):
        queued.append(frame)

    monkeypatch.setattr(task, "queue_frame", fake_queue_frame)

    await _error_handler(task)(task, ErrorFrame("MAI-Transcribe transcription failed: boom"))

    assert len(queued) == 1
    assert isinstance(queued[0], TTSSpeakFrame)
    assert queued[0].text == run_bot.PIPELINE_ERROR_APOLOGY
    assert queued[0].append_to_context is False

    await close_pipeline_http_clients(task._pipeline)


@pytest.mark.asyncio
async def test_fatal_pipeline_error_does_not_speak(monkeypatch, tmp_path):
    task = await _built_task(monkeypatch, tmp_path)
    queued: list = []

    async def fake_queue_frame(frame, *args, **kwargs):
        queued.append(frame)

    monkeypatch.setattr(task, "queue_frame", fake_queue_frame)

    await _error_handler(task)(task, ErrorFrame("unrecoverable", fatal=True))

    assert queued == []

    await close_pipeline_http_clients(task._pipeline)
