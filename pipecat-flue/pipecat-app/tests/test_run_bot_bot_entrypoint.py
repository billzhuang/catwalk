"""Unit: bot() — the per-session entrypoint pipecat's runner calls for each WebRTC connection.
No prior test exercised this composition: test_run_bot_build_pipeline.py and
test_run_bot_conversation_id.py each cover one of its two helpers in isolation, but not that
bot() actually feeds create_transport's result and resolve_conversation_id's result into
build_pipeline, then runs the resulting task through PipelineRunner with the documented
audio/metrics params."""
from types import SimpleNamespace

import pytest
from pipecat.processors.frame_processor import FrameProcessor

import run_bot
from tests.conftest import write_aifoundry_env

AIFOUNDRY_SH = (
    "# east-us-2\napikey=key2\nopenai_endpoint=https://res2.openai.azure.com/openai/v1\n"
    "# east-us-1\napikey=key1\nopenai_endpoint=https://res1.openai.azure.com/openai/v1\n"
)


class _FakeTransport:
    """Duck-typed stand-in for pipecat's transport: just needs input()/output(), each a real
    FrameProcessor so Pipeline's linking (which sets _prev/_next) works."""

    def __init__(self):
        self._input = FrameProcessor(name="transport-input")
        self._output = FrameProcessor(name="transport-output")

    def input(self):
        return self._input

    def output(self):
        return self._output


class _FakeRunner:
    """Stand-in for PipelineRunner: records the task it's asked to run instead of actually
    driving frames through the pipeline."""

    instances: list["_FakeRunner"] = []

    def __init__(self, *args, **kwargs):
        self.ran_task = None
        _FakeRunner.instances.append(self)

    async def run(self, task):
        self.ran_task = task


@pytest.mark.asyncio
async def test_bot_wires_transport_and_conversation_id_into_a_running_pipeline_task(monkeypatch, tmp_path):
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    transport = _FakeTransport()
    seen_transport_args = {}

    async def fake_create_transport(runner_args, params):
        seen_transport_args["runner_args"] = runner_args
        seen_transport_args["params"] = params
        return transport

    monkeypatch.setattr(run_bot, "create_transport", fake_create_transport)
    _FakeRunner.instances.clear()
    monkeypatch.setattr(run_bot, "PipelineRunner", _FakeRunner)

    real_build_pipeline = run_bot.build_pipeline
    built = {}

    def spying_build_pipeline(transport_arg, conversation_id="voice"):
        built["pipeline"] = real_build_pipeline(transport_arg, conversation_id)
        built["transport"] = transport_arg
        built["conversation_id"] = conversation_id
        return built["pipeline"]

    monkeypatch.setattr(run_bot, "build_pipeline", spying_build_pipeline)

    runner_args = SimpleNamespace(body={"clientId": "browser-tagged-id"}, session_id="server-session")
    await run_bot.bot(runner_args)

    assert seen_transport_args["runner_args"] is runner_args
    assert seen_transport_args["params"] is run_bot.transport_params
    assert built["transport"] is transport
    assert built["conversation_id"] == "browser-tagged-id"

    assert len(_FakeRunner.instances) == 1
    task = _FakeRunner.instances[0].ran_task
    assert task is not None
    assert task.params.audio_in_sample_rate == run_bot.STT_SAMPLE_RATE
    assert task.params.audio_out_sample_rate == run_bot.TTS_SAMPLE_RATE
    assert task.params.enable_metrics is True
    assert task.params.enable_usage_metrics is True

    # conversation_id resolved from the browser-tagged clientId flows into the flue LLM stage.
    pipeline = built["pipeline"]
    llm = pipeline.processors[5]
    assert llm._url == "http://127.0.0.1:3583/agents/weather/browser-tagged-id"

    for stage in (pipeline.processors[3], llm, pipeline.processors[6]):
        await stage._client.aclose()
