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
                                 ▲  text              gpt-5.4 + get_weather tool + memory
                                 │
                         MAI-Voice-2 (TTS) → transport.output ⇄ browser speaker
```

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
python run_bot.py                                       # http://localhost:7860/client/
```

Open the client, allow the mic, and talk about the weather. Azure keys are read at
runtime from `~/env/aifoundry.sh` — never committed.

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

## Tests (16, all green)

```bash
cd flue-agent  && npm test                 # 10: weather map, gpt-5 body normalization, cache metrics, config
cd pipecat-app && python -m pytest tests/   # 6: WAV wrap, MAI round-trip, flue-in-pipeline, full-audio E2E
```

The headline test, `pipecat-app/tests/test_e2e_audio.py`, drives the **whole pipeline
headlessly**: it injects real 16 kHz speech, and asserts a transcript, a flue reply about
the right city, and synthesized audio come back out — no browser or mic required.

## Conversation behavior

- **Always listening (hands-free):** no clicks — the pipeline listens continuously; Silero VAD
  segments each utterance and it keeps listening after every reply.
- **Barge-in:** start talking while the bot is speaking (or still thinking) and it stops and
  takes your new question. `UserTurnProcessor` broadcasts the interruption; `FlueLLMProcessor`
  cancels its in-flight request and POSTs flue's `/abort` to stop the server-side turn.
  Sensitivity is VAD-driven (tune `VADProcessor.speech_activity_period`).

## Status / next

The `gpt-realtime` speech-to-speech models (in the catalog) could collapse STT+LLM+TTS into one
socket for even lower latency — a future direction. The simpler single-page version of this demo
lives at the repo root (`server.py` + `index.html`).
