# Voice Chain — Azure AI Foundry

A test webpage for a full spoken conversation chain on Azure AI Foundry, all three
stages served by Microsoft/OpenAI models:

```
mic ──▶ MAI-Transcribe-1.5 ──▶ gpt-5.4 (+live weather) ──▶ MAI-Voice-2 ──▶ speaker
        (speech-to-text)        (brain)                     (text-to-speech)
```

Ask about the weather anywhere ("what's it like in Tokyo?") and gpt-5.4 calls a
`get_weather` tool backed by Open-Meteo (free, no key), so replies use **real** data.

## Run

```bash
python3 server.py            # then open http://127.0.0.1:8000 in Chrome
```

No dependencies — Python stdlib only. Open the page, click **Start chain**, allow the
mic, and talk. "Talk once" does a single turn.

## Models & endpoints

| Stage | Model | Azure resource / region | API |
|-------|-------|-------------------------|-----|
| STT   | `MAI-Transcribe-1.5` | east-us-1 | Speech fast-transcription, `enhancedMode` |
| LLM   | `gpt-5.4`            | east-us-2 | OpenAI-compatible `/chat/completions` |
| TTS   | `MAI-Voice-2` (`en-US-Jasper`) | east-us-2 | Speech `/tts/cognitiveservices/v1` |

Two resources are used because **MAI-Transcribe (LLM Speech) is region-gated** — it
runs in eastus/westus/westus2/northeurope/centralindia/southeastasia, but **not**
east-us-2. gpt-5.4 and MAI-Voice-2 live on the east-us-2 resource. MAI-Voice /
MAI-Transcribe are served by the **Azure Speech** API (`*.cognitiveservices.azure.com`),
not the OpenAI-compatible route.

## Config (secrets stay out of this repo)

Credentials are read at runtime from `~/env/aifoundry.sh` — **never committed here**.
The file holds two blocks under `# east-us-2` / `# east-us-1` comment headers, each with
`apikey=` and `openapi_endpoint=`; the server parses them section-aware (so the reused
variable names don't collide) and derives the Speech hosts automatically.

```sh
# east-us-2
apikey=...
openapi_endpoint=https://<res>.openai.azure.com/openai/v1
# east-us-1
apikey=...
openapi_endpoint=https://<res>.openai.azure.com/openai/v1
```

Env overrides: `PORT`, `CHAT_MODEL`, `TTS_MODEL`, `TTS_VOICE`, `STT_MAI_MODEL`,
`SPEECH_ENDPOINT`, `STT_SPEECH_ENDPOINT`, `AIFOUNDRY_ENV`.

## How the chain runs

- **Server** (`server.py`) is a stdlib proxy; the API key never reaches the browser.
  - `POST /api/chat` — gpt-5.4 with the `get_weather` tool loop.
  - `POST /api/tts`  — MAI-Voice-2, returns MP3.
  - `POST /api/stt`  — MAI-Transcribe-1.5 (falls back to the standard model on error).
  - `GET  /api/health` — probes each model and reports what's live.
- **Page** (`index.html`) records mic PCM and sends a **WAV** to `/api/stt` — MAI-Transcribe
  accepts WAV/OGG but rejects the browser's native webm/opus, so PCM is captured and
  WAV-encoded client-side. Browser Web Speech / speechSynthesis are automatic fallbacks
  if a server stage is unreachable.

## Notes

- gpt-5.4 requires `max_completion_tokens` (not `max_tokens`).
- MAI-Transcribe-1.5 accepts WAV and OGG/Opus; it returns 422 for WebM/Opus.
- Voices: `en-US-Jasper/Ethan/Grant` (M), `en-US-Olivia/Iris/Harper` (F), plus many locales.
```
