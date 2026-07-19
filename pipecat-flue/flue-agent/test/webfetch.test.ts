import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { htmlToText, extractTitle, decodeEntities, isPrivateAddress, describeFetchError, fetchUrl, anyAddressPrivate, guardedLookup, webFetch, resolveTimeoutSignal, withLookupError } from '../src/webfetch.ts';

/** A minimal fetch Response stand-in: no `.body` stream, so fetchUrl's readBounded()
 *  takes the `r.text()` fallback path. Header lookups are case-insensitive like the real thing. */
function fakeResponse({ status = 200, headers = {}, body = '' }: { status?: number; headers?: Record<string, string>; body?: string }) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => body,
    body: undefined,
  };
}

/** A fetch Response stand-in with a real `.body` ReadableStream, so readBounded() takes its
 *  streaming path (the one enforcing MAX_BYTES) instead of the `.text()` fallback every other
 *  fake in this file uses. Tracks how many chunks the source was asked for and whether the
 *  reader was cancelled, so a test can assert readBounded() actually stopped reading early. */
function fakeStreamResponse(
  chunks: Uint8Array[],
  { status = 200, headers = {}, cancelThrows = false }: { status?: number; headers?: Record<string, string>; cancelThrows?: boolean } = {},
) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulls < chunks.length) {
        controller.enqueue(chunks[state.pulls]);
        state.pulls++;
      } else {
        controller.close();
      }
    },
    cancel() {
      state.cancelled = true;
      if (cancelThrows) throw new Error('stream already closed');
    },
  });
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
      text: async () => '',
      body: stream,
    },
    state,
  };
}

test('describeFetchError reports a plain "timed out" message for AbortSignal.timeout errors', () => {
  assert.equal(describeFetchError(new DOMException('The operation timed out.', 'TimeoutError')), 'the request timed out');
});

test('describeFetchError passes through other errors\' messages unchanged', () => {
  assert.equal(describeFetchError(new Error('fetch failed: ECONNREFUSED')), 'fetch failed: ECONNREFUSED');
});

test('resolveTimeoutSignal passes an explicit signal through unchanged', () => {
  const signal = AbortSignal.abort();
  assert.equal(resolveTimeoutSignal(signal), signal);
});

test('resolveTimeoutSignal falls back to a 15s AbortSignal.timeout() when none is given', (t) => {
  const sentinel = AbortSignal.abort(); // any distinct AbortSignal works as a spy return value
  const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => sentinel);
  const result = resolveTimeoutSignal(undefined);
  assert.equal(result, sentinel);
  assert.equal(timeoutMock.mock.callCount(), 1);
  assert.deepEqual(timeoutMock.mock.calls[0].arguments, [15_000]);
});

test('isPrivateAddress flags loopback, RFC1918, link-local, CGNAT, and unspecified', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress flags IPv6 loopback, link-local, unique-local, and IPv4-mapped forms', () => {
  for (const ip of [
    '::1', '::', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1',            // IPv4-mapped IPv6 hex form = 127.0.0.1
    'fe80::1', 'fe90::1', 'fea0::1', 'febf::1',  // full fe80::/10 link-local range
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('isPrivateAddress falls through to false for a string that is neither an IPv4 nor IPv6 address', () => {
  // node:net's isIP() returns 0 for these, so neither the `kind === 4` nor `kind === 6`
  // branch runs — only reachable in practice if a caller skips the isIP() guard every
  // real call site (guardHost, anyAddressPrivate) applies before calling this.
  for (const notAnIp of ['not-an-ip', '', 'example.com']) {
    assert.equal(isPrivateAddress(notAnIp), false, `${notAnIp} should fall through to false`);
  }
});

test('extractTitle pulls the page title and decodes entities', () => {
  assert.equal(extractTitle('<html><head><title>Tom &amp; Jerry</title></head></html>'), 'Tom & Jerry');
});

test('extractTitle returns undefined when there is no title', () => {
  assert.equal(extractTitle('<html><body>hi</body></html>'), undefined);
});

test('htmlToText strips script and style content entirely', () => {
  const html = '<p>Hello</p><script>alert(1)</script><style>.a{color:red}</style><p>World</p>';
  const text = htmlToText(html);
  assert.match(text, /Hello/);
  assert.match(text, /World/);
  assert.doesNotMatch(text, /alert/);
  assert.doesNotMatch(text, /color:red/);
});

test('htmlToText turns block boundaries into newlines and collapses whitespace', () => {
  const text = htmlToText('<h1>Title</h1><p>one</p><p>two</p>');
  assert.equal(text, 'Title\none\ntwo');
});

test('htmlToText decodes entities in body text', () => {
  assert.match(htmlToText('<p>5 &lt; 10 &amp; 20 &gt; 3</p>'), /5 < 10 & 20 > 3/);
});

test('htmlToText truncates to the requested length with an ellipsis', () => {
  const text = htmlToText('<p>' + 'a'.repeat(100) + '</p>', 10);
  assert.equal(text.length, 11); // 10 chars + the ellipsis
  assert.ok(text.endsWith('…'));
});

test('decodeEntities handles numeric and hex character references', () => {
  assert.equal(decodeEntities('&#65;&#x42;&#67;'), 'ABC');
});

test('decodeEntities does not double-decode already-escaped sequences', () => {
  // Page text "&lt;tag&gt;" is encoded as "&amp;lt;tag&amp;gt;" — must decode to "&lt;tag&gt;".
  assert.equal(decodeEntities('&amp;lt;tag&amp;gt;'), '&lt;tag&gt;');
});

test('decodeEntities leaves out-of-range numeric references intact instead of throwing', () => {
  assert.equal(decodeEntities('x &#9999999; y'), 'x &#9999999; y');
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;');
});

test('htmlToText does not throw on out-of-range numeric entities', () => {
  const text = htmlToText('<p>a &#9999999; b</p>');
  assert.match(text, /a/);
  assert.match(text, /b/);
});

test('htmlToText turns self-closing <br/> into a newline', () => {
  assert.equal(htmlToText('one<br/>two<br />three'), 'one\ntwo\nthree');
});

test('fetchUrl rejects a malformed URL without fetching', async () => {
  const result = await fetchUrl('not a url');
  assert.deepEqual(result, { error: "That doesn't look like a valid URL: not a url" });
});

test('fetchUrl rejects non-http(s) protocols', async () => {
  const result = await fetchUrl('ftp://example.com/file');
  assert.deepEqual(result, { error: 'Only http and https URLs can be fetched.' });
});

test('fetchUrl rejects requests to blocked hosts without ever calling fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called for a blocked host');
  });
  // localhost and metadata/metadata.google.internal (the GCP cloud-metadata SSRF target) are
  // explicit BLOCKED_HOSTS entries; foo.localhost hits the `.localhost` suffix rule instead.
  for (const host of ['localhost', 'metadata', 'metadata.google.internal', 'foo.localhost']) {
    const url = `http://${host}/`;
    const result = await fetchUrl(url);
    assert.deepEqual(result, { url, error: "Can't fetch that page: that host is not allowed." });
  }
});

test('fetchUrl rejects a literal private/internal IP host without ever calling fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called for a private IP host');
  });
  const loopback = await fetchUrl('http://127.0.0.1/');
  assert.deepEqual(loopback, {
    url: 'http://127.0.0.1/',
    error: "Can't fetch that page: that address is private or internal.",
  });
  const linkLocal = await fetchUrl('http://169.254.169.254/latest/meta-data/');
  assert.deepEqual(linkLocal, {
    url: 'http://169.254.169.254/latest/meta-data/',
    error: "Can't fetch that page: that address is private or internal.",
  });
});

test('fetchUrl rejects a bracketed IPv6 literal host without ever calling fetch', async (t) => {
  // The WHATWG URL parser keeps brackets in `.hostname` for IPv6 literals (e.g. "[::1]"), so
  // guardHost's bracket-stripping regex is what makes isIP/isPrivateAddress recognize it at all.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called for a private IPv6 host');
  });
  const result = await fetchUrl('http://[::1]/');
  assert.deepEqual(result, {
    url: 'http://[::1]/',
    error: "Can't fetch that page: that address is private or internal.",
  });
});

test('fetchUrl returns title + text for a successful HTML fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({
    headers: { 'content-type': 'text/html' },
    body: '<html><head><title>Hi</title></head><body><p>Hello world</p></body></html>',
  }));
  const result = await fetchUrl('https://example.com/page');
  assert.equal(result.url, 'https://example.com/page');
  assert.equal(result.title, 'Hi');
  assert.match(result.text ?? '', /Hello world/);
  assert.equal(result.error, undefined);
});

test('fetchUrl returns raw text for a successful non-HTML fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({
    headers: { 'content-type': 'text/plain' },
    body: 'plain body text',
  }));
  const result = await fetchUrl('https://example.com/plain.txt');
  assert.equal(result.text, 'plain body text');
  assert.equal(result.title, undefined);
});

test('fetchUrl stops reading and cancels the stream once MAX_BYTES is exceeded', async (t) => {
  const chunk = new Uint8Array(500_000).fill(97); // 500,000 'a' bytes per chunk
  const chunks = Array.from({ length: 10 }, () => chunk); // 5,000,000 bytes available; cap is 2,000,000
  const { response, state } = fakeStreamResponse(chunks, { headers: { 'content-type': 'text/plain' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  const result = await fetchUrl('https://example.com/huge');
  // 4 chunks * 500,000 = 2,000,000 hits MAX_BYTES exactly, so the loop should stop there rather
  // than reading all 10 available chunks. ReadableStream prefetches one chunk ahead of
  // consumption, so 5 pulls (not just 4) is the real stopping point — either way, proves the
  // cap is enforced rather than every chunk being drained.
  assert.ok(state.pulls <= 5, `expected reading to stop well short of all 10 chunks, got ${state.pulls} pulls`);
  assert.equal(state.cancelled, true);
  assert.equal(result.text?.length, 6000); // then further capped to MAX_CHARS like any other body
});

test('fetchUrl ignores a reader.cancel() failure once MAX_BYTES is exceeded', async (t) => {
  const chunk = new Uint8Array(500_000).fill(97); // 500,000 'a' bytes per chunk
  const chunks = Array.from({ length: 10 }, () => chunk); // 5,000,000 bytes available; cap is 2,000,000
  const { response, state } = fakeStreamResponse(chunks, { headers: { 'content-type': 'text/plain' }, cancelThrows: true });
  t.mock.method(globalThis, 'fetch', async () => response);
  // Cancelling an already-closed/errored reader can reject; readBounded must swallow that
  // rather than let it propagate past the truncated body it already read.
  const result = await fetchUrl('https://example.com/huge');
  assert.equal(state.cancelled, true);
  assert.equal(result.text?.length, 6000);
});

test('fetchUrl reassembles a multi-byte UTF-8 character split across stream chunks', async (t) => {
  const bytes = new TextEncoder().encode('hié!'); // 'é' = 0xC3 0xA9, a 2-byte UTF-8 sequence
  const { response } = fakeStreamResponse(
    [bytes.slice(0, 3), bytes.slice(3)], // splits the 'é' sequence across the chunk boundary
    { headers: { 'content-type': 'text/plain' } },
  );
  t.mock.method(globalThis, 'fetch', async () => response);
  const result = await fetchUrl('https://example.com/utf8');
  assert.equal(result.text, 'hié!');
});

test('fetchUrl follows redirects across hops before returning the final page', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    calls++;
    const u = input.toString();
    if (u === 'https://example.com/a') return fakeResponse({ status: 302, headers: { location: 'https://example.com/b' } });
    if (u === 'https://example.com/b') return fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'final page text' });
    throw new Error(`unexpected url ${u}`);
  });
  const result = await fetchUrl('https://example.com/a');
  assert.equal(calls, 2);
  assert.equal(result.url, 'https://example.com/b');
  assert.equal(result.text, 'final page text');
});

test('fetchUrl gives up after too many redirects', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ status: 302, headers: { location: 'https://example.com/next' } }));
  const result = await fetchUrl('https://example.com/start');
  assert.deepEqual(result, { url: 'https://example.com/next', error: 'That page redirected too many times.' });
});

test('fetchUrl reports an invalid redirect target', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ status: 302, headers: { location: 'http://' } }));
  const result = await fetchUrl('https://example.com/start');
  assert.deepEqual(result, { url: 'https://example.com/start', error: 'That page redirected to an invalid URL.' });
});

test('fetchUrl reports non-OK HTTP status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ status: 404, body: 'not found' }));
  const result = await fetchUrl('https://example.com/missing');
  assert.deepEqual(result, { url: 'https://example.com/missing', error: 'The page returned HTTP 404.' });
});

test('fetchUrl reports when a page has no readable text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: '   ' }));
  const result = await fetchUrl('https://example.com/blank');
  assert.deepEqual(result, { url: 'https://example.com/blank', title: undefined, error: 'That page had no readable text.' });
});

test('anyAddressPrivate allows a single public resolved address', () => {
  assert.equal(anyAddressPrivate('8.8.8.8'), false);
});

test('anyAddressPrivate flags a single private resolved address', () => {
  assert.equal(anyAddressPrivate('127.0.0.1'), true);
});

test('anyAddressPrivate flags a private address anywhere in an `all: true` result list', () => {
  assert.equal(anyAddressPrivate([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), true);
});

test('anyAddressPrivate allows an all-public `all: true` result list', () => {
  assert.equal(anyAddressPrivate([{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]), false);
});

test('guardedLookup passes a lookup error straight through unchanged', (t, done) => {
  const boom = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  const stubLookup = (_h: string, _o: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void) => cb(boom, '', undefined);
  guardedLookup('nope.invalid', {}, (err, address, family) => {
    assert.equal(err, boom);
    assert.equal(address, '');
    assert.equal(family, undefined);
    done();
  }, stubLookup as never);
});

test('guardedLookup rejects a resolved private address', (t, done) => {
  const stubLookup = (_h: string, _o: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void) => cb(null, '127.0.0.1', 4);
  guardedLookup('internal.example', {}, (err, address, family) => {
    assert.equal(err?.message, 'host resolves to a private or internal address');
    assert.equal(address, '127.0.0.1'); // resolved address still surfaced, just not connected to
    assert.equal(family, 4);
    done();
  }, stubLookup as never);
});

test('guardedLookup rejects when any address in an `all: true` result is private', (t, done) => {
  const list = [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
  const stubLookup = (_h: string, _o: unknown, cb: (err: NodeJS.ErrnoException | null, address: typeof list) => void) => cb(null, list);
  guardedLookup('mixed.example', { all: true }, (err, address) => {
    assert.equal(err?.message, 'host resolves to a private or internal address');
    assert.deepEqual(address, list); // resolved list still surfaced, just not connected to
    done();
  }, stubLookup as never);
});

test('guardedLookup passes through a resolved public address unchanged', (t, done) => {
  const stubLookup = (_h: string, _o: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void) => cb(null, '8.8.8.8', 4);
  guardedLookup('example.com', {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
    done();
  }, stubLookup as never);
});

test('fetchUrl wraps a thrown fetch error into a plain message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fetch failed: ECONNREFUSED'); });
  const result = await fetchUrl('https://example.com/down');
  assert.deepEqual(result, { url: 'https://example.com/down', error: 'Could not fetch that page: fetch failed: ECONNREFUSED.' });
});

test('webFetch tool schema requires a url, and its run() delegates to fetchUrl', async () => {
  assert.throws(() => v.parse(webFetch.input, {}));
  const input = v.parse(webFetch.input, { url: 'https://example.com' });
  // An already-aborted signal makes fetch reject immediately, with no network call —
  // deterministic way to pin that run() forwards to fetchUrl rather than doing its own thing.
  const result = await webFetch.run({ input, signal: AbortSignal.abort() });
  assert.match(result.error ?? '', /^Could not fetch that page: /);
  assert.doesNotThrow(() => v.parse(webFetch.output, result));
});

test('webFetch.run() falls back to no signal when the flue runtime supplies none', async (t) => {
  const sentinel = AbortSignal.abort();
  t.mock.method(AbortSignal, 'timeout', () => sentinel);
  let capturedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: URL | string, init?: RequestInit) => {
    capturedSignal = init?.signal as AbortSignal | undefined;
    throw new Error('stop after capturing the signal');
  });
  const input = v.parse(webFetch.input, { url: 'https://example.com' });
  await webFetch.run({ input, signal: undefined });
  // No caller signal -> fetchUrl's own bounded default timeout signal, not undefined.
  assert.equal(capturedSignal, sentinel);
});

test('withLookupError reports "the request timed out" for a timeout, same wording as webfetch/websearch, not the raw DOMException message', async () => {
  const result = await withLookupError<{ error?: string }>('Weather lookup', async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  assert.equal(result.error, 'Weather lookup failed: the request timed out');
});

test('withLookupError falls back to String(e) for a non-Error throw', async () => {
  const result = await withLookupError<{ error?: string }>('Weather lookup', async () => {
    throw 'boom';
  });
  assert.equal(result.error, 'Weather lookup failed: boom');
});
