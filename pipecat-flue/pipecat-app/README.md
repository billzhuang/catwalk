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
   ("show me the Pythagorean theorem") and the client switches to a full-screen animation.

## Test

```bash
python -m pytest tests/
```

No network, no live flue service required (fake transports / direct unit calls):

- `test_pcm.py` — WAV wrapping.
- `test_azure.py` — `bot/azure.py`'s section-aware `~/env/aifoundry.sh` loader: parsing,
  block selection, credential/endpoint override fallback.
- `test_mai_stt_transcribe.py` — `MaiTranscribeSTT.transcribe`/`run_stt` request-building,
  response-parsing (both `combinedPhrases` and bare-`text` shapes), and frame emission.
- `test_mai_tts_synthesize.py` — `MaiVoiceTTS.synthesize`/`run_tts` SSML request-building
  and frame emission.
- `test_http_client_cleanup.py` — `OwnedHttpClientCleanupMixin.cleanup()`'s guard against a
  `_client` that was never assigned.
- `test_close_pipeline_http_clients.py` — `conftest.py`'s `close_pipeline_http_clients()`
  helper against fake pipeline stages.
- `test_flue_llm.py` — `FlueLLMProcessor`'s usage-metrics coercion, success/fallback-reply
  paths, and barge-in abort handling.
- `test_run_bot_conversation_id.py` — `resolve_conversation_id`'s clientId/session_id/default
  fallback chain.
- `test_run_bot_build_pipeline.py` — `build_pipeline()`'s VAD → STT → turns → flue → TTS wiring.
- `test_run_bot_client_routes.py` — `GET /`, `/app`, `/app/`, the routes that steer browsers
  to the custom client.
- `test_run_bot_animation_route.py` — `GET /animation-svg/{topic}`'s title/steps/step
  query-param wiring into `bot.animations.render()`.
- `test_run_bot_animation_poll.py` — `GET /animation/{cid}`'s proxy to flue's own endpoint.
- `test_run_bot_bot_entrypoint.py` — `bot()`, the per-session entrypoint pipecat's runner calls.
- `test_run_bot_error_apology.py` — `build_apology_handler`'s spoken-apology fallback for a
  non-fatal pipeline `ErrorFrame`: silence on a fatal error, and the cooldown that suppresses
  (then later allows) a retriggered apology.
- `test_run_bot_flue_client_shutdown.py` — the animation-poll proxy's shared httpx client is
  opened/closed with the FastAPI app's lifespan.
- `test_animations.py` — every animated-SVG scene renders to well-formed, looping SVG; `render()`
  is a whitelist.

Require a live flue service on :3583 (skip otherwise):

- `test_flue_pipeline.py` — **runs a real pipecat pipeline headlessly**: injects a
  TranscriptionFrame and captures the TextFrame flue emits, proving flue-in-the-middle
  without needing a mic.
- `test_interruption.py` — barge-in: an `InterruptionFrame` mid-turn cancels the flue call,
  drops the reply, and calls flue's `/abort`.
- `test_e2e_audio.py` — also asserts that asking to *see* a concept surfaces the right topic
  at flue's `GET /animation/<id>` — the decoupled HTTP polling channel the browser client
  reads (see CLAUDE.md's "Math-animation presentation"), not a WebRTC data-channel app-message.

Requires live Azure credentials (skip otherwise):

- `test_mai_rest.py` — MAI-Voice-2 → MAI-Transcribe-1.5 round-trip.

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
- `bot/http_client_cleanup.py` — `OwnedHttpClientCleanupMixin`: shared teardown for a class that
  owns an `httpx.AsyncClient` the base class doesn't know about (`FlueLLMProcessor`,
  `MaiTranscribeSTT`, `MaiVoiceTTS`); closes it in `cleanup()` even if `super().cleanup()` raises.
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
