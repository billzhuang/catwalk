import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createAzureProxy, metrics, cacheRate } from './azure-proxy.ts';

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

app.get('/health', (c) => c.json({ ok: true, model: 'azure/gpt-5.4', proxyBase: PROXY_BASE }));

// Live prompt-cache metrics (proof the caching rate is good).
app.get('/metrics', (c) =>
  c.json({ ...metrics, cacheRate: Number(cacheRate().toFixed(4)) }),
);

// flue -> Azure proxy (auth + gpt-5 normalization + cache measurement).
app.route('/az', createAzureProxy());

// flue's public API: POST /agents/weather/:id?wait=result etc.
app.route('/', flue());

export default app;
