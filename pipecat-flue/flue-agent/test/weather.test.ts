import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { describeCode, lookupWeather, placeLabel, WMO, getWeather } from '../src/weather.ts';
import { withEmptyGeocodeStub } from './test-helpers.ts';

test('describeCode maps known WMO codes', () => {
  assert.equal(describeCode(0), 'clear sky');
  assert.equal(describeCode(61), 'slight rain');
  assert.equal(describeCode(95), 'thunderstorm');
});

test('describeCode maps the freezing-drizzle codes (56/57), not just drizzle (51/53/55) and freezing rain (66/67)', () => {
  // Open-Meteo's WMO table runs 51/53/55 drizzle, then 56/57 freezing drizzle, then 61/63/65
  // rain — 56/57 previously fell through to describeCode's `code ${code}` fallback, so a real
  // freezing-drizzle report would have come out as "it's code 56" instead of a natural phrase.
  assert.equal(describeCode(56), 'light freezing drizzle');
  assert.equal(describeCode(57), 'dense freezing drizzle');
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

test('lookupWeather falls back to a bounded default timeout when the caller supplies no abort signal', async (t) => {
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
  await lookupWeather('Tokyo');
  assert.equal(timeoutMock.mock.callCount(), 1);
  assert.deepEqual(timeoutMock.mock.calls[0].arguments, [15_000]);
  assert.equal(capturedSignal, sentinel);
});

test('lookupWeather reports "Could not find a place" when geocoding finds no match', async (t) => {
  const result = await withEmptyGeocodeStub(t, () => lookupWeather('Nowhereland'));
  assert.equal(result.error, "Could not find a place called 'Nowhereland'.");
});

test('lookupWeather reports "Weather lookup failed: HTTP <status>" when geocoding responds with a non-2xx status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  const result = await lookupWeather('Tokyo');
  assert.equal(result.error, 'Weather lookup failed: HTTP 500');
});

test('lookupWeather reports "Weather lookup failed: HTTP <status>" when the forecast call responds with a non-2xx status', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = input.toString();
    if (url.includes('geocoding-api.')) {
      return new Response(JSON.stringify({ results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35 }] }));
    }
    return new Response('', { status: 503 });
  });
  const result = await lookupWeather('Paris');
  assert.equal(result.error, 'Weather lookup failed: HTTP 503');
});

test('lookupWeather maps a successful geocode + forecast into a WeatherResult', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    const url = input.toString();
    if (url.includes('geocoding-api.')) {
      return new Response(
        JSON.stringify({ results: [{ name: 'Paris', admin1: 'Ile-de-France', country: 'France', latitude: 48.85, longitude: 2.35 }] }),
      );
    }
    return new Response(
      JSON.stringify({ current: { temperature_2m: 18, apparent_temperature: 16, relative_humidity_2m: 60, wind_speed_10m: 12, weather_code: 2 } }),
    );
  });
  const result = await lookupWeather('Paris');
  assert.deepEqual(result, {
    location: 'Paris, Ile-de-France, France',
    temperature_c: 18,
    feels_like_c: 16,
    humidity_pct: 60,
    wind_kmh: 12,
    conditions: 'partly cloudy',
  });
});

test('placeLabel joins name, admin1, and country', () => {
  assert.equal(
    placeLabel({ name: 'Paris', admin1: 'Ile-de-France', country: 'France', latitude: 0, longitude: 0 }),
    'Paris, Ile-de-France, France',
  );
});

test('placeLabel omits missing admin1/country rather than leaving empty segments', () => {
  assert.equal(placeLabel({ name: 'Reykjavik', latitude: 0, longitude: 0 }), 'Reykjavik');
});

test('getWeather tool schema requires a city, and its run() delegates to lookupWeather', async () => {
  assert.throws(() => v.parse(getWeather.input, {}));
  const input = v.parse(getWeather.input, { city: 'Tokyo' });
  // An already-aborted signal makes fetch reject immediately, with no network call —
  // deterministic way to pin that run() forwards to lookupWeather rather than doing its own thing.
  const result = await getWeather.run({ input, signal: AbortSignal.abort() });
  assert.match(result.error ?? '', /^Weather lookup failed: /);
  assert.doesNotThrow(() => v.parse(getWeather.output, result));
});

test('getWeather.run() falls back to no signal when the flue runtime supplies none', async (t) => {
  const sentinel = AbortSignal.abort();
  t.mock.method(AbortSignal, 'timeout', () => sentinel);
  let capturedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
    capturedSignal = init?.signal as AbortSignal | undefined;
    throw new Error('stop after capturing the signal');
  });
  const input = v.parse(getWeather.input, { city: 'Tokyo' });
  await getWeather.run({ input, signal: undefined });
  // No caller signal -> lookupWeather's own bounded default timeout signal, not undefined.
  assert.equal(capturedSignal, sentinel);
});
