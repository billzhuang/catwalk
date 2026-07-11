"""MaiTranscribeSTT — MAI-Transcribe-1.5 speech-to-text (east-us-1).

Extends SegmentedSTTService, which buffers a full utterance between the VAD's
UserStartedSpeaking / UserStoppedSpeaking events and hands us the whole segment.
That fits MAI-Transcribe's fast-transcription REST API (it wants a complete clip,
not a stream) and its enhancedMode `model: mai-transcribe-1.5`.

MAI-Transcribe accepts WAV/OGG but not webm/opus, so we wrap the raw PCM the base
class gives us into a WAV before sending.
"""
from __future__ import annotations

import io
import json
import struct
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.stt_service import SegmentedSTTService

from .azure import stt_block


def pcm_to_wav(pcm: bytes, sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    """Wrap raw little-endian PCM in a minimal WAV container."""
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    hdr += struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits)
    hdr += b"data" + struct.pack("<I", len(pcm))
    return hdr + pcm


class MaiTranscribeSTT(SegmentedSTTService):
    API_VERSION = "2025-10-15"

    def __init__(
        self,
        *,
        model: str = "mai-transcribe-1.5",
        language: str = "en-US",
        api_key: str | None = None,
        speech_endpoint: str | None = None,
        sample_rate: int | None = None,
        **kwargs,
    ):
        super().__init__(sample_rate=sample_rate, **kwargs)
        block = stt_block()
        self._api_key = api_key or block.apikey
        self._endpoint = speech_endpoint or block.speech_endpoint
        self._model = model
        self._language = language
        self._client = httpx.AsyncClient(timeout=60)

    def can_generate_metrics(self) -> bool:
        return False

    async def transcribe(self, wav: bytes) -> str:
        """POST a WAV to MAI-Transcribe fast-transcription. Isolated for testing."""
        definition = {
            "locales": [self._language],
            "enhancedMode": {"enabled": True, "model": self._model, "transcribeStyle": "verbatim"},
        }
        r = await self._client.post(
            f"{self._endpoint}/speechtotext/transcriptions:transcribe",
            params={"api-version": self.API_VERSION},
            headers={"Ocp-Apim-Subscription-Key": self._api_key},
            files={"audio": ("audio.wav", wav, "audio/wav")},
            data={"definition": json.dumps(definition)},
        )
        r.raise_for_status()
        d = r.json()
        phrases = d.get("combinedPhrases")
        return (phrases[0].get("text") if phrases else d.get("text", "")) or ""

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        wav = pcm_to_wav(audio, self.sample_rate)
        try:
            text = await self.transcribe(wav)
        except Exception as e:  # noqa: BLE001
            logger.error(f"MAI-Transcribe failed: {e}")
            yield ErrorFrame(f"transcription failed: {e}")
            return
        text = text.strip()
        if not text:
            return
        logger.debug(f"MAI-Transcribe -> {text!r}")
        ts = datetime.now(timezone.utc).isoformat()
        yield TranscriptionFrame(text, "user", ts)
