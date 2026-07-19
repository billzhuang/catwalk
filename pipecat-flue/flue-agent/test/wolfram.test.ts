import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { buildWolframUrl, interpretWolframResponse, askWolfram } from '../src/wolfram.ts';
import { withEnvVars } from './test-helpers.ts';

test('buildWolframUrl encodes the query and appid as URL params', () => {
  const url = new URL(buildWolframUrl('15% of 80', 'ABC123'));
  assert.equal(url.origin + url.pathname, 'https://api.wolframalpha.com/v1/result');
  assert.equal(url.searchParams.get('i'), '15% of 80');
  assert.equal(url.searchParams.get('appid'), 'ABC123');
});

test('interpretWolframResponse returns the answer on 200 with a body', () => {
  assert.deepEqual(interpretWolframResponse(200, '160'), { answer: '160' });
});

test('interpretWolframResponse trims surrounding whitespace from the answer', () => {
  assert.deepEqual(interpretWolframResponse(200, '  42  \n'), { answer: '42' });
});

test('interpretWolframResponse reports a graceful error on 501 (not understood)', () => {
  const result = interpretWolframResponse(501, 'Wolfram|Alpha did not understand your input');
  assert.match(result.error ?? '', /could not interpret/);
});

test('interpretWolframResponse reports an error for other non-200 statuses', () => {
  const result = interpretWolframResponse(400, 'Appid missing');
  assert.match(result.error ?? '', /HTTP 400/);
});

test('interpretWolframResponse treats a 200 with an empty body as an error, not a blank answer', () => {
  const result = interpretWolframResponse(200, '   ');
  assert.equal(result.answer, undefined);
  assert.ok(result.error);
});

test('interpretWolframResponse falls back to a generic message on a 501 with no body', () => {
  const result = interpretWolframResponse(501, '   ');
  assert.match(result.error ?? '', /could not interpret that: no answer available/);
});

test('queryWolfram fails gracefully when WOLFRAM_APP_ID is not configured', async () => {
  await withEnvVars({ WOLFRAM_APP_ID: undefined }, async () => {
    const { queryWolfram } = await import('../src/wolfram.ts');
    const result = await queryWolfram('2+2');
    assert.match(result.error ?? '', /not configured/);
  });
});

test('queryWolfram reports a "Wolfram Alpha lookup failed" error when the underlying fetch throws', async () => {
  await withEnvVars({ WOLFRAM_APP_ID: 'test-app-id' }, async () => {
    const { queryWolfram } = await import('../src/wolfram.ts');
    // An already-aborted signal makes fetch reject immediately (AbortError), with no network
    // call — deterministic way to pin the catch-block's error-message shape.
    const result = await queryWolfram('2+2', AbortSignal.abort());
    assert.match(result.error ?? '', /^Wolfram Alpha lookup failed: /);
  });
});

test('askWolfram tool schema requires a query, and its run() delegates to queryWolfram', async () => {
  await withEnvVars({ WOLFRAM_APP_ID: 'test-app-id' }, async () => {
    assert.throws(() => v.parse(askWolfram.input, {}));
    const input = v.parse(askWolfram.input, { query: '2+2' });
    const result = await askWolfram.run({ input, signal: AbortSignal.abort() });
    assert.match(result.error ?? '', /^Wolfram Alpha lookup failed: /);
    assert.doesNotThrow(() => v.parse(askWolfram.output, result));
  });
});

test('askWolfram.run() falls back to no signal when the flue runtime supplies none', async (t) => {
  await withEnvVars({ WOLFRAM_APP_ID: 'test-app-id' }, async () => {
    const input = v.parse(askWolfram.input, { query: '2+2' });
    let capturedSignal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response('4');
    });
    const result = await askWolfram.run({ input, signal: undefined });
    assert.deepEqual(result, { answer: '4' });
    // No caller signal -> queryWolfram's own bounded default timeout signal, not undefined.
    assert.ok(capturedSignal);
  });
});

test('queryWolfram falls back to a bounded default timeout when the caller supplies no abort signal', async (t) => {
  await withEnvVars({ WOLFRAM_APP_ID: 'test-app-id' }, async () => {
    const { queryWolfram } = await import('../src/wolfram.ts');
    // Same technique webfetch.test.ts uses to pin resolveTimeoutSignal(): a distinct sentinel
    // AbortSignal stands in for AbortSignal.timeout()'s return value, so we can assert the fetch
    // actually received it instead of an unbounded (never-aborting) signal.
    const sentinel = AbortSignal.abort();
    const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => sentinel);
    let capturedSignal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      throw new Error('stop after capturing the signal');
    });
    await queryWolfram('2+2');
    assert.equal(timeoutMock.mock.callCount(), 1);
    assert.deepEqual(timeoutMock.mock.calls[0].arguments, [15_000]);
    assert.equal(capturedSignal, sentinel);
  });
});

test('queryWolfram maps a configured, successful fetch into a WolframResult', async (t) => {
  await withEnvVars({ WOLFRAM_APP_ID: 'test-app-id' }, async () => {
    const { queryWolfram } = await import('../src/wolfram.ts');
    let capturedUrl: string | undefined;
    t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
      capturedUrl = input.toString();
      return new Response('160');
    });
    const result = await queryWolfram('15% of 80');
    assert.deepEqual(result, { answer: '160' });
    assert.ok(capturedUrl, 'fetch should have been called');
    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.get('appid'), 'test-app-id');
    assert.equal(url.searchParams.get('i'), '15% of 80');
  });
});
