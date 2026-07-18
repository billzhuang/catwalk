import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBody,
  usageFromSse,
  recordUsage,
  cacheRate,
  metrics,
  annotateUsage,
  recordAndAnnotateUsage,
  createAzureProxy,
} from '../src/azure-proxy.ts';
import { withEnvVars, withTempFile } from './test-helpers.ts';

function fakeSpan() {
  const calls: Record<string, unknown>[] = [];
  return { calls, setAttributes: (attrs: Record<string, unknown>) => calls.push(attrs) };
}

function resetMetrics() {
  metrics.calls = 0;
  metrics.promptTokens = 0;
  metrics.cachedTokens = 0;
  metrics.completionTokens = 0;
}

/** Points AIFOUNDRY_ENV at a throwaway east-us-2 block for the duration of `fn`. */
function withAifoundryEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withTempFile(
    'aifoundry-',
    'aifoundry.sh',
    '# east-us-2\napikey=test-key\nopenai_endpoint=https://example.openai.azure.com/openai/v1\n',
    (file) => withEnvVars({ AIFOUNDRY_ENV: file }, fn),
  );
}

/** Stubs global fetch with `impl` for the duration of `fn`, then restores it. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test('normalizeBody: gpt-5 max_tokens -> max_completion_tokens', () => {
  const out = normalizeBody({ model: 'gpt-5.4', max_tokens: 256, messages: [] });
  assert.equal(out.max_tokens, undefined);
  assert.equal(out.max_completion_tokens, 256);
});

test('normalizeBody: gpt-5 drops unsupported sampling params', () => {
  const out = normalizeBody({ model: 'gpt-5.4', temperature: 0.7, top_p: 0.9, presence_penalty: 1, messages: [] });
  assert.equal(out.temperature, undefined);
  assert.equal(out.top_p, undefined);
  assert.equal(out.presence_penalty, undefined);
});

test('normalizeBody: keeps existing max_completion_tokens and non-gpt5 untouched', () => {
  const g5 = normalizeBody({ model: 'gpt-5.4', max_tokens: 10, max_completion_tokens: 99, messages: [] });
  assert.equal(g5.max_completion_tokens, 99);
  const other = normalizeBody({ model: 'gpt-4o', temperature: 0.5, max_tokens: 100, messages: [] });
  assert.equal(other.temperature, 0.5, 'non-gpt5 keeps temperature');
  assert.equal(other.max_tokens, 100, 'non-gpt5 keeps max_tokens');
});

test('normalizeBody: streaming requests a usage chunk', () => {
  const out = normalizeBody({ model: 'gpt-5.4', stream: true, messages: [] });
  assert.equal(out.stream_options?.include_usage, true);
});

test('usageFromSse: extracts usage from the final data chunk', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"delta":{"content":"!"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":1408}}}',
    'data: [DONE]',
  ].join('\n\n');
  const usage = usageFromSse(sse);
  assert.equal(usage?.prompt_tokens, 1500);
  assert.equal(usage?.prompt_tokens_details?.cached_tokens, 1408);
});

test('usageFromSse: ignores a malformed data line instead of throwing', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {truncated mid-chunk', // e.g. a chunk boundary split mid-JSON
    'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":3}}',
    'data: [DONE]',
  ].join('\n\n');
  const usage = usageFromSse(sse);
  assert.equal(usage?.prompt_tokens, 42);
});

test('recordUsage + cacheRate accumulate correctly', () => {
  resetMetrics();
  recordUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
  recordUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } });
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.promptTokens, 2000);
  assert.equal(metrics.cachedTokens, 900);
  assert.equal(cacheRate(), 0.45);
});

test('recordUsage: is a no-op when usage is missing', () => {
  resetMetrics();
  recordUsage(null);
  recordUsage(undefined);
  assert.equal(metrics.calls, 0);
  assert.equal(metrics.promptTokens, 0);
});

test('recordUsage: missing fields default to 0 instead of poisoning metrics with NaN', () => {
  resetMetrics();
  recordUsage({});
  recordUsage({ prompt_tokens_details: null });
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.promptTokens, 0);
  assert.equal(metrics.completionTokens, 0);
  assert.equal(metrics.cachedTokens, 0);
  // a later well-formed call must still accumulate normally, proving no NaN leaked in above.
  recordUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } });
  assert.equal(metrics.calls, 3);
  assert.equal(metrics.promptTokens, 1000);
  assert.equal(cacheRate(), 0.9);
});

test('annotateUsage: sets token-usage attributes on the span from usage', () => {
  const span = fakeSpan();
  annotateUsage(span as any, {
    prompt_tokens: 1500,
    completion_tokens: 12,
    prompt_tokens_details: { cached_tokens: 1408 },
  });
  assert.deepEqual(span.calls, [
    { 'llm.usage.prompt_tokens': 1500, 'llm.usage.completion_tokens': 12, 'llm.usage.cached_tokens': 1408 },
  ]);
});

test('annotateUsage: is a no-op when usage is missing', () => {
  const span = fakeSpan();
  annotateUsage(span as any, null);
  assert.deepEqual(span.calls, []);
});

test('recordAndAnnotateUsage: updates metrics and annotates the span together', () => {
  resetMetrics();
  const span = fakeSpan();
  recordAndAnnotateUsage(span as any, {
    prompt_tokens: 1000,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 800 },
  });
  assert.equal(metrics.calls, 1);
  assert.equal(metrics.promptTokens, 1000);
  assert.equal(metrics.cachedTokens, 800);
  assert.deepEqual(span.calls, [
    { 'llm.usage.prompt_tokens': 1000, 'llm.usage.completion_tokens': 20, 'llm.usage.cached_tokens': 800 },
  ]);
});

test('GET /v1/models: returns a minimal catalog so OpenAI clients probing it do not error', async () => {
  const app = createAzureProxy();
  const res = await app.request('/v1/models');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, 'list');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].id, 'gpt-5.4');
  assert.equal(json.data[0].object, 'model');
  assert.equal(json.data[0].owned_by, 'azure');
});

test('POST /v1/chat/completions: buffered JSON response is echoed through and usage recorded', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 500, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 400 } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof fetch,
      async () => {
        resetMetrics();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
        });
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.choices[0].message.content, 'hi');
        assert.equal(metrics.calls, 1);
        assert.equal(metrics.promptTokens, 500);
        assert.equal(metrics.cachedTokens, 400);
      },
    ),
  );
});

test('POST /v1/chat/completions: non-JSON error body is passed through without recording usage', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      (async () => new Response('upstream exploded', { status: 500, headers: { 'Content-Type': 'text/plain' } })) as typeof fetch,
      async () => {
        resetMetrics();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
        });
        assert.equal(res.status, 500);
        assert.equal(await res.text(), 'upstream exploded');
        assert.equal(metrics.calls, 0);
      },
    ),
  );
});

test('POST /v1/chat/completions: streaming SSE is teed through and usage recorded at end-of-stream', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":1408}}}\n\n',
    'data: [DONE]\n\n',
  ];
  await withAifoundryEnv(() =>
    withFetch(
      (async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as typeof fetch,
      async () => {
        resetMetrics();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', stream: true, messages: [] }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'text/event-stream');
        const text = await res.text();
        assert.equal(text, chunks.join(''));
        assert.equal(metrics.calls, 1);
        assert.equal(metrics.promptTokens, 1500);
        assert.equal(metrics.cachedTokens, 1408);
      },
    ),
  );
});
