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
} from '../src/azure-proxy.ts';

function fakeSpan() {
  const calls: Record<string, unknown>[] = [];
  return { calls, setAttributes: (attrs: Record<string, unknown>) => calls.push(attrs) };
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
  assert.equal(out.stream_options.include_usage, true);
});

test('usageFromSse: extracts usage from the final data chunk', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"delta":{"content":"!"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":1408}}}',
    'data: [DONE]',
  ].join('\n\n');
  const usage = usageFromSse(sse);
  assert.equal(usage.prompt_tokens, 1500);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 1408);
});

test('recordUsage + cacheRate accumulate correctly', () => {
  metrics.calls = 0; metrics.promptTokens = 0; metrics.cachedTokens = 0; metrics.completionTokens = 0;
  recordUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } });
  recordUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } });
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.promptTokens, 2000);
  assert.equal(metrics.cachedTokens, 900);
  assert.equal(cacheRate(), 0.45);
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
  metrics.calls = 0; metrics.promptTokens = 0; metrics.cachedTokens = 0; metrics.completionTokens = 0;
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
