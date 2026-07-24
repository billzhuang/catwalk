import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  normalizeBody,
  usageFromSse,
  cacheRate,
  metrics,
  recordAndAnnotateUsage,
  createAzureProxy,
} from '../src/azure-proxy.ts';
import { withEnvVars, withTempFile } from './test-helpers.ts';

// SimpleSpanProcessor exports synchronously on span.end(), so spans are visible immediately —
// same setup as telemetry.test.ts, scoped to this file's own worker/process.
const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }));

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

test('cacheRate: returns 0 when no prompt tokens have been recorded yet (avoids division by zero)', () => {
  resetMetrics();
  assert.equal(cacheRate(), 0);
});

test('recordAndAnnotateUsage + cacheRate accumulate correctly', () => {
  resetMetrics();
  const span = fakeSpan();
  recordAndAnnotateUsage(span as any, { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
  recordAndAnnotateUsage(span as any, { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } });
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.promptTokens, 2000);
  assert.equal(metrics.cachedTokens, 900);
  assert.equal(cacheRate(), 0.45);
});

test('recordAndAnnotateUsage: is a no-op (metrics and span alike) when usage is missing', () => {
  resetMetrics();
  const span = fakeSpan();
  recordAndAnnotateUsage(span as any, null);
  recordAndAnnotateUsage(span as any, undefined);
  assert.equal(metrics.calls, 0);
  assert.equal(metrics.promptTokens, 0);
  assert.deepEqual(span.calls, []);
});

test('recordAndAnnotateUsage: missing fields default to 0 instead of poisoning metrics with NaN', () => {
  resetMetrics();
  const span = fakeSpan();
  recordAndAnnotateUsage(span as any, {});
  recordAndAnnotateUsage(span as any, { prompt_tokens_details: null });
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.promptTokens, 0);
  assert.equal(metrics.completionTokens, 0);
  assert.equal(metrics.cachedTokens, 0);
  assert.deepEqual(span.calls, [
    { 'llm.usage.prompt_tokens': 0, 'llm.usage.completion_tokens': 0, 'llm.usage.cached_tokens': 0 },
    { 'llm.usage.prompt_tokens': 0, 'llm.usage.completion_tokens': 0, 'llm.usage.cached_tokens': 0 },
  ]);
  // a later well-formed call must still accumulate normally, proving no NaN leaked in above.
  recordAndAnnotateUsage(span as any, { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } });
  assert.equal(metrics.calls, 3);
  assert.equal(metrics.promptTokens, 1000);
  assert.equal(cacheRate(), 0.9);
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

test('POST /v1/chat/completions: missing upstream Content-Type and missing request model both default', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      // An ArrayBuffer/Uint8Array body sets no default Content-Type header (unlike a string
      // body, which fetch auto-labels text/plain), so this exercises the ctype ?? '' fallback
      // in respondBuffered — same as an upstream response that genuinely omits the header.
      (async () => new Response(new TextEncoder().encode(JSON.stringify({ choices: [] })), { status: 200 })) as typeof fetch,
      async () => {
        const app = createAzureProxy();
        // No `model` field — exercises the `incoming.model ?? ''` fallback in the span attributes.
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Content-Type'), 'application/json');
      },
    ),
  );
});

test('POST /v1/chat/completions: forwards the callers abort signal to the upstream fetch', async () => {
  await withAifoundryEnv(() => {
    let capturedSignal: AbortSignal | null | undefined;
    let fetchInvoked!: () => void;
    const fetchWasInvoked = new Promise<void>((resolve) => { fetchInvoked = resolve; });
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve; });

    return withFetch(
      (async (_url, init) => {
        capturedSignal = (init as RequestInit | undefined)?.signal;
        fetchInvoked();
        // Stay "in flight" until the test says to finish, so the abort below happens on a
        // signal backing a genuinely pending request, not one whose upstream already resolved.
        await upstreamGate;
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
      async () => {
        const app = createAzureProxy();
        const controller = new AbortController();
        const resPromise = app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
          signal: controller.signal,
        });
        await fetchWasInvoked;
        assert.ok(capturedSignal, 'upstream fetch must receive a signal');
        assert.equal(capturedSignal?.aborted, false, 'signal must not already be aborted while still in flight');
        controller.abort();
        assert.equal(
          capturedSignal?.aborted,
          true,
          'aborting the caller signal must abort the upstream fetch signal while the request is still in flight',
        );
        releaseUpstream();
        await resPromise;
      },
    );
  });
});

test('POST /v1/chat/completions: an aborted upstream fetch still ends the span instead of leaking it', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      (async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }) as typeof fetch,
      async () => {
        spanExporter.reset();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
        });
        // Hono's default error handler turns the uncaught rejection into a 500; what matters
        // here is that the span was still closed out with the exception recorded.
        assert.equal(res.status, 500);
        const spans = spanExporter.getFinishedSpans();
        assert.equal(spans.length, 1, 'span must be ended even when the upstream fetch throws');
        assert.equal(spans[0].name, 'azure.chat.completions');
        assert.ok(spans[0].events.some((e) => e.name === 'exception'), 'the AbortError must be recorded on the span');
      },
    ),
  );
});

test('POST /v1/chat/completions: a non-Error throw from the upstream fetch is still recorded on the span as an Error', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      (async () => {
        throw 'boom';
      }) as typeof fetch,
      async () => {
        spanExporter.reset();
        const app = createAzureProxy();
        // Hono's onError only intercepts `instanceof Error` (see compose.js), so a raw non-Error
        // throw re-escapes app.request() itself rather than becoming a 500 response — what we're
        // pinning here is that endSpanWithError still wraps and records it before that rethrow.
        await assert.rejects(
          async () =>
            app.request('/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
            }),
          (err) => err === 'boom',
        );
        const spans = spanExporter.getFinishedSpans();
        assert.equal(spans.length, 1, 'span must be ended even when the upstream fetch throws a non-Error value');
        const exceptionEvent = spans[0].events.find((e) => e.name === 'exception');
        assert.ok(exceptionEvent, 'the thrown value must be recorded on the span');
        assert.equal(
          exceptionEvent?.attributes?.['exception.message'],
          'boom',
          "a non-Error throw must be wrapped via String(err), same as webfetch.ts's withLookupError",
        );
        // recordException also accepts a plain string, which sets exception.message alone with no
        // exception.type — asserting the type too is what actually pins the Error-wrapping, since a
        // string passed straight through would otherwise satisfy the message assertion above as well.
        assert.equal(
          exceptionEvent?.attributes?.['exception.type'],
          'Error',
          'the non-Error value must be wrapped in an actual Error, not recorded as a bare string',
        );
      },
    ),
  );
});

test('POST /v1/chat/completions: an abort mid-body-read (buffered) still ends the span instead of leaking it', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      (async () => {
        const body = new ReadableStream<Uint8Array>({
          pull() {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
      async () => {
        spanExporter.reset();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
        });
        assert.equal(res.status, 500);
        const spans = spanExporter.getFinishedSpans();
        assert.equal(spans.length, 1, 'span must be ended even when reading the buffered body throws');
        assert.ok(spans[0].events.some((e) => e.name === 'exception'), 'the abort must be recorded on the span');
      },
    ),
  );
});

test('POST /v1/chat/completions: an abort mid-body-read (streaming) still ends the span instead of leaking it', async () => {
  await withAifoundryEnv(() =>
    withFetch(
      (async () => {
        const body = new ReadableStream<Uint8Array>({
          pull() {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as typeof fetch,
      async () => {
        spanExporter.reset();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', stream: true, messages: [] }),
        });
        assert.equal(res.status, 200); // the streamed Response itself is already returned by the time the read fails
        await assert.rejects(() => res.text(), /aborted/);
        const spans = spanExporter.getFinishedSpans();
        assert.equal(spans.length, 1, 'span must be ended even when reading the streamed body throws');
        assert.ok(spans[0].events.some((e) => e.name === 'exception'), 'the abort must be recorded on the span');
      },
    ),
  );
});

test('POST /v1/chat/completions: the consumer cancelling the streamed response still ends the span and cancels the upstream reader', async () => {
  let upstreamCancelReason: unknown;
  await withAifoundryEnv(() =>
    withFetch(
      (async () => {
        const body = new ReadableStream<Uint8Array>({
          pull() {
            // Never resolves on its own — nothing but the test's explicit cancel ends this stream,
            // mirroring a real in-flight response with no data yet (e.g. mid barge-in).
            return new Promise<never>(() => {});
          },
          cancel(reason) {
            upstreamCancelReason = reason;
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as typeof fetch,
      async () => {
        spanExporter.reset();
        const app = createAzureProxy();
        const res = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4', stream: true, messages: [] }),
        });
        assert.equal(res.status, 200);
        await res.body!.cancel('client disconnected');
        assert.equal(
          upstreamCancelReason,
          'client disconnected',
          'cancelling the returned stream must cancel the upstream reader, not leak the Azure connection',
        );
        const spans = spanExporter.getFinishedSpans();
        assert.equal(spans.length, 1, 'span must be ended when the consumer cancels the stream instead of leaking it');
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
