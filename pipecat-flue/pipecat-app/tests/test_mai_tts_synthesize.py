"""Characterization test for MaiVoiceTTS.synthesize's SSML request-building.

Pins the request shape (endpoint, headers, SSML body with entity-escaped text) and the
returned bytes before extracting the shared synthesize_ssml() helper into bot/azure.py
(see test_e2e_audio.py's _synth_16k, which hand-rolled the same request). No network:
uses httpx.MockTransport instead of ~/env/aifoundry.sh + a live Azure call.
"""
import httpx
import pytest

from bot.mai_tts import MaiVoiceTTS, OUTPUT_FORMAT

# MaiVoiceTTS() always resolves a credentials block from ~/env/aifoundry.sh (env
# AIFOUNDRY_ENV here) even when explicit api_key/speech_endpoint override it below.
AIFOUNDRY_SH = "# east-us-2\napikey=unused\nopenai_endpoint=https://unused.openai.azure.com/openai/v1\n"


def _tts(monkeypatch, tmp_path, **overrides):
    p = tmp_path / "aifoundry.sh"
    p.write_text(AIFOUNDRY_SH)
    monkeypatch.setenv("AIFOUNDRY_ENV", str(p))
    return MaiVoiceTTS(
        voice=overrides.get("voice", "en-US-Jasper:MAI-Voice-2"),
        api_key=overrides.get("api_key", "test-key"),
        speech_endpoint=overrides.get("speech_endpoint", "https://res.cognitiveservices.azure.com"),
    )


@pytest.mark.asyncio
async def test_synthesize_posts_expected_ssml_request_and_returns_pcm(monkeypatch, tmp_path):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = request.headers
        captured["body"] = request.content
        return httpx.Response(200, content=b"fake-pcm-bytes")

    tts = _tts(monkeypatch, tmp_path)
    tts._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

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
    tts = _tts(monkeypatch, tmp_path)
    tts._client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(401, content=b"denied"))
    )

    with pytest.raises(httpx.HTTPStatusError):
        await tts.synthesize("hi")
