import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimeInZone, lookupTime } from '../src/time.ts';
import { withEmptyGeocodeStub } from './test-helpers.ts';

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

test('lookupTime reports "Could not find a place" when geocoding finds no match', async (t) => {
  const result = await withEmptyGeocodeStub(t, () => lookupTime('Nowhereland'));
  assert.equal(result.error, "Could not find a place called 'Nowhereland'.");
});
