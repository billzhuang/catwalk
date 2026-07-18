import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { formatTimeInZone, lookupTime, getTime } from '../src/time.ts';
import { withEmptyGeocodeStub, withGeocodeStub } from './test-helpers.ts';

// 2024-01-15T12:00:00Z is a Monday.
const NOON_UTC_MONDAY = new Date('2024-01-15T12:00:00Z');

test('formatTimeInZone renders the local weekday and 12-hour clock for a zone behind UTC', () => {
  const out = formatTimeInZone('America/New_York', NOON_UTC_MONDAY); // UTC-5 -> 07:00
  assert.match(out, /Monday/);
  assert.match(out, /7:00\s*AM/);
});

test('formatTimeInZone renders the local weekday and 12-hour clock for a zone ahead of UTC', () => {
  const out = formatTimeInZone('Asia/Tokyo', NOON_UTC_MONDAY); // UTC+9 -> 21:00
  assert.match(out, /Monday/);
  assert.match(out, /9:00\s*PM/);
});

test('formatTimeInZone can cross into the next day', () => {
  const out = formatTimeInZone('Asia/Tokyo', new Date('2024-01-15T20:00:00Z')); // UTC+9 -> Tue 05:00
  assert.match(out, /Tuesday/);
  assert.match(out, /5:00\s*AM/);
});

test('lookupTime reports a "Time lookup failed" error when the underlying fetch throws', async () => {
  // An already-aborted signal makes fetch reject immediately (AbortError), with no network
  // call — deterministic way to pin the catch-block's error-message shape.
  const result = await lookupTime('Tokyo', AbortSignal.abort());
  assert.match(result.error ?? '', /^Time lookup failed: /);
});

test('lookupTime falls back to a bounded default timeout when the caller supplies no abort signal', async (t) => {
  // Same technique webfetch.test.ts uses to pin resolveTimeoutSignal(): a distinct sentinel
  // AbortSignal stands in for AbortSignal.timeout()'s return value, so we can assert the fetch
  // actually received it instead of an unbounded (never-aborting) signal. lookupTime shares
  // weather.ts's geocodePlace()/getJson(), so this pins the same fix from that side too.
  const sentinel = AbortSignal.abort();
  const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => sentinel);
  let capturedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
    capturedSignal = init?.signal as AbortSignal | undefined;
    throw new Error('stop after capturing the signal');
  });
  await lookupTime('Tokyo');
  assert.equal(timeoutMock.mock.callCount(), 1);
  assert.deepEqual(timeoutMock.mock.calls[0].arguments, [15_000]);
  assert.equal(capturedSignal, sentinel);
});

test('lookupTime reports "Time lookup failed: HTTP <status>" when geocoding responds with a non-2xx status', async (t) => {
  // lookupTime shares weather.ts's geocodePlace()/getJson(), so this pins the same HTTP-error
  // branch as weather.test.ts's equivalent case, from the time.ts side.
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  const result = await lookupTime('Tokyo');
  assert.equal(result.error, 'Time lookup failed: HTTP 500');
});

test('lookupTime reports "Could not find a place" when geocoding finds no match', async (t) => {
  const result = await withEmptyGeocodeStub(t, () => lookupTime('Nowhereland'));
  assert.equal(result.error, "Could not find a place called 'Nowhereland'.");
});

test('lookupTime reports "No timezone information" when the matched place has none', async (t) => {
  const result = await withGeocodeStub(
    t,
    { results: [{ name: 'Null Island', latitude: 0, longitude: 0 }] },
    () => lookupTime('Null Island'),
  );
  assert.equal(result.error, "No timezone information for 'Null Island'.");
});

test('lookupTime maps a successful geocode match into a TimeResult', async (t) => {
  const result = await withGeocodeStub(
    t,
    { results: [{ name: 'Tokyo', country: 'Japan', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' }] },
    () => lookupTime('Tokyo'),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.location, 'Tokyo, Japan');
  assert.equal(result.timezone, 'Asia/Tokyo');
  assert.equal(result.time, formatTimeInZone('Asia/Tokyo', new Date()));
});

test('getTime tool schema requires a city, and its run() delegates to lookupTime', async () => {
  assert.throws(() => v.parse(getTime.input, {}));
  const input = v.parse(getTime.input, { city: 'Tokyo' });
  // An already-aborted signal makes fetch reject immediately, with no network call —
  // deterministic way to pin that run() forwards to lookupTime rather than doing its own thing.
  const result = await getTime.run({ input, signal: AbortSignal.abort() });
  assert.match(result.error ?? '', /^Time lookup failed: /);
  assert.doesNotThrow(() => v.parse(getTime.output, result));
});
