import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWolframUrl, interpretWolframResponse } from '../src/wolfram.ts';
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
