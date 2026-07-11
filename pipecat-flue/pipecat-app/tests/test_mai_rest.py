"""Integration: MAI-Voice-2 (TTS) and MAI-Transcribe-1.5 (STT) round-trip.

Synthesize English speech, then transcribe it back and check the words survive.
Needs network + ~/env/aifoundry.sh keys.
"""
import pytest

from bot.mai_stt import MaiTranscribeSTT, pcm_to_wav
from bot.mai_tts import MaiVoiceTTS, SAMPLE_RATE

PHRASE = "What is the weather in London today?"


@pytest.mark.asyncio
async def test_mai_voice_synthesize_returns_pcm():
    tts = MaiVoiceTTS()
    pcm = await tts.synthesize(PHRASE)
    assert isinstance(pcm, bytes) and len(pcm) > 8000, "expected non-trivial PCM audio"


@pytest.mark.asyncio
async def test_mai_transcribe_roundtrip():
    tts = MaiVoiceTTS()
    stt = MaiTranscribeSTT()
    pcm = await tts.synthesize(PHRASE)
    wav = pcm_to_wav(pcm, SAMPLE_RATE)
    text = await stt.transcribe(wav)
    low = text.lower()
    assert "weather" in low and "london" in low, f"unexpected transcript: {text!r}"
