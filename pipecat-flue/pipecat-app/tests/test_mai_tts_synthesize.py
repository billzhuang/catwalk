"""Characterization test for MaiVoiceTTS.synthesize's SSML request-building, and for
run_tts's frame-emission wrapper around it.

Pins the request shape (endpoint, headers, SSML body with entity-escaped text) and the
returned bytes before extracting the shared synthesize_ssml() helper into bot/azure.py
(see test_e2e_audio.py's _synth_16k, which hand-rolled the same request). No network:
uses httpx.MockTransport instead of ~/env/aifoundry.sh + a live Azure call.

run_tts itself (the started/stopped framing, PCM chunking, and error handling wrapping
synthesize()) had no coverage either: the only place it runs is test_e2e_audio.py, which
skips without a live flue service and network/Azure keys. Here it's pinned directly by
stubbing synthesize().
"""
import httpx
import pytest
from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.services.tts_service import TTSService

from bot.mai_tts import MaiVoiceTTS, OUTPUT_FORMAT, SAMPLE_RATE
from tests.conftest import (
    assert_cleanup_closes_owned_client,
    assert_cleanup_still_closes_client_when_super_cleanup_raises,
    async_return,
    capturing_handler,
    with_mock_transport_client,
    write_aifoundry_env,
)

# MaiVoiceTTS() always resolves a credentials block from ~/env/aifoundry.sh (env
# AIFOUNDRY_ENV here) even when explicit api_key/speech_endpoint override it below.
AIFOUNDRY_SH = "# east-us-2\napikey=unused\nopenai_endpoint=https://unused.openai.azure.com/openai/v1\n"


def _tts(monkeypatch, tmp_path, **overrides):
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    return MaiVoiceTTS(
        voice=overrides.get("voice", "en-US-Jasper:MAI-Voice-2"),
        api_key=overrides.get("api_key", "test-key"),
        speech_endpoint=overrides.get("speech_endpoint", "https://res.cognitiveservices.azure.com"),
    )


def test_can_generate_metrics_is_false(monkeypatch, tmp_path):
    assert _tts(monkeypatch, tmp_path).can_generate_metrics() is False


@pytest.mark.asyncio
async def test_cleanup_closes_owned_http_client(monkeypatch, tmp_path):
    """MaiVoiceTTS owns its httpx.AsyncClient (built in __init__, not shared) and the
    base TTSService/FrameProcessor.cleanup() has no way to know about it, so it must be
    closed explicitly here or every call leaks an open connection pool at pipeline
    teardown."""
    await assert_cleanup_closes_owned_client(_tts(monkeypatch, tmp_path))


@pytest.mark.asyncio
async def test_cleanup_still_closes_client_when_super_cleanup_raises(monkeypatch, tmp_path):
    """The owned client must be closed even if the parent TTSService.cleanup() raises,
    otherwise a failure in the base teardown path leaks the connection pool anyway."""
    await assert_cleanup_still_closes_client_when_super_cleanup_raises(
        _tts(monkeypatch, tmp_path), TTSService, monkeypatch
    )


@pytest.mark.asyncio
async def test_synthesize_posts_expected_ssml_request_and_returns_pcm(monkeypatch, tmp_path):
    captured, handler = capturing_handler(lambda: httpx.Response(200, content=b"fake-pcm-bytes"))

    async with with_mock_transport_client(_tts(monkeypatch, tmp_path), handler) as tts:
        pcm = await tts.synthesize("Tom & Jerry <says> hi")

    assert pcm == b"fake-pcm-bytes"
    assert captured["url"] == "https://res.cognitiveservices.azure.com/tts/cognitiveservices/v1"
    assert captured["headers"]["Ocp-Apim-Subscription-Key"] == "test-key"
    assert captured["headers"]["Content-Type"] == "application/ssml+xml"
    assert captured["headers"]["X-Microsoft-OutputFormat"] == OUTPUT_FORMAT
    assert captured["headers"]["User-Agent"] == "pipecat-voice-chain"
    assert captured["body"] == (
        b"<speak version='1.0' xml:lang='en-US'>"
        b"<voice name='en-US-Jasper:MAI-Voice-2'>Tom &amp; Jerry &lt;says&gt; hi</voice></speak>"
    )


@pytest.mark.asyncio
async def test_synthesize_raises_on_http_error_status(monkeypatch, tmp_path):
    async with with_mock_transport_client(
        _tts(monkeypatch, tmp_path), lambda r: httpx.Response(401, content=b"denied")
    ) as tts:
        with pytest.raises(httpx.HTTPStatusError):
            await tts.synthesize("hi")


async def _run_tts_frames(tts: MaiVoiceTTS, text: str) -> list:
    return [f async for f in tts.run_tts(text, "ctx") if f is not None]


@pytest.mark.asyncio
async def test_run_tts_chunks_pcm_between_started_and_stopped_frames(monkeypatch, tmp_path):
    tts = _tts(monkeypatch, tmp_path)
    tts._sample_rate = SAMPLE_RATE
    chunk_bytes = int(SAMPLE_RATE * 2 * 20 / 1000)  # matches mai_tts.py's CHUNK_MS=20
    pcm = bytes(range(256)) * ((chunk_bytes * 2 + 100) // 256 + 1)
    pcm = pcm[: chunk_bytes * 2 + 100]  # two full chunks plus a short final one
    tts.synthesize = lambda text: async_return(pcm)

    frames = await _run_tts_frames(tts, "hello")

    assert isinstance(frames[0], TTSStartedFrame)
    assert isinstance(frames[-1], TTSStoppedFrame)
    audio_frames = frames[1:-1]
    assert all(isinstance(f, TTSAudioRawFrame) for f in audio_frames)
    assert [len(f.audio) for f in audio_frames] == [chunk_bytes, chunk_bytes, 100]
    assert b"".join(f.audio for f in audio_frames) == pcm
    # Every frame must carry the caller's context_id: TTSService.push_frame() only
    # cleans up its per-turn _tts_contexts entry on a TTSStoppedFrame whose own
    # context_id is truthy, so a bare TTSStoppedFrame() (context_id=None) leaks it.
    assert all(f.context_id == "ctx" for f in frames)


@pytest.mark.asyncio
async def test_run_tts_yields_error_frame_between_started_and_stopped_when_synthesize_raises(monkeypatch, tmp_path):
    tts = _tts(monkeypatch, tmp_path)
    tts._sample_rate = SAMPLE_RATE

    async def _raise(text):
        raise RuntimeError("boom")

    tts.synthesize = _raise

    frames = await _run_tts_frames(tts, "hello")

    assert len(frames) == 3
    assert isinstance(frames[0], TTSStartedFrame)
    assert isinstance(frames[1], ErrorFrame)
    assert frames[1].error == "tts failed: boom"
    assert isinstance(frames[2], TTSStoppedFrame)
    assert frames[0].context_id == "ctx"
    assert frames[2].context_id == "ctx"
