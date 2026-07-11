# flue-agent — the harness/brain

The [flue](https://github.com/withastro/flue) agent that sits in the **LLM slot between
STT and TTS** in the pipecat voice pipeline. It owns the react/tool loop, conversation
memory, and the model connection; pipecat calls it over HTTP, one turn at a time.

```
pipecat  ──POST /agents/weather/:id?wait=result { message }──▶  flue agent
                                                               │  react loop + get_weather tool
         ◀──────────────── { result: { text } } ──────────────┘  gpt-5.4 (Azure)
```

## Run

```bash
npm install
npm run dev        # flue dev on http://localhost:3583
npm test           # unit tests (node --test)
```

Azure credentials are read at runtime from `~/env/aifoundry.sh` (never committed).

## How it's wired

- `src/agents/weather.ts` — `defineAgent({ model: 'azure/gpt-5.4', instructions, tools:[getWeather] })`,
  `export const route` exposes it at `POST /agents/weather/:id`. `:id` is the conversation id,
  which gives per-conversation memory for free.
- `src/app.ts` — registers the custom `azure` provider (OpenAI-compatible) pointed at the
  in-process proxy, mounts `flue()`, `/az` (proxy), `/health`, `/metrics`.
- `src/azure-proxy.ts` — flue → Azure proxy that (1) injects the `api-key` header, (2) normalizes
  gpt-5 request quirks (`max_tokens`→`max_completion_tokens`, drops unsupported sampling params),
  and (3) measures the prompt-cache hit rate.
- `src/weather.ts` — the `get_weather` tool + Open-Meteo lookup (free, no key).
- `src/instructions.ts` — the system prompt, deliberately long and stable (see caching below).

## Prompt caching

Azure gpt-5.4 prompt caching activates only on a **stable prefix of ~1024+ tokens** (measured:
19-token prompt caches nothing; ~1900-token stable prefix reaches ~94% on the second call).
So the design keeps the instructions long, stable, and FIRST, with **no per-request or
time-varying content** in them. Every turn and every conversation reuses that cached prefix.

Watch it live:

```bash
curl -s localhost:3583/metrics
# {"calls":6,"promptTokens":10262,"cachedTokens":8192,"completionTokens":160,"cacheRate":0.80}
```

The cold-start first call can't cache (inherent to prompt caching); the rate climbs toward
~95% as the conversation continues. flue's own `result.usage.cacheRead` corroborates the proxy's numbers.

## Try it

```bash
curl -s -X POST 'localhost:3583/agents/weather/demo?wait=result' \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the weather in Tokyo right now?"}'
```
