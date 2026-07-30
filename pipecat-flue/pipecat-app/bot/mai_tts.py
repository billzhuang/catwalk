"""MaiVoiceTTS — MAI-Voice-2 text-to-speech (east-us-2).

Extends TTSService, which aggregates the LLM's TextFrames into speakable chunks
and calls run_tts(). We request headerless 24 kHz PCM from the Azure Speech REST
API and yield it as TTSAudioRawFrames the transport can play.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator

from loguru import logger
from pipecat.frames.frames import Frame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.services.tts_service import TTSService

from .azure import (
    NoMetricsMixin,
    call_or_error_frame,
    init_speech_client,
    synthesize_ssml,
    tts_block,
)
from .http_client_cleanup import OwnedHttpClientCleanupMixin

# Azure "raw-24khz-16bit-mono-pcm" = headerless little-endian PCM at 24 kHz mono.
SAMPLE_RATE = 24000
OUTPUT_FORMAT = "raw-24khz-16bit-mono-pcm"
CHUNK_MS = 20


class MaiVoiceTTS(OwnedHttpClientCleanupMixin, NoMetricsMixin, TTSService):
    def __init__(
        self,
        *,
        voice: str = "en-US-Jasper:MAI-Voice-2",
        api_key: str | None = None,
        speech_endpoint: str | None = None,
        **kwargs,
    ):
        super().__init__(sample_rate=SAMPLE_RATE, **kwargs)
        self._api_key, self._endpoint, self._client = init_speech_client(tts_block(), api_key, speech_endpoint)
        self._voice = voice

    async def synthesize(self, text: str) -> bytes:
        """POST SSML to MAI-Voice-2, return raw PCM. Isolated for testing."""
        return await synthesize_ssml(self._client, self._endpoint, self._api_key, self._voice, text, OUTPUT_FORMAT)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        logger.debug(f"MAI-Voice-2 <- {text!r}")
        yield TTSStartedFrame(context_id=context_id)
        pcm, err = await call_or_error_frame(lambda: self.synthesize(text), "MAI-Voice-2", "tts")
        if err:
            yield err
            yield TTSStoppedFrame(context_id=context_id)
            return
        chunk = int(self.sample_rate * 2 * CHUNK_MS / 1000)  # 16-bit mono
        for i in range(0, len(pcm), chunk):
            yield TTSAudioRawFrame(pcm[i : i + chunk], self.sample_rate, 1, context_id=context_id)
        yield TTSStoppedFrame(context_id=context_id)
