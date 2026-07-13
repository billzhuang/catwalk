"""Full end-to-end, headless: real audio in -> transcript -> flue -> audio out.

Drives the actual pipeline (minus the WebRTC transport) by injecting VAD frames
and real 16 kHz speech PCM, and asserts we get a transcription, a flue reply, and
synthesized TTS audio back. Exercises MaiTranscribeSTT + FlueLLMProcessor +
MaiVoiceTTS together. Requires flue on :3583 and network/Azure keys.
"""
import asyncio

import httpx
import pytest
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.pipeline.task import PipelineParams
from pipecat.processors.audio.vad_processor import VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame

from bot.azure import synthesize_ssml, tts_block
from bot.flue_llm import FlueLLMProcessor
from bot.mai_stt import MaiTranscribeSTT
from bot.mai_tts import MaiVoiceTTS
from tests.conftest import Capture, requires_flue, start_pipeline_task, stop_pipeline_task

IN_RATE = 16000


async def _synth_16k(text: str) -> bytes:
    """Synthesize headerless 16 kHz PCM speech with MAI-Voice-2 (for injection)."""
    b = tts_block()
    async with httpx.AsyncClient(timeout=60) as c:
        return await synthesize_ssml(
            c, b.speech_endpoint, b.apikey, "en-US-Olivia:MAI-Voice-2", text, "raw-16khz-16bit-mono-pcm"
        )


@requires_flue
@pytest.mark.asyncio
async def test_full_audio_pipeline():
    pcm = await _synth_16k("What is the weather in Tokyo right now?")
    assert len(pcm) > 16000, "expected real speech PCM"

    stt = MaiTranscribeSTT()
    llm = FlueLLMProcessor(conversation_id="test-e2e")
    tts = MaiVoiceTTS()
    cap_stt = Capture()  # taps the transcript before flue consumes it
    cap = Capture()      # taps flue's reply text + synthesized audio at the end
    task, run = await start_pipeline_task(
        [stt, cap_stt, llm, tts, cap],
        PipelineParams(audio_in_sample_rate=IN_RATE, audio_out_sample_rate=24000, enable_metrics=False),
    )

    # Inject one spoken utterance: VAD start -> audio chunks -> VAD stop.
    chunk = int(IN_RATE * 2 * 0.02)  # 20 ms of 16-bit mono
    frames = [VADUserStartedSpeakingFrame()]
    frames += [InputAudioRawFrame(pcm[i : i + chunk], IN_RATE, 1) for i in range(0, len(pcm), chunk)]
    frames.append(VADUserStoppedSpeakingFrame())
    await task.queue_frames(frames)

    # Wait (bounded) for synthesized audio to come back out.
    for _ in range(600):  # up to 60s
        if cap.tts_bytes:
            break
        await asyncio.sleep(0.1)

    await stop_pipeline_task(task, run, timeout=20)

    assert cap_stt.transcripts, "STT produced no transcription"
    assert "tokyo" in " ".join(cap_stt.transcripts).lower(), f"unexpected transcript: {cap_stt.transcripts}"
    assert cap.texts, "flue produced no reply text"
    assert len(cap.tts_bytes) > 8000, "TTS produced no/insufficient audio"


@requires_flue
@pytest.mark.asyncio
async def test_math_animation_surfaced_for_polling():
    """Asking to *see* a math concept drives the full pipeline AND leaves the chosen topic
    available at flue's GET /animation/<conversation_id> — the decoupled channel the browser
    polls (independent of the WebRTC data channel)."""
    cid = "test-anim"
    pcm = await _synth_16k("Please show me a visual of the Pythagorean theorem.")
    assert len(pcm) > 16000, "expected real speech PCM"

    stt = MaiTranscribeSTT()
    llm = FlueLLMProcessor(conversation_id=cid)
    tts = MaiVoiceTTS()
    cap_stt = Capture()
    cap = Capture()
    task, run = await start_pipeline_task(
        [stt, cap_stt, llm, tts, cap],
        PipelineParams(audio_in_sample_rate=IN_RATE, audio_out_sample_rate=24000, enable_metrics=False),
    )

    chunk = int(IN_RATE * 2 * 0.02)
    frames = [VADUserStartedSpeakingFrame()]
    frames += [InputAudioRawFrame(pcm[i : i + chunk], IN_RATE, 1) for i in range(0, len(pcm), chunk)]
    frames.append(VADUserStoppedSpeakingFrame())
    await task.queue_frames(frames)

    for _ in range(600):  # up to 60s for the reply
        if cap.texts:
            break
        await asyncio.sleep(0.1)

    await stop_pipeline_task(task, run, timeout=20)

    assert cap.texts, "flue produced no reply text"
    # The browser would poll this endpoint (via the bot proxy) and get the topic once.
    async with httpx.AsyncClient(timeout=5) as c:
        got = (await c.get(f"http://127.0.0.1:3583/animation/{cid}")).json()
    assert got.get("topic") == "pythagoras", f"unexpected animation surfaced: {got}"
