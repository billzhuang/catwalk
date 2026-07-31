# flue-agent — the harness/brain

The [flue](https://github.com/withastro/flue) agent that sits in the **LLM slot between
STT and TTS** in the pipecat voice pipeline. It owns the react/tool loop, conversation
memory, and the model connection; pipecat calls it over HTTP, one turn at a time.

```
pipecat  ──POST /agents/weather/:id?wait=result { message }──▶  flue agent
                                                               │  react loop + tools
         ◀──────────────── { result: { text } } ──────────────┘  gpt-5.4 (Azure)
```

## Run

```bash
npm install
npm run dev        # flue dev on http://localhost:3583
npm test           # unit tests (node --test)
```

Azure credentials are read at runtime from `~/env/aifoundry.sh` (never committed). Set
`WOLFRAM_APP_ID` (a free Wolfram|Alpha developer AppID) to enable the `ask_wolfram` tool;
it's optional and degrades gracefully to an error message when unset.

## How it's wired

- `src/agents/weather.ts` — `defineAgent({ model, thinkingLevel, instructions, tools:[...] })`,
  `export const route` exposes it at `POST /agents/weather/:id`. `:id` is the conversation id,
  which gives per-conversation memory for free. Adding a tool means adding it to the `tools`
  array here — nothing else in the request path is weather-specific.
- `src/paths.ts` — shared `~/env/*.sh` file parsing: `expandHome` (`~` expansion) and
  `parseEnvLines`/`readEnvLines` (scan into header/key=value lines). Used by `config.ts`'s
  `~/env/aifoundry.sh` loader and `websearch.ts`'s `~/env/brave.sh` key lookup so the two
  "parity" parsers (also mirrored in `pipecat-app/bot/azure.py`) share one scan.
- `src/config.ts` — section-aware parser for `~/env/aifoundry.sh`'s two `# east-us-2` /
  `# east-us-1` blocks (same `apikey`/`openai_endpoint` var names in each), so a preferred
  credential/endpoint block is selected and cached without `source`-ing the file.
- `src/model-config.ts` — resolves `model`/`thinkingLevel` from `FLUE_MODEL` /
  `FLUE_THINKING_LEVEL` env vars (defaulting to `azure/gpt-5.4` @ `low`), so ops can point at
  another existing deployment (e.g. DeepSeek on the same Azure AI Foundry resource) or change
  reasoning effort without a code change. Set `FLUE_MODEL` on the pipecat-app side too
  (`bot/flue_llm.py`) to keep its metrics label in sync.
- `src/app.ts` — registers the custom `azure` provider (OpenAI-compatible) pointed at the
  in-process proxy, mounts `flue()`, `/az` (proxy), `/health`, `/metrics`. Uses `observe()` to
  catch the animation tools' calls and keeps their per-conversation state in `src/state-map.ts`.
- `src/azure-proxy.ts` — flue → Azure proxy that (1) injects the `api-key` header, (2) normalizes
  gpt-5 request quirks (`max_tokens`→`max_completion_tokens`, drops unsupported sampling params),
  and (3) measures the prompt-cache hit rate.
- `src/tool-net.ts` — shared network plumbing for the lookup-style tools: `resolveTimeoutSignal`
  (turn-scoped abort signal combined with a default timeout), HTML entity decoding, and
  `withSpanAndLookupError` (span + uniform error message) so `weather`/`time`/`wolfram`/`websearch`
  don't each repeat the same idiom.
- `src/weather.ts` — the `get_weather` tool + Open-Meteo lookup (free, no key). Also exports
  `resolveGeocode`/`placeLabel`, shared with any other tool that resolves a place name.
- `src/time.ts` — the `get_time` tool: current local time for a place, via the same
  Open-Meteo geocoding lookup.
- `src/wolfram.ts` — the `ask_wolfram` tool: short factual/computed answers (math, unit
  conversions, general knowledge) via Wolfram|Alpha's free Short Answers API. Needs a
  `WOLFRAM_APP_ID` (a free developer AppID, ~2000 calls/month); without one the tool
  returns a graceful "not configured" error instead of failing.
- `src/websearch.ts` — the `web_search` tool: Brave Search API, needs `BRAVE_API_KEY` (or a
  `~/env/brave.sh`); degrades gracefully to an error when unset.
- `src/webfetch.ts` — the `web_fetch` tool: fetches a URL and reduces its HTML to readable plain
  text for the model to read aloud, with SSRF guarding (rejects private/loopback resolved IPs),
  a byte/char cap, and a redirect cap.
- `src/animation.ts` — the `show_math_animation`/`control_math_animation` tools: four hand-built
  topics (`sine`, `pythagoras`, `derivative`, `vectors`) plus an on-the-fly `title`/`steps` topic
  for anything else. Only echoes its input — pipecat/the browser do the actual rendering (see the
  root `CLAUDE.md`'s "Math-animation presentation" section for the full seam).
- `src/instructions.ts` — `buildInstructions(toolSections)` assembles the system prompt from a
  stable persona + one section per registered tool (each tool exports its own `*_INSTRUCTIONS`,
  e.g. `WEATHER_INSTRUCTIONS`) + a stable closing. Deliberately long and stable (see caching
  below) — sections are joined once, at import time, never per-request.
- `src/telemetry.ts` — OpenTelemetry tracing, off by default. `withSpan()`/`withSpanAndLookupError()`
  wrap the Azure chat completion call and every tool (`get_weather`, `get_time`, `ask_wolfram`,
  `web_search`, `web_fetch`, `show_math_animation`, `control_math_animation`) in a span; with no
  exporter configured they cost nothing beyond the API's no-op tracer. Set `OTEL_EXPORTER_OTLP_ENDPOINT`
  (standard OTel env var) to export spans via OTLP/HTTP to a collector; `OTEL_SERVICE_NAME`
  overrides the reported service name (default `flue-agent`).

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
