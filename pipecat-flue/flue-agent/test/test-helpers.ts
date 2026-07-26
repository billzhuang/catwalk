import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/**
 * Sets each env var for the duration of `fn`, restoring the prior value (or
 * deleting it, if it wasn't set) afterward. Pass `undefined` for a var that
 * should be deleted for the duration of `fn`. `fn` may be sync or async — its
 * result is awaited before vars are restored, so an async `fn` doesn't see its
 * env vars restored out from under it mid-flight.
 */
export async function withEnvVars<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Writes `contents` to a fresh temp-dir file named `filename` for the duration of `fn` (sync or
 *  async — see withEnvVars), removing the temp dir once `fn`'s result settles. */
export async function withTempFile<T>(
  prefix: string,
  filename: string,
  contents: string,
  fn: (path: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, filename);
  writeFileSync(file, contents);
  try {
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Points HOME/USERPROFILE (plus any `extraEnv`) at a fresh temp directory containing
 *  `env/<filename>` with `contents`, for the duration of `fn` (sync or async — see
 *  withEnvVars), removing the temp directory once `fn`'s result settles. Both HOME and
 *  USERPROFILE are set because os.homedir() reads USERPROFILE on Windows and HOME on POSIX,
 *  so a test using this stays platform-independent. Shared by config.test.ts's and
 *  websearch.test.ts's "~/env/<file> when the env var is unset" fallback tests, mirroring
 *  conftest.py's write_aifoundry_env() on the Python side. */
export async function withFakeHomeEnvFile<T>(
  prefix: string,
  filename: string,
  contents: string,
  extraEnv: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await withEnvVars({ HOME: fakeHome, USERPROFILE: fakeHome, ...extraEnv }, () => {
      mkdirSync(join(fakeHome, 'env'), { recursive: true });
      writeFileSync(join(fakeHome, 'env', filename), contents);
      return fn();
    });
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

/** Stubs globalThis.fetch (via `t.mock`) to return an empty Open-Meteo geocoding result — the
 *  "no such place" case that weather.ts's/time.ts's shared geocodePlace() sees as a no-match —
 *  for the duration of `fn` (sync or async), restoring the original fetch afterward. Shared by
 *  weather.test.ts and time.test.ts so each doesn't re-derive the same stub-and-restore dance. */
export async function withEmptyGeocodeStub<T>(t: TestContext, fn: () => T | Promise<T>): Promise<T> {
  return withGeocodeStub(t, { results: [] }, fn);
}

/** Stubs globalThis.fetch (via `t.mock`) to return the given Open-Meteo geocoding response body
 *  for the duration of `fn` (sync or async), restoring the original fetch afterward. General form
 *  of withEmptyGeocodeStub() — use this when a test needs a matched place rather than a no-match. */
export async function withGeocodeStub<T>(
  t: TestContext,
  geocodeResponse: unknown,
  fn: () => T | Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(geocodeResponse)));
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Mocks AbortSignal.timeout() (via t.mock) to return a distinct sentinel signal, and stubs
 *  globalThis.fetch to capture the signal it received in `init.signal` before immediately
 *  throwing — the technique every "falls back to a bounded default timeout" test uses to pin
 *  resolveTimeoutSignal()'s effect deterministically, with no real network call. Call the
 *  fetch-driving code under test after this, then read `getSignal()` (and, for tests that also
 *  assert call count/arguments, `timeoutMock` itself). Shared by weather/time/wolfram/websearch/
 *  webfetch.test.ts so each doesn't re-derive the same mock-and-capture setup. */
export function withCapturedTimeoutSignal(t: TestContext) {
  const sentinel = AbortSignal.abort();
  const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => sentinel);
  let capturedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
    capturedSignal = init?.signal as AbortSignal | undefined;
    throw new Error('stop after capturing the signal');
  });
  return { sentinel, timeoutMock, getSignal: () => capturedSignal };
}
