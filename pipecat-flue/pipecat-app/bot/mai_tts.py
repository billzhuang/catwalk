"""MaiVoiceTTS — MAI-Voice-2 text-to-speech (east-us-2).

Extends TTSService, which aggregates the LLM's TextFrames into speakable chunks
and calls run_tts(). We request headerless 24 kHz PCM from the Azure Speech REST
API and yield it as TTSAudioRawFrames the transport can play.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator
from xml.sax.saxutils import escape

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.services.tts_service import TTSService

from .azure import log_and_format_error, resolve_speech_credentials, tts_block

# Azure "raw-24khz-16bit-mono-pcm" = headerless little-endian PCM at 24 kHz mono.
SAMPLE_RATE = 24000
OUTPUT_FORMAT = "raw-24khz-16bit-mono-pcm"
CHUNK_MS = 20


class MaiVoiceTTS(TTSService):
    def __init__(
        self,
        *,
        voice: str = "en-US-Jasper:MAI-Voice-2",
        api_key: str | None = None,
        speech_endpoint: str | None = None,
        **kwargs,
    ):
        super().__init__(sample_rate=SAMPLE_RATE, **kwargs)
        self._api_key, self._endpoint = resolve_speech_credentials(tts_block(), api_key, speech_endpoint)
        self._voice = voice
        self._client = httpx.AsyncClient(timeout=60)

    def can_generate_metrics(self) -> bool:
        return False

    async def synthesize(self, text: str) -> bytes:
        """POST SSML to MAI-Voice-2, return raw PCM. Isolated for testing."""
        ssml = (
            f"<speak version='1.0' xml:lang='en-US'>"
            f"<voice name='{self._voice}'>{escape(text)}</voice></speak>"
        )
        r = await self._client.post(
            f"{self._endpoint}/tts/cognitiveservices/v1",
            headers={
                "Ocp-Apim-Subscription-Key": self._api_key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
                "User-Agent": "pipecat-voice-chain",
            },
            content=ssml.encode(),
        )
        r.raise_for_status()
        return r.content

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        logger.debug(f"MAI-Voice-2 <- {text!r}")
        yield TTSStartedFrame()
        try:
            pcm = await self.synthesize(text)
        except Exception as e:  # noqa: BLE001
            yield ErrorFrame(log_and_format_error("MAI-Voice-2", "tts", e))
            yield TTSStoppedFrame()
            return
        chunk = int(self.sample_rate * 2 * CHUNK_MS / 1000)  # 16-bit mono
        for i in range(0, len(pcm), chunk):
            yield TTSAudioRawFrame(pcm[i : i + chunk], self.sample_rate, 1)
        yield TTSStoppedFrame()
