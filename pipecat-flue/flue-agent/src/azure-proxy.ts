import { Hono } from 'hono';
import type { Span } from '@opentelemetry/api';
import { chatBlock } from './config.ts';
import { tracer, recordSpanException } from './telemetry.ts';

/**
 * In-process proxy that flue's `azure` provider points at. It exists so we can:
 *   1. inject the Azure `api-key` header (keeps the key out of flue config + repo),
 *   2. normalize gpt-5 request quirks (max_tokens -> max_completion_tokens, drop
 *      sampling params reasoning models reject),
 *   3. measure the prompt-cache hit rate from usage.prompt_tokens_details.cached_tokens.
 *
 * flue -> http://127.0.0.1:<port>/az/v1/chat/completions -> Azure.
 */

export interface CacheMetrics {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export const metrics: CacheMetrics = { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };

export function cacheRate(m: CacheMetrics = metrics): number {
  return m.promptTokens === 0 ? 0 : m.cachedTokens / m.promptTokens;
}

/** Shape of the `usage` object OpenAI-compatible chat/completions responses carry. */
export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Normalize a usage object's fields to plain numbers, defaulting missing ones to 0. Shared by
 *  applyUsageToMetrics and applyUsageToSpan (via recordAndAnnotateUsage) so the two never drift
 *  on what counts as a usage number. */
function normalizeUsage(usage: ChatCompletionUsage) {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function applyUsageToMetrics(u: ReturnType<typeof normalizeUsage>): void {
  metrics.calls += 1;
  metrics.promptTokens += u.promptTokens;
  metrics.completionTokens += u.completionTokens;
  metrics.cachedTokens += u.cachedTokens;
}

function applyUsageToSpan(span: Span, u: ReturnType<typeof normalizeUsage>): void {
  span.setAttributes({
    'llm.usage.prompt_tokens': u.promptTokens,
    'llm.usage.completion_tokens': u.completionTokens,
    'llm.usage.cached_tokens': u.cachedTokens,
  });
}

/** Update aggregate cache-rate metrics and the request span together, once usage is known.
 *  Called from both the buffered-JSON and end-of-stream branches below. */
export function recordAndAnnotateUsage(span: Span, usage: ChatCompletionUsage | null | undefined): void {
  if (!usage) return;
  const u = normalizeUsage(usage);
  applyUsageToMetrics(u);
  applyUsageToSpan(span, u);
}

const GPT5 = /^gpt-5/i;

/** Shape of an OpenAI-compatible chat/completions request body; carries whatever
 *  extra fields the caller sent through untouched (e.g. `messages`). */
export interface ChatCompletionBody {
  model?: string;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage?: boolean; [key: string]: unknown } | null;
  [key: string]: unknown;
}

/**
 * Rewrite a chat/completions body so gpt-5.x accepts it. Pure + unit-tested.
 * - max_tokens -> max_completion_tokens (gpt-5 rejects max_tokens)
 * - drop temperature/top_p/penalties/logprobs (unsupported by gpt-5 reasoning models)
 * - when streaming, ask for a usage chunk so we can measure caching
 */
export function normalizeBody(body: ChatCompletionBody): ChatCompletionBody {
  const b = { ...body };
  if (typeof b.model === 'string' && GPT5.test(b.model)) {
    if (b.max_tokens != null && b.max_completion_tokens == null) {
      b.max_completion_tokens = b.max_tokens;
    }
    delete b.max_tokens;
    for (const k of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs']) {
      delete b[k];
    }
  }
  if (b.stream) {
    b.stream_options = { ...(b.stream_options ?? {}), include_usage: true };
  }
  return b;
}

/** Extract a `usage` object from a buffered SSE stream (OpenAI puts it in the final data chunk). */
export function usageFromSse(text: string): ChatCompletionUsage | null {
  let usage: ChatCompletionUsage | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.usage) usage = obj.usage;
    } catch {
      /* partial line — ignore */
    }
  }
  return usage;
}

/** Records `err` on `span` and ends it — shared by every place a caller abort (or any other
 *  failure) can interrupt an in-flight Azure request after the span was started. */
function endSpanWithError(span: Span, err: unknown): void {
  recordSpanException(span, err);
  span.end();
}

/** Buffers the whole upstream body, extracts `usage` if present, and returns it as-is. */
async function respondBuffered(span: Span, upstream: Response, ctype: string): Promise<Response> {
  let text: string;
  try {
    text = await upstream.text();
  } catch (err) {
    // The caller's abort signal also governs body consumption, not just the initial fetch — a
    // cancellation while this read is in flight throws here just as easily.
    endSpanWithError(span, err);
    throw err;
  }
  try {
    const usage = JSON.parse(text).usage;
    recordAndAnnotateUsage(span, usage);
  } catch {
    /* non-JSON error body */
  }
  span.end();
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': ctype || 'application/json' } });
}

/** Tees the upstream SSE body to the caller while buffering it to capture the usage chunk. */
function respondStreaming(span: Span, upstream: Response): Response {
  const full: string[] = [];
  const decoder = new TextDecoder();
  const reader = upstream.body!.getReader();
  // pull()'s `done` branch and cancel() below can otherwise both end the span (a consumer
  // cancel racing an in-flight read that resolves done) — guard so it only happens once.
  let ended = false;
  const endOnce = (fn: () => void) => {
    if (ended) return;
    ended = true;
    fn();
  };
  const stream = new ReadableStream({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        // Same abort-mid-read hazard as respondBuffered above, but for the streaming path.
        endOnce(() => endSpanWithError(span, err));
        controller.error(err);
        return;
      }
      const { done, value } = result;
      if (done) {
        const usage = usageFromSse(full.join(''));
        recordAndAnnotateUsage(span, usage);
        endOnce(() => span.end());
        controller.close();
        return;
      }
      full.push(decoder.decode(value, { stream: true }));
      controller.enqueue(value);
    },
    // If the *consumer* of this stream cancels (client disconnect, barge-in aborting the caller's
    // request) without an in-flight reader.read() ever throwing, the platform just stops calling
    // pull() again — it never calls cleanup on `reader` on its own. Without this handler, the
    // upstream Azure connection and this span both leak silently.
    cancel(reason) {
      endOnce(() => span.end());
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: upstream.status,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

export function createAzureProxy(): Hono {
  const app = new Hono();

  // Some OpenAI clients probe /models; return a minimal catalog so they don't error.
  app.get('/v1/models', (c) =>
    c.json({ object: 'list', data: [{ id: 'gpt-5.4', object: 'model', owned_by: 'azure' }] }),
  );

  app.post('/v1/chat/completions', async (c) => {
    const { apikey, endpoint } = chatBlock();
    const incoming = await c.req.json();
    const body = normalizeBody(incoming);
    // Spans the whole request, including the streaming tail (span ends when usage lands).
    const span = tracer.startSpan('azure.chat.completions', {
      attributes: { 'llm.model': String(incoming.model ?? ''), 'llm.stream': Boolean(body.stream) },
    });
    let upstream: Response;
    try {
      upstream = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'api-key': apikey, 'Content-Type': 'application/json', 'User-Agent': 'voice-chain-flue' },
        body: JSON.stringify(body),
        // Forward the caller's cancellation (e.g. barge-in's /agents/weather/:id/abort) to the
        // upstream Azure call, so an aborted turn actually stops token generation instead of
        // just being ignored by the caller while Azure keeps billing/generating in the background.
        signal: c.req.raw.signal,
      });
    } catch (err) {
      // An abort throws here (fetch rejects with AbortError) — without this catch the span
      // would never reach span.end() below, leaking it.
      endSpanWithError(span, err);
      throw err;
    }

    const ctype = upstream.headers.get('Content-Type') ?? '';
    if (!body.stream || !ctype.includes('text/event-stream')) {
      return respondBuffered(span, upstream, ctype);
    }
    return respondStreaming(span, upstream);
  });

  return app;
}
