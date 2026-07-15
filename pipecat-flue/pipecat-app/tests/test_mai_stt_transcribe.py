"""Characterization test for MaiTranscribeSTT.transcribe's request-building/response-parsing.

Pins the request shape (endpoint, params, headers, multipart body) and both response
shapes MAI-Transcribe can return (`combinedPhrases` vs a bare `text` fallback). No prior
non-network test coverage existed for this method — only test_mai_rest.py's live-credential
round-trip exercised it. No network: uses httpx.MockTransport instead of ~/env/aifoundry.sh
+ a live Azure call, mirroring test_mai_tts_synthesize.py's conventions for the sibling
MaiVoiceTTS.synthesize.
"""
import httpx
import pytest

from bot.mai_stt import MaiTranscribeSTT

AIFOUNDRY_SH = "# east-us-1\napikey=unused\nopenai_endpoint=https://unused.openai.azure.com/openai/v1\n"


def _stt(monkeypatch, tmp_path, **overrides):
    p = tmp_path / "aifoundry.sh"
    p.write_text(AIFOUNDRY_SH)
    monkeypatch.setenv("AIFOUNDRY_ENV", str(p))
    return MaiTranscribeSTT(
        model=overrides.get("model", "mai-transcribe-1.5"),
        language=overrides.get("language", "en-US"),
        api_key=overrides.get("api_key", "test-key"),
        speech_endpoint=overrides.get("speech_endpoint", "https://res.cognitiveservices.azure.com"),
    )


@pytest.mark.asyncio
async def test_transcribe_posts_expected_request_and_parses_combined_phrases(monkeypatch, tmp_path):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["body"] = request.content
        return httpx.Response(200, json={"combinedPhrases": [{"text": "hello world"}]})

    stt = _stt(monkeypatch, tmp_path)
    stt._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

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
    stt._client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"text": "fallback text"}))
    )

    assert await stt.transcribe(b"wav-bytes") == "fallback text"


@pytest.mark.asyncio
async def test_transcribe_returns_empty_string_when_response_has_neither_field(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    stt._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))

    assert await stt.transcribe(b"wav-bytes") == ""


@pytest.mark.asyncio
async def test_transcribe_raises_on_http_error_status(monkeypatch, tmp_path):
    stt = _stt(monkeypatch, tmp_path)
    stt._client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(401, content=b"denied"))
    )

    with pytest.raises(httpx.HTTPStatusError):
        await stt.transcribe(b"wav-bytes")
