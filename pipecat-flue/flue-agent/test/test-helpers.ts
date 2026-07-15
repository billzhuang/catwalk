import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
