"""Characterization test for MaiTranscribeSTT.transcribe's request-building/response-parsing,
and for run_stt's frame-emission wrapper around it.

Pins the request shape (endpoint, params, headers, multipart body) and both response
shapes MAI-Transcribe can return (`combinedPhrases` vs a bare `text` fallback). No prior
non-network test coverage existed for this method — only test_mai_rest.py's live-credential
round-trip exercised it. No network: uses httpx.MockTransport instead of ~/env/aifoundry.sh
+ a live Azure call, mirroring test_mai_tts_synthesize.py's conventions for the sibling
MaiVoiceTTS.synthesize.

run_stt itself (the error-handling/empty-text-skip logic wrapping transcribe()) had no
coverage either: the only place it runs is test_e2e_audio.py, which skips without a live
flue service and network/Azure keys. Here it's pinned directly by stubbing transcribe().
"""
from unittest.mock import AsyncMock

import httpx
import pytest
from pipecat.frames.frames import ErrorFrame, TranscriptionFrame

from bot.mai_stt import MaiTranscribeSTT
from tests.conftest import async_return, write_aifoundry_env

AIFOUNDRY_SH = "# east-us-1\napikey=unused\nopenai_endpoint=https://unused.openai.azure.com/openai/v1\n"


def _stt(monkeypatch, tmp_path, **overrides):
    monkeypatch.setenv("AIFOUNDRY_ENV", write_aifoundry_env(tmp_path, AIFOUNDRY_SH))
    return MaiTranscribeSTT(
        model=overrides.get("model", "mai-transcribe-1.5"),
        language=overrides.get("language", "en-US"),
        api_key=overrides.get("api_key", "test-key"),
        speech_endpoint=overrides.get("speech_endpoint", "https://res.cognitiveservices.azure.com"),
    )


def test_can_generate_metrics_is_false(monkeypatch, tmp_path):
    assert _stt(monkeypatch, tmp_path).can_generate_metrics() is False


@pytest.mark.asyncio
async def test_cleanup_closes_owned_http_client(monkeypatch, tmp_path):
    """MaiTranscribeSTT owns its httpx.AsyncClient (built in __init__, not shared) and
    the base SegmentedSTTService/FrameProcessor.cleanup() has no way to know about it, so
    it must be closed explicitly here or every call leaks an open connection pool at
    pipeline teardown. Wraps the real aclose (rather than replacing it with a bare stub)
    so the client's underlying connection pool is actually released instead of leaking
    in the test."""
    stt = _stt(monkeypatch, tmp_path)
    stt._client.aclose = AsyncMock(wraps=stt._client.aclose)

    await stt.cleanup()

    stt._client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_transcribe_posts_expected_request_and_parses_combined_phrases(monkeypatch, tmp_path):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["body"] = request.content
        return httpx.Response(200, json={"combinedPhrases": [{"text": "hello world"}]})

    stt = _stt(monkeypatch, tmp_path)
    await stt._client.aclose()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        stt._client = client
        text = await stt.transcribe(b"RIFF....WAVEfmt ")

    assert text == "hello world"
    assert captured["url"] == (
        f"https://res.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe"
        f"?api-version={MaiTranscribeSTT.API_VERSION}"
    )
    assert captured["headers"]["Ocp-Apim-Subscription-Key"] == "test-key"
    assert b'name="audio"; filename="audio.wav"' in captured["body"]
    assert b'name="definition"' in captured["body"]
    assert b'"locales": ["en-US"]' in captured["body"] or b'"locales":["en-US"]' in captured["body"]


@pytest.mark.asyncio
async def test_transcribe_falls_back_to_top_level_text_when_no_combined_phrases(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    await stt._client.aclose()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"text": "fallback text"}))
    ) as client:
        stt._client = client
        assert await stt.transcribe(b"wav-bytes") == "fallback text"


@pytest.mark.asyncio
async def test_transcribe_returns_empty_string_when_response_has_neither_field(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    await stt._client.aclose()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))) as client:
        stt._client = client
        assert await stt.transcribe(b"wav-bytes") == ""


@pytest.mark.asyncio
async def test_transcribe_raises_on_http_error_status(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    await stt._client.aclose()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(401, content=b"denied"))
    ) as client:
        stt._client = client
        with pytest.raises(httpx.HTTPStatusError):
            await stt.transcribe(b"wav-bytes")


async def _run_stt_frames(stt: MaiTranscribeSTT, audio: bytes) -> list:
    return [f async for f in stt.run_stt(audio) if f is not None]


@pytest.mark.asyncio
async def test_run_stt_yields_transcription_frame_with_stripped_text(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    stt._sample_rate = 16000
    stt.transcribe = lambda wav: async_return("  hello world  ")

    frames = await _run_stt_frames(stt, b"\x00\x01" * 100)

    assert len(frames) == 1
    assert isinstance(frames[0], TranscriptionFrame)
    assert frames[0].text == "hello world"
    assert frames[0].user_id == "user"


@pytest.mark.asyncio
async def test_run_stt_yields_no_frame_when_transcript_is_empty(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    stt._sample_rate = 16000
    stt.transcribe = lambda wav: async_return("   ")

    assert await _run_stt_frames(stt, b"\x00\x01" * 100) == []


@pytest.mark.asyncio
async def test_run_stt_yields_error_frame_when_transcribe_raises(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    stt._sample_rate = 16000

    async def _raise(wav):
        raise RuntimeError("boom")

    stt.transcribe = _raise

    frames = await _run_stt_frames(stt, b"\x00\x01" * 100)

    assert len(frames) == 1
    assert isinstance(frames[0], ErrorFrame)
    assert frames[0].error == "transcription failed: boom"
