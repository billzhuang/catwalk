import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCode, lookupWeather, WMO } from '../src/weather.ts';

test('describeCode maps known WMO codes', () => {
  assert.equal(describeCode(0), 'clear sky');
  assert.equal(describeCode(61), 'slight rain');
  assert.equal(describeCode(95), 'thunderstorm');
});

test('describeCode handles unknown / missing codes', () => {
  assert.equal(describeCode(undefined), 'unknown');
  assert.equal(describeCode(4242), 'code 4242');
});

test('WMO table covers the common precipitation codes', () => {
  for (const code of [0, 1, 2, 3, 45, 51, 61, 63, 65, 71, 80, 95]) {
    assert.ok(WMO[code], `missing description for code ${code}`);
  }
});

test('lookupWeather reports a "Weather lookup failed" error when the underlying fetch throws', async () => {
  // An already-aborted signal makes fetch reject immediately (AbortError), with no network
  // call — deterministic way to pin the catch-block's error-message shape.
  const result = await lookupWeather('Tokyo', AbortSignal.abort());
  assert.match(result.error ?? '', /^Weather lookup failed: /);
});

test('lookupWeather reports "Could not find a place" when geocoding finds no match', async (t) => {
  // Stub global fetch so geocodePlace() sees an empty results array — no network call.
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [] })));
  try {
    const result = await lookupWeather('Nowhereland');
    assert.equal(result.error, "Could not find a place called 'Nowhereland'.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('config: section-aware parse keeps both blocks separate', async () => {
  // loadBlocks parses the real ~/env file; assert the two resources don't collide.
  const { loadBlocks, pickBlock } = await import('../src/config.ts');
  const blocks = loadBlocks();
  assert.ok(blocks.length >= 1, 'at least one credential block');
  if (blocks.length >= 2) {
    const eu2 = pickBlock(blocks, ['us-2']);
    const eu1 = pickBlock(blocks, ['us-1'], blocks.length - 1);
    assert.notEqual(eu2.endpoint, eu1.endpoint, 'east-us-2 and east-us-1 endpoints differ');
  }
});
