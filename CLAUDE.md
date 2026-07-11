# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Voice weather agents on **Azure AI Foundry**. Two independent things live here:

- **Root** (`server.py` + `index.html`) — a self-contained, zero-dependency demo: a Python
  stdlib proxy serving one HTML page. Browser Web Speech for STT/TTS, gpt-5.4 for chat with a
  live weather tool. This is the simple reference version.
- **`pipecat-flue/`** — the real architecture: **pipecat** (Python) owns the real-time audio
  pipeline; **flue** (Node/TS) is the LLM harness sitting in the pipeline's LLM slot between STT
  and TTS. Split into `flue-agent/` (the brain) and `pipecat-app/` (the audio pipeline).

## Commands

**Root demo:**
```bash
python3 server.py                      # http://127.0.0.1:8000  (stdlib only, no install)
```

**`pipecat-flue/flue-agent/` (Node ≥22, TypeScript run natively via --experimental-strip-types):**
```bash
npm install
npm run dev                            # flue dev server on :3583
npm test                               # all unit tests
node --test --experimental-strip-types test/weather.test.ts   # a single test file
```
Note: `node --test <dir>` does NOT work here (module-load error); always pass explicit
`test/*.test.ts` file paths — this is why the `test` script globs.

**`pipecat-flue/pipecat-app/` (Python 3.13 — heavier deps lack 3.14 wheels):**
```bash
uv venv --python 3.13 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
python run_bot.py                      # WebRTC bot + client on http://localhost:7860/client/
python -m pytest tests/                # all tests
python -m pytest tests/test_e2e_audio.py   # a single test
```
Most pipecat tests hit the flue service and **skip** unless `flue-agent` is running on :3583,
so start `npm run dev` first. Running the full pipecat app needs BOTH processes up (flue :3583
+ bot :7860).

## Architecture that isn't obvious from one file

**Credentials + the two-region split.** All Azure keys are read at runtime from
`~/env/aifoundry.sh` (never committed). That file holds TWO resources under `# east-us-2` /
`# east-us-1` comment headers that reuse the same variable names (`apikey`, `openapi_endpoint`),
so it is parsed **section-aware** (never `source`d) in `flue-agent/src/config.ts` and
`pipecat-app/bot/azure.py`. The split is forced by capability, not preference:
- **gpt-5.4** (chat) and **MAI-Voice-2** (TTS) → east-us-2.
- **MAI-Transcribe-1.5** (STT) → east-us-1. MAI-Transcribe is "LLM Speech" and is region-gated
  (eastus/westus/westus2/northeurope/centralindia/southeastasia); it is **not** available in
  east-us-2.

**MAI audio models use the Azure Speech API, not the OpenAI route.** `MAI-Voice-2` /
`MAI-Transcribe-1.5` are served at `https://<res>.cognitiveservices.azure.com` (TTS:
`/tts/cognitiveservices/v1`; STT: `/speechtotext/transcriptions:transcribe` with
`enhancedMode.model`), a sibling host of the `*.openai.azure.com/openai/v1` chat endpoint. Both
code paths derive the speech host from the OpenAI endpoint. The `/openai/v1/models` catalog lists
region-wide models and does **not** reflect what is actually deployed/callable.

**gpt-5.4 quirks.** It rejects `max_tokens` (use `max_completion_tokens`) and unsupported sampling
params. In `flue-agent`, flue never calls Azure directly — it goes through an in-process proxy
(`src/azure-proxy.ts`, registered as a custom `azure` OpenAI-compatible provider in `src/app.ts`)
that (1) injects the `api-key` header, (2) normalizes those gpt-5 params, and (3) measures the
prompt-cache hit rate.

**Prompt caching is a deliberate design constraint.** Azure gpt-5.4 caching only activates on a
stable prefix ≥~1024 tokens. So `flue-agent/src/instructions.ts` is intentionally long, stable, and
FIRST, with **no per-request or time-varying content** (a timestamp or live weather in it would bust
the cache every call). Verify the live rate at `GET :3583/metrics` (climbs from ~48% cold to ~92%+).

**The flue↔pipecat seam.** pipecat's `FlueLLMProcessor` (`pipecat-app/bot/flue_llm.py`) turns a
`TranscriptionFrame` into `POST http://127.0.0.1:3583/agents/weather/<id>?wait=result` and pushes
the reply back as a `TextFrame` for TTS. The `<id>` is the conversation id — flue owns memory per
id, so the pipeline stays stateless. flue's react/tool loop and `get_weather` tool live entirely in
`flue-agent`; pipecat only moves text across the HTTP boundary.

**Audio format constraint.** MAI-Transcribe accepts WAV/OGG but **rejects webm/opus (422)**. So the
root demo captures mic PCM and WAV-encodes it client-side (`index.html`), and `pipecat-app`'s
`MaiTranscribeSTT` (a `SegmentedSTTService`) wraps the PCM segment as WAV before sending. In the
pipecat 1.5 pipeline, VAD is a stage (`VADProcessor`), not a transport param, and it emits the
`VADUser{Started,Stopped}SpeakingFrame`s that the segmented STT uses to bound each utterance.

## Testing note

`pipecat-app/tests/test_e2e_audio.py` is the highest-signal test: it drives the whole pipeline
headlessly (injects real 16 kHz speech + VAD frames, asserts transcript → flue reply → synthesized
audio out) — no browser or mic. Use it to validate changes to any pipeline stage.
