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
2. Start the voice bot: `python run_bot.py`  → WebRTC + custom client on http://localhost:7860/app/
3. Open `/app/`, allow the mic, and talk — about the weather, or ask to see some math
   ("show me the Pythagorean theorem") and a popup plays the animation.

## Test

```bash
python -m pytest tests/
```

- `test_pcm.py` — WAV wrapping (no network).
- `test_mai_rest.py` — MAI-Voice-2 → MAI-Transcribe-1.5 round-trip (live Azure).
- `test_flue_pipeline.py` — **runs a real pipecat pipeline headlessly**: injects a
  TranscriptionFrame and captures the TextFrame flue emits, proving flue-in-the-middle
  without needing a mic. Requires the flue service on :3583.
- `test_animations.py` — every animated-SVG scene renders to well-formed, looping SVG; `render()`
  is a whitelist (no network).
- `test_e2e_audio.py` — also asserts that asking to *see* a concept emits the `math_animation`
  app-message with the right topic.

## Layout

- `bot/azure.py` — section-aware `~/env/aifoundry.sh` loader; STT=east-us-1, TTS=east-us-2.
- `bot/mai_stt.py` — `MaiTranscribeSTT(SegmentedSTTService)`: buffers a full utterance on VAD
  boundaries, wraps PCM as WAV (MAI-Transcribe rejects webm/opus), calls fast-transcription
  with `enhancedMode.model = mai-transcribe-1.5`.
- `bot/mai_tts.py` — `MaiVoiceTTS(TTSService)`: MAI-Voice-2, requests headerless 24 kHz PCM.
- `bot/flue_llm.py` — `FlueLLMProcessor(FrameProcessor)`: TranscriptionFrame → flue → TextFrame.
  Barge-in aware: on interruption it cancels the in-flight request and POSTs flue's `/abort`.
- `bot/animations.py` — stdlib-only 3blue1brown-style animated-SVG scenes (sine, pythagoras,
  derivative, vectors); `render(topic)` is the whitelisted entry point.
- `client/index.html` — hand-written, zero-build WebRTC client served at `/app/`, with two layouts
  (normal chat + full-screen **presentation/spotlight**). It generates a `clientId`, passes it in the
  offer's `request_data`, and **polls `GET /animation/:clientId`** on its own HTTP channel — decoupled
  from the WebRTC data channel (which is flaky to establish) — then fetches `/animation-svg/<topic>`
  and switches into the presentation layout. Topic chips preview it locally. (The prebuilt `/client/`
  ignores non-`rtvi-ai` messages, so `/` redirects to `/app/`.)
- `run_bot.py` — assembles VAD → STT → `UserTurnProcessor` → flue → TTS with WebRTC transport; uses the
  offer's `clientId` as the flue conversation id; and on the runner's FastAPI app serves the `/app/`
  client (`no-store`), `GET /animation-svg/{topic}`, `GET /animation/{cid}` (poll proxy to flue), and
  `/` → `/app/`.

## Conversation behavior

- **Hands-free / always listening:** no clicks; VAD segments continuous audio and the pipeline
  keeps listening after each reply.
- **Barge-in:** `UserTurnProcessor` converts "user started speaking" into a pipeline interruption
  (it re-enables interruptions that pipecat's LLM aggregator would normally provide — we replaced
  that with flue). `FlueLLMProcessor` then cancels its request and aborts flue's turn. Trigger is
  VAD-based (segmented STT has no interim words, so a transcription min-words gate wouldn't help);
  tune `VADProcessor.speech_activity_period` for sensitivity.
- **Token Usage (client Metrics tab):** `FlueLLMProcessor` isn't a pipecat LLM service, so it emits
  a `MetricsFrame` from flue's per-turn `usage` — otherwise that panel stays at 0. Metrics are
  enabled in `run_bot.py` (`enable_metrics`/`enable_usage_metrics`).

## Notes

- MAI-Transcribe-1.5 (LLM Speech) needs a supported region (east-us-1); it isn't available in
  east-us-2 where gpt-5.4 and MAI-Voice-2 live — hence the two Azure resources.
- Turn-based half-duplex today. gpt-realtime speech-to-speech (in the catalog) could collapse
  the three stages into one socket for lower latency — a future direction.
