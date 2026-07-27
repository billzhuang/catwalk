"""Unit: build_pipeline() wires VAD -> STT -> turns -> flue -> TTS between the transport's
audio ends, in the order the module docstring promises. No prior test exercised this function:
test_flue_pipeline.py builds its own ad-hoc Pipeline (and needs a live flue service anyway), and
test_e2e_audio.py drives the real bot end to end but also skips without a live flue service."""
import pytest
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.turns.user_turn_processor import UserTurnProcessor

import run_bot
from bot.flue_llm import DEFAULT_FLUE_BASE_URL, FlueLLMProcessor
from bot.mai_stt import MaiTranscribeSTT
from bot.mai_tts import MaiVoiceTTS
from run_bot import build_pipeline
from tests.conftest import TWO_REGION_AIFOUNDRY_SH as AIFOUNDRY_SH
from tests.conftest import FakeTransport as _FakeTransport
from tests.conftest import write_aifoundry_env


@pytest.mark.asyncio
async def test_build_pipeline_wires_stages_in_documented_order(monkeypatch, tmp_path):
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    transport = _FakeTransport()

    pipeline = build_pipeline(transport, conversation_id="test-convo")

    # Pipeline wraps the given processors with its own source/sink at the ends.
    stages = pipeline.processors
    assert stages[1] is transport.input()
    assert isinstance(stages[2], VADProcessor)
    assert isinstance(stages[3], MaiTranscribeSTT)
    assert isinstance(stages[4], UserTurnProcessor)
    assert isinstance(stages[5], FlueLLMProcessor)
    assert isinstance(stages[6], MaiVoiceTTS)
    assert stages[7] is transport.output()

    assert stages[5]._url == f"{DEFAULT_FLUE_BASE_URL}/agents/weather/test-convo"

    for stage in (stages[3], stages[5], stages[6]):
        await stage._client.aclose()


@pytest.mark.asyncio
async def test_build_pipeline_defaults_conversation_id_to_voice(monkeypatch, tmp_path):
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    transport = _FakeTransport()

    pipeline = build_pipeline(transport)

    llm = pipeline.processors[5]
    assert llm._url == f"{DEFAULT_FLUE_BASE_URL}/agents/weather/voice"

    for stage in (pipeline.processors[3], llm, pipeline.processors[6]):
        await stage._client.aclose()


@pytest.mark.asyncio
async def test_build_pipeline_wires_module_flue_base_not_just_the_constructor_default(monkeypatch, tmp_path):
    """build_pipeline must pass run_bot.FLUE_BASE into FlueLLMProcessor explicitly, not rely on
    it happening to equal FlueLLMProcessor's own default base_url. Patching only run_bot.FLUE_BASE
    (leaving FlueLLMProcessor's default untouched) pins that wiring: if build_pipeline regressed to
    calling FlueLLMProcessor(conversation_id=...) without base_url, this would still see the
    constructor's hardcoded default and fail."""
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    monkeypatch.setattr(run_bot, "FLUE_BASE", "http://127.0.0.1:9999")
    transport = _FakeTransport()

    pipeline = build_pipeline(transport, conversation_id="test-convo")

    llm = pipeline.processors[5]
    assert llm._url == "http://127.0.0.1:9999/agents/weather/test-convo"

    for stage in (pipeline.processors[3], llm, pipeline.processors[6]):
        await stage._client.aclose()
