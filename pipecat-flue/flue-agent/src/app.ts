import { registerProvider, observe } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createAzureProxy, metrics, cacheRate } from './azure-proxy.ts';
import { resolveModel } from './model-config.ts';
import { initTelemetry } from './telemetry.ts';

// No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set; awaited so the exporter is registered
// before the first request can start a span.
await initTelemetry();

// Port flue dev binds (default 3583). The `azure` provider calls back into this
// same process's /az proxy over loopback.
const PORT = Number(process.env.PORT ?? process.env.FLUE_PORT ?? 3583);
const PROXY_BASE = process.env.AZURE_PROXY_BASE ?? `http://127.0.0.1:${PORT}/az/v1`;

// gpt-5.4 on Azure via an OpenAI-compatible custom provider. The proxy injects the
// real api-key, so the key never lives in flue config or the repo.
registerProvider('azure', {
  api: 'openai-completions',
  baseUrl: PROXY_BASE,
  apiKey: 'via-proxy', // ignored; the proxy sets the real Azure api-key header
  contextWindow: 272_000,
  maxTokens: 8_192,
});

const app = new Hono();

// show_math_animation is a UI side-effect: flue's turn result only carries text, so we
// observe the tool call here and stash the chosen topic keyed by the conversation id (the
// `:id` in POST /agents/weather/:id). The pipecat bot polls GET /animation/:id right after a
// turn and pushes the topic to the browser. Read-and-clear so each topic is delivered once.
const pendingAnimations = new Map<string, { topic: string; keys: string[] }>();
observe((event) => {
  if (event.type !== 'tool_start' || event.toolName !== 'show_math_animation') return;
  const topic = (event.args as { topic?: unknown } | undefined)?.topic;
  if (typeof topic !== 'string') return;
  // Direct agent activity is keyed by instanceId; conversationId may also be set. Store the
  // entry under both aliases (a lookup by the URL id hits regardless of which one the runtime
  // populated) and remember them so read-and-clear can delete every alias — no leaked entries.
  const keys = [event.conversationId, event.instanceId].filter((k): k is string => !!k);
  const entry = { topic, keys };
  for (const key of keys) pendingAnimations.set(key, entry);
});

app.get('/health', (c) => c.json({ ok: true, model: resolveModel(), proxyBase: PROXY_BASE }));

// Live prompt-cache metrics (proof the caching rate is good).
app.get('/metrics', (c) =>
  c.json({ ...metrics, cacheRate: Number(cacheRate().toFixed(4)) }),
);

// Latest math animation the model asked for on this conversation, if any (read-and-clear).
app.get('/animation/:id', (c) => {
  const id = c.req.param('id');
  const entry = pendingAnimations.get(id);
  if (entry) for (const key of entry.keys) pendingAnimations.delete(key); // clear all aliases
  return c.json({ topic: entry?.topic ?? null });
});

// flue -> Azure proxy (auth + gpt-5 normalization + cache measurement).
app.route('/az', createAzureProxy());

// flue's public API: POST /agents/weather/:id?wait=result etc.
app.route('/', flue());

export default app;
