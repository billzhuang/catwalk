import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { buildBraveUrl, interpretBraveResponse, loadBraveKey, searchWeb, _resetBraveKeyCacheForTests, webSearch } from '../src/websearch.ts';
import { withEnvVars, withTempFile } from './test-helpers.ts';

/** Runs `fn` with the memoized Brave API key cleared before and after, so each test starts
 *  from loadBraveKey's file-parsing path and never leaks its memoized key into the next test. */
async function withFreshBraveKeyCache<T>(fn: () => T | Promise<T>): Promise<T> {
  _resetBraveKeyCacheForTests();
  try {
    return await fn();
  } finally {
    _resetBraveKeyCacheForTests();
  }
}

test('buildBraveUrl encodes the query and count', () => {
  const url = new URL(buildBraveUrl('best ramen in tokyo', 3));
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'best ramen in tokyo');
  assert.equal(url.searchParams.get('count'), '3');
});

test('interpretBraveResponse extracts hits and strips highlight tags/entities', () => {
  const body = JSON.stringify({
    web: {
      results: [
        { title: 'Tom &amp; <strong>Jerry</strong>', url: 'https://a.example', description: 'A <strong>cat</strong> &amp; mouse' },
        { title: 'Two', url: 'https://b.example', description: 'second' },
      ],
    },
  });
  const out = interpretBraveResponse(200, body);
  assert.equal(out.results?.length, 2);
  assert.deepEqual(out.results?.[0], { title: 'Tom & Jerry', url: 'https://a.example', snippet: 'A cat & mouse' });
});

test('interpretBraveResponse caps at five results', () => {
  const results = Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, url: `https://x${i}.example`, description: 'd' }));
  const out = interpretBraveResponse(200, JSON.stringify({ web: { results } }));
  assert.equal(out.results?.length, 5);
});

test('interpretBraveResponse drops hits without a URL', () => {
  const body = JSON.stringify({ web: { results: [{ title: 'no url', description: 'd' }, { title: 'ok', url: 'https://ok.example', description: 'd' }] } });
  const out = interpretBraveResponse(200, body);
  assert.equal(out.results?.length, 1);
  assert.equal(out.results?.[0].url, 'https://ok.example');
});

test('interpretBraveResponse returns empty results (not an error) when there are none', () => {
  assert.deepEqual(interpretBraveResponse(200, JSON.stringify({ web: { results: [] } })), { results: [] });
  assert.deepEqual(interpretBraveResponse(200, JSON.stringify({})), { results: [] });
});

test('interpretBraveResponse reports auth and rate-limit errors distinctly', () => {
  assert.match(interpretBraveResponse(401, '').error ?? '', /not authorized/);
  assert.match(interpretBraveResponse(403, '').error ?? '', /not authorized/);
  assert.match(interpretBraveResponse(429, '').error ?? '', /rate limit/);
  assert.match(interpretBraveResponse(500, '').error ?? '', /HTTP 500/);
});

test('interpretBraveResponse handles unparseable bodies gracefully', () => {
  assert.match(interpretBraveResponse(200, 'not json').error ?? '', /unreadable/);
});

test('interpretBraveResponse tolerates hits with a missing title/description', () => {
  const body = JSON.stringify({ web: { results: [{ url: 'https://a.example' }] } });
  const out = interpretBraveResponse(200, body);
  assert.deepEqual(out.results?.[0], { title: '', url: 'https://a.example', snippet: '' });
});

test('loadBraveKey returns undefined when unconfigured', async () =>
  withFreshBraveKeyCache(() =>
    withEnvVars(
      { BRAVE_API_KEY: undefined, BRAVE_ENV: join(tmpdir(), 'does-not-exist-brave.sh') },
      () => {
        assert.equal(loadBraveKey(), undefined);
      },
    ),
  ));

test('loadBraveKey reads a key alias from BRAVE_ENV, stripping export/quotes, and memoizes it', async () =>
  withFreshBraveKeyCache(() =>
    withTempFile('brave-test-', 'brave.sh', "# comment\nexport brave_key='secret123'\n", (file) =>
      withEnvVars({ BRAVE_API_KEY: undefined, BRAVE_ENV: file }, () => {
        assert.equal(loadBraveKey(), 'secret123');
        // Memoized: changing the config after the first successful read has no effect.
        writeFileSync(file, 'brave_key=different');
        assert.equal(loadBraveKey(), 'secret123');
      }),
    ),
  ));

test('loadBraveKey returns undefined when the config file exists but has no matching alias', async () =>
  // Distinct from the ENOENT case above: the try block here runs to completion without ever
  // throwing, so it falls through to `return undefined` past the catch rather than through it.
  withFreshBraveKeyCache(() =>
    withTempFile('brave-test-', 'brave.sh', '# just a comment\nsome_other_key=nope\n', (file) =>
      withEnvVars({ BRAVE_API_KEY: undefined, BRAVE_ENV: file }, () => {
        assert.equal(loadBraveKey(), undefined);
      }),
    ),
  ));

test('loadBraveKey skips an empty-valued alias and keeps scanning for a later one', async () =>
  withFreshBraveKeyCache(() =>
    withTempFile('brave-test-', 'brave.sh', 'apikey=\nbrave_key=fallback123\n', (file) =>
      withEnvVars({ BRAVE_API_KEY: undefined, BRAVE_ENV: file }, () => {
        assert.equal(loadBraveKey(), 'fallback123');
      }),
    ),
  ));

test('loadBraveKey falls back to ~/env/brave.sh when BRAVE_ENV is unset', async () =>
  withFreshBraveKeyCache(async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'brave-home-'));
    try {
      // Same HOME/USERPROFILE mock as config.test.ts's analogous AIFOUNDRY_ENV-unset test, so
      // the `process.env.BRAVE_ENV ?? '~/env/brave.sh'` fallback literal actually gets
      // evaluated instead of being shadowed by an explicit BRAVE_ENV path.
      await withEnvVars({ HOME: fakeHome, USERPROFILE: fakeHome, BRAVE_API_KEY: undefined, BRAVE_ENV: undefined }, () => {
        mkdirSync(join(fakeHome, 'env'), { recursive: true });
        writeFileSync(join(fakeHome, 'env', 'brave.sh'), 'apikey=fallback-home-key\n');
        assert.equal(loadBraveKey(), 'fallback-home-key');
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }));

test('searchWeb reports not configured when there is no Brave API key', async () =>
  withFreshBraveKeyCache(() =>
    withEnvVars(
      { BRAVE_API_KEY: undefined, BRAVE_ENV: join(tmpdir(), 'does-not-exist-brave.sh') },
      async () => {
        const result = await searchWeb('best ramen in tokyo');
        assert.match(result.error ?? '', /not configured/);
      },
    ),
  ));

test('searchWeb wires the Brave URL/headers and parses a successful response', async (t) =>
  withFreshBraveKeyCache(() =>
    withEnvVars({ BRAVE_API_KEY: 'test-key', BRAVE_ENV: undefined }, async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(
          JSON.stringify({ web: { results: [{ title: 'Ramen', url: 'https://a.example', description: 'desc' }] } }),
          { status: 200 },
        );
      });
      const result = await searchWeb('best ramen in tokyo');
      assert.deepEqual(result.results?.[0], { title: 'Ramen', url: 'https://a.example', snippet: 'desc' });
      assert.equal(new URL(capturedUrl ?? '').searchParams.get('q'), 'best ramen in tokyo');
      assert.equal(capturedHeaders?.['X-Subscription-Token'], 'test-key');
    }),
  ));

test('searchWeb reports "Web search failed" when the underlying fetch throws', async (t) =>
  withFreshBraveKeyCache(() =>
    withEnvVars({ BRAVE_API_KEY: 'test-key', BRAVE_ENV: undefined }, async () => {
      t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      });
      const result = await searchWeb('best ramen in tokyo');
      assert.match(result.error ?? '', /^Web search failed: /);
    }),
  ));

test('searchWeb reports the Brave error when fetch succeeds but Brave returns a non-200 status', async (t) =>
  withFreshBraveKeyCache(() =>
    withEnvVars({ BRAVE_API_KEY: 'test-key', BRAVE_ENV: undefined }, async () => {
      // Unlike the fetch-throws case above, this reaches interpretBraveResponse (and the
      // ok/count span attributes right after it) with `result.results` left undefined.
      t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
      const result = await searchWeb('best ramen in tokyo');
      assert.match(result.error ?? '', /not authorized/);
      assert.equal(result.results, undefined);
    }),
  ));

test('webSearch tool schema requires a query, and its run() delegates to searchWeb', async () =>
  withFreshBraveKeyCache(() =>
    withEnvVars({ BRAVE_API_KEY: 'test-key', BRAVE_ENV: undefined }, async () => {
      assert.throws(() => v.parse(webSearch.input, {}));
      const input = v.parse(webSearch.input, { query: 'best ramen in tokyo' });
      // An already-aborted signal makes fetch reject immediately, with no network call —
      // deterministic way to pin that run() forwards to searchWeb rather than doing its own thing.
      const result = await webSearch.run({ input, signal: AbortSignal.abort() });
      assert.match(result.error ?? '', /^Web search failed: /);
      assert.doesNotThrow(() => v.parse(webSearch.output, result));
    }),
  ));

test('webSearch.run() falls back to no signal when the flue runtime supplies none', async (t) =>
  withFreshBraveKeyCache(() =>
    withEnvVars({ BRAVE_API_KEY: 'test-key', BRAVE_ENV: undefined }, async () => {
      const sentinel = AbortSignal.abort();
      t.mock.method(AbortSignal, 'timeout', () => sentinel);
      let capturedSignal: AbortSignal | undefined;
      t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        throw new Error('stop after capturing the signal');
      });
      const input = v.parse(webSearch.input, { query: 'best ramen in tokyo' });
      await webSearch.run({ input, signal: undefined });
      // No caller signal -> searchWeb's own bounded default timeout signal, not undefined.
      assert.equal(capturedSignal, sentinel);
    }),
  ));
