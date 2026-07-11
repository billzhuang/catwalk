# Voice Chain — Azure AI Foundry

A real-time **voice weather agent** on Azure AI Foundry, all three stages served by
Microsoft/OpenAI models, with **3blue1brown-style math animations** that pop up in the
browser when you ask to *see* a concept.

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

The whole thing lives in **[`pipecat-flue/`](pipecat-flue/)** — that's the project. It
splits into `flue-agent/` (the Node/TypeScript brain) and `pipecat-app/` (the Python audio
pipeline + browser client). See [`pipecat-flue/README.md`](pipecat-flue/README.md) to run it.

## Quick start

```bash
# 1) brain
cd pipecat-flue/flue-agent && npm install && npm run dev        # :3583

# 2) voice pipeline + client
cd ../pipecat-app
uv venv --python 3.13 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
python run_bot.py                                               # http://localhost:7860/app/
```

Open **http://localhost:7860/app/**, allow the mic, and talk — ask about the weather
("what's it like in Tokyo?") or ask to see some math ("show me the Pythagorean theorem").

## Models & endpoints (Azure AI Foundry)

| Stage | Model | Azure resource / region | API |
|-------|-------|-------------------------|-----|
| STT   | `MAI-Transcribe-1.5` | east-us-1 | Speech fast-transcription, `enhancedMode` |
| LLM   | `gpt-5.4`            | east-us-2 | OpenAI-compatible `/chat/completions` (via flue) |
| TTS   | `MAI-Voice-2` (`en-US-Jasper`) | east-us-2 | Speech `/tts/cognitiveservices/v1` |

Two resources are used because **MAI-Transcribe (LLM Speech) is region-gated** — it runs in
eastus/westus/westus2/northeurope/centralindia/southeastasia, but **not** east-us-2, where
gpt-5.4 and MAI-Voice-2 live. MAI-Voice / MAI-Transcribe are served by the **Azure Speech**
API (`*.cognitiveservices.azure.com`), not the OpenAI-compatible route.

## Config (secrets stay out of this repo)

Credentials are read at runtime from `~/env/aifoundry.sh` — **never committed here**. The
file holds two blocks under `# east-us-2` / `# east-us-1` comment headers, each with
`apikey=` and `openai_endpoint=`; both code paths parse it section-aware (so the reused
variable names don't collide) and derive the Speech hosts automatically.

```sh
# east-us-2
apikey=...
openai_endpoint=https://<res>.openai.azure.com/openai/v1
# east-us-1
apikey=...
openai_endpoint=https://<res>.openai.azure.com/openai/v1
```

Optional tool keys (also never committed): `web_search` reads a Brave Search key from
`~/env/brave.sh` (`apikey=…`); `ask_wolfram` reads `WOLFRAM_APP_ID` from the environment. Both
degrade gracefully — the agent tells the user it can't look that up — when the key is absent.

## Notes

- gpt-5.4 requires `max_completion_tokens` (not `max_tokens`).
- MAI-Transcribe-1.5 accepts WAV and OGG/Opus; it returns 422 for WebM/Opus.
- Voices: `en-US-Jasper/Ethan/Grant` (M), `en-US-Olivia/Iris/Harper` (F), plus many locales.
