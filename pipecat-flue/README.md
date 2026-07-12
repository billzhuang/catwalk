# pipecat + flue voice agent

A real-time voice weather agent that combines two frameworks by their strengths:

- **[pipecat](https://github.com/pipecat-ai/pipecat)** — the audio chat *chain*: transport,
  VAD, turn-taking, streaming STT/TTS.
- **[flue](https://github.com/withastro/flue)** — the *harness/brain* in the LLM slot: the
  react/tool loop, conversation memory, and the model call.

```
browser mic ⇄ WebRTC ⇄  pipecat pipeline (Python)
                         transport.input → Silero VAD → MAI-Transcribe-1.5 (STT)
                                 │
                                 ▼  text
                         FlueLLMProcessor ──HTTP──▶  flue agent (Node)
                                 ▲  text              gpt-5.4 + tools + memory
                                 │        (weather, time, wolfram, web_search, web_fetch, show_math_animation)
                         MAI-Voice-2 (TTS) → transport.output ⇄ browser speaker

  browser polls  GET /animation/:clientId  ──▶  full-screen presentation of an animated SVG
                 (its own HTTP channel, decoupled from the WebRTC audio connection)
```

Ask to *see* a math idea ("show me the Pythagorean theorem") and the `show_math_animation` tool
shows a 3blue1brown-style animated SVG **full-screen** in the browser while the agent narrates it.
Delivery is decoupled from the audio connection (the browser polls its own animation channel). See
the "Math-animation presentation" section of the repo-root [`CLAUDE.md`](../CLAUDE.md) for the seam.

Two subprojects:

| Dir | Runtime | Role |
|-----|---------|------|
| [`flue-agent/`](flue-agent/) | Node / TypeScript | the brain: flue + gpt-5.4 (Azure) + weather tool, HTTP on :3583 |
| [`pipecat-app/`](pipecat-app/) | Python 3.13 | the audio pipeline: STT → flue → TTS, WebRTC on :7860 |

## Run

```bash
# 1) brain
cd flue-agent && npm install && npm run dev            # :3583

# 2) voice pipeline
cd ../pipecat-app
uv venv --python 3.13 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
python run_bot.py                                       # http://localhost:7860/app/
```

Open **`/app/`** (our custom client), allow the mic, and talk about the weather — or ask to
see some math. Azure keys are read at runtime from `~/env/aifoundry.sh` — never committed.
(The stock pipecat prebuilt client is still served at `/client/`, but it can't show the
full-screen animation presentation.)

## Models (Azure AI Foundry)

| Stage | Model | Resource | API |
|-------|-------|----------|-----|
| STT | `MAI-Transcribe-1.5` | east-us-1 | Speech fast-transcription (`enhancedMode`) |
| LLM | `gpt-5.4` | east-us-2 | OpenAI-compatible chat/completions (via flue) |
| TTS | `MAI-Voice-2` (`en-US-Jasper`) | east-us-2 | Speech `/tts/cognitiveservices/v1` |

MAI-Transcribe (LLM Speech) is region-gated to east-us-1; gpt-5.4 and MAI-Voice-2 live on
east-us-2 — hence two resources, parsed section-aware from one env file.

## Prompt caching

The flue agent's system prompt is deliberately long and **stable** so it becomes the
Azure gpt-5.4 cached prefix (caching activates only above ~1024 tokens). An in-process
proxy measures the live rate at `GET :3583/metrics` — it climbs from a cold ~48% toward
~95% as a conversation continues. See [`flue-agent/README.md`](flue-agent/README.md).

## Tests (73, all green)

```bash
cd flue-agent  && npm test                 # 46: weather/time/wolfram/web_search/web_fetch tools, gpt-5 body normalization, cache metrics, config
cd pipecat-app && python -m pytest tests/   # 27: WAV wrap, MAI round-trip, flue-in-pipeline, animation scenes, full-audio E2E
```

The headline test, `pipecat-app/tests/test_e2e_audio.py`, drives the **whole pipeline
headlessly**: it injects real 16 kHz speech and asserts a transcript, a flue reply, and
synthesized audio come back — plus that asking to *see* a concept emits the `math_animation`
cue. No browser or mic required.

## Conversation behavior

- **Always listening (hands-free):** no clicks — the pipeline listens continuously; Silero VAD
  segments each utterance and it keeps listening after every reply.
- **Barge-in:** start talking while the bot is speaking (or still thinking) and it stops and
  takes your new question. `UserTurnProcessor` broadcasts the interruption; `FlueLLMProcessor`
  cancels its in-flight request and POSTs flue's `/abort` to stop the server-side turn.
  Sensitivity is VAD-driven (tune `VADProcessor.speech_activity_period`).

## Status / next

The `gpt-realtime` speech-to-speech models (in the catalog) could collapse STT+LLM+TTS into one
socket for even lower latency — a future direction.
