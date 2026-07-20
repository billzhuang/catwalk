"""MaiVoiceTTS — MAI-Voice-2 text-to-speech (east-us-2).

Extends TTSService, which aggregates the LLM's TextFrames into speakable chunks
and calls run_tts(). We request headerless 24 kHz PCM from the Azure Speech REST
API and yield it as TTSAudioRawFrames the transport can play.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator

from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.services.tts_service import TTSService

from .azure import (
    NoMetricsMixin,
    log_and_format_error,
    new_speech_client,
    resolve_speech_credentials,
    synthesize_ssml,
    tts_block,
)

# Azure "raw-24khz-16bit-mono-pcm" = headerless little-endian PCM at 24 kHz mono.
SAMPLE_RATE = 24000
OUTPUT_FORMAT = "raw-24khz-16bit-mono-pcm"
CHUNK_MS = 20


class MaiVoiceTTS(NoMetricsMixin, TTSService):
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
        self._client = new_speech_client()

    async def cleanup(self):
        """Close the owned HTTP client at teardown."""
        await super().cleanup()
        await self._client.aclose()

    async def synthesize(self, text: str) -> bytes:
        """POST SSML to MAI-Voice-2, return raw PCM. Isolated for testing."""
        return await synthesize_ssml(self._client, self._endpoint, self._api_key, self._voice, text, OUTPUT_FORMAT)

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
