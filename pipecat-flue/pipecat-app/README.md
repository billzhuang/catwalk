# pipecat-app — the audio chat pipeline

The real-time voice pipeline. Pipecat owns the audio loop (transport, VAD,
turn-taking, streaming); **flue sits in the LLM slot** between STT and TTS.

```
browser mic ⇄ WebRTC ⇄ transport.input()
                       → VADProcessor (Silero)          — utterance boundaries
                       → MaiTranscribeSTT               — MAI-Transcribe-1.5 (east-us-1)
                       → FlueLLMProcessor  ──HTTP──▶ flue agent (gpt-5.4 + weather tool)
                       → MaiVoiceTTS                    — MAI-Voice-2 (east-us-2)
                       → transport.output() ⇄ browser speaker
```

## Setup

```bash
uv venv --python 3.13 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
```

Azure keys are read at runtime from `~/env/aifoundry.sh` (never committed).

## Run

1. Start the brain (in `../flue-agent`): `npm run dev`  → flue on :3583
2. Start the voice bot: `python run_bot.py`  → WebRTC + client on http://localhost:7860/client/
3. Open the client, allow the mic, and talk about the weather.

## Test

```bash
python -m pytest tests/
```

- `test_pcm.py` — WAV wrapping (no network).
- `test_mai_rest.py` — MAI-Voice-2 → MAI-Transcribe-1.5 round-trip (live Azure).
- `test_flue_pipeline.py` — **runs a real pipecat pipeline headlessly**: injects a
  TranscriptionFrame and captures the TextFrame flue emits, proving flue-in-the-middle
  without needing a mic. Requires the flue service on :3583.

## Layout

- `bot/azure.py` — section-aware `~/env/aifoundry.sh` loader; STT=east-us-1, TTS=east-us-2.
- `bot/mai_stt.py` — `MaiTranscribeSTT(SegmentedSTTService)`: buffers a full utterance on VAD
  boundaries, wraps PCM as WAV (MAI-Transcribe rejects webm/opus), calls fast-transcription
  with `enhancedMode.model = mai-transcribe-1.5`.
- `bot/mai_tts.py` — `MaiVoiceTTS(TTSService)`: MAI-Voice-2, requests headerless 24 kHz PCM.
- `bot/flue_llm.py` — `FlueLLMProcessor(FrameProcessor)`: TranscriptionFrame → flue → TextFrame.
  Barge-in aware: on interruption it cancels the in-flight request and POSTs flue's `/abort`.
- `run_bot.py` — assembles VAD → STT → `UserTurnProcessor` → flue → TTS with WebRTC transport;
  `python run_bot.py`.

## Conversation behavior

- **Hands-free / always listening:** no clicks; VAD segments continuous audio and the pipeline
  keeps listening after each reply.
- **Barge-in:** `UserTurnProcessor` converts "user started speaking" into a pipeline interruption
  (it re-enables interruptions that pipecat's LLM aggregator would normally provide — we replaced
  that with flue). `FlueLLMProcessor` then cancels its request and aborts flue's turn. Trigger is
  VAD-based (segmented STT has no interim words, so a transcription min-words gate wouldn't help);
  tune `VADProcessor.speech_activity_period` for sensitivity.

## Notes

- MAI-Transcribe-1.5 (LLM Speech) needs a supported region (east-us-1); it isn't available in
  east-us-2 where gpt-5.4 and MAI-Voice-2 live — hence the two Azure resources.
- Turn-based half-duplex today. gpt-realtime speech-to-speech (in the catalog) could collapse
  the three stages into one socket for lower latency — a future direction.
