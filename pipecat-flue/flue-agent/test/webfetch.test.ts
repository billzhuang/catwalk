import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { htmlToText, extractTitle, isPrivateAddress, fetchUrl, anyAddressPrivate, guardedLookup, webFetch } from '../src/webfetch.ts';
import { withCapturedTimeoutSignal } from './test-helpers.ts';

// SimpleSpanProcessor exports synchronously on span.end(), so spans are visible immediately —
// same setup as telemetry.test.ts/azure-proxy.test.ts, scoped to this file's own worker process.
const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }));

/** Case-insensitive `Headers.get`-alike shared by every fake Response below, since fetchHop
 *  reads response headers by name without regard to case. */
function fakeHeaders(headers: Record<string, string>) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** The `ok`/`status`/`headers` fields every fake Response below shares, so each only has to
 *  add its own `text`/`body`. */
function fakeResponseBase(status: number, headers: Record<string, string>) {
  return { ok: status >= 200 && status < 300, status, headers: fakeHeaders(headers) };
}

/** A minimal fetch Response stand-in: no `.body` stream, so fetchUrl's readBounded()
 *  takes the `r.text()` fallback path. Header lookups are case-insensitive like the real thing. */
function fakeResponse({ status = 200, headers = {}, body = '' }: { status?: number; headers?: Record<string, string>; body?: string }) {
  return { ...fakeResponseBase(status, headers), text: async () => body, body: undefined };
}

/** A ReadableStream whose `cancel()` records whether it was called (and optionally throws, to
 *  mirror a source that's already closed) — shared by fakeResponseWithUncancelledBody's untouched
 *  body and fakeStreamResponse's actively-read one, which only differ in whether `pull` sources
 *  chunks or the stream is never pulled at all. */
function fakeCancellableStream(state: { cancelled: boolean }, cancelThrows: boolean, pull?: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
  return new ReadableStream<Uint8Array>({
    pull,
    cancel() {
      state.cancelled = true;
      if (cancelThrows) throw new Error('stream already closed');
    },
  });
}

/** A fetchResponse-shaped stand-in whose `.body` is present (unlike fakeResponse's `undefined`)
 *  but never read — for asserting that a branch which skips readBounded() (redirect, non-OK)
 *  still cancels the body so the connection isn't leaked. `cancel` tracks whether it was called;
 *  the stream's `pull`/`cancel` stream-controller methods are never expected to run since nothing
 *  in fetchHop's redirect/non-OK branches calls `getReader()`. `cancelThrows` mirrors
 *  fakeStreamResponse's own flag, for asserting cancelBody() swallows a cancel() failure the same
 *  way readBounded's reader.cancel() does. */
function fakeResponseWithUncancelledBody({
  status,
  headers = {},
  cancelThrows = false,
}: { status: number; headers?: Record<string, string>; cancelThrows?: boolean }) {
  const state = { cancelled: false };
  const stream = fakeCancellableStream(state, cancelThrows);
  return { response: { ...fakeResponseBase(status, headers), text: async () => '', body: stream }, state };
}

/** A fetch Response stand-in with a real `.body` ReadableStream, so readBounded() takes its
 *  streaming path (the one enforcing MAX_BYTES) instead of the `.text()` fallback every other
 *  fake in this file uses. Tracks how many chunks the source was asked for and whether the
 *  reader was cancelled, so a test can assert readBounded() actually stopped reading early. */
function fakeStreamResponse(
  chunks: Uint8Array[],
  { status = 200, headers = {}, cancelThrows = false }: { status?: number; headers?: Record<string, string>; cancelThrows?: boolean } = {},
) {
  const state = { pulls: 0, cancelled: false };
  const stream = fakeCancellableStream(state, cancelThrows, (controller) => {
    if (state.pulls < chunks.length) {
      controller.enqueue(chunks[state.pulls]);
      state.pulls++;
    } else {
      controller.close();
    }
  });
  return { response: { ...fakeResponseBase(status, headers), text: async () => '', body: stream }, state };
}

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

test('isPrivateAddress flags private IPv4 addresses embedded via the deprecated IPv4-compatible IPv6 form and the NAT64 well-known prefix', () => {
  for (const ip of [
    '::7f00:1',                 // deprecated IPv4-compatible IPv6 (::/96) hex form = 127.0.0.1
    '::a9fe:a9fe',              // same, hex form = 169.254.169.254 (cloud metadata address)
    '64:ff9b::7f00:1',          // NAT64 well-known prefix (RFC 6052) hex form = 127.0.0.1
    '64:ff9b::a9fe:a9fe',       // same, hex form = 169.254.169.254 (cloud metadata address)
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress flags the deprecated IPv4-compatible IPv6 form in its dotted-decimal textual form, not just its hex form', () => {
  // The IPv4-compatible and IPv4-mapped cases are the two prefixes
  // `inet_ntop`/`getaddrinfo` actually render with a dotted-decimal suffix rather than hex — the
  // exact string a real (non-literal, resolved) DNS answer for `::/96` would hand to guardedLookup
  // via dns.lookup(), e.g. `socket.inet_ntop(AF_INET6, ...)` for 169.254.169.254 under `::/96`
  // yields '::169.254.169.254', never '::a9fe:a9fe'.
  for (const ip of [
    '::127.0.0.1',            // deprecated IPv4-compatible dotted form = 127.0.0.1
    '::169.254.169.254',      // same, cloud metadata address
    '::10.0.0.1',             // same, RFC1918
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
    assert.equal(anyAddressPrivate(ip), true, `${ip} should be private via anyAddressPrivate`);
  }
});

test('fetchUrl rejects the deprecated IPv4-compatible and NAT64 embeddings of a private address, matching how the WHATWG URL parser normalizes them', async (t) => {
  // `new URL('http://[::127.0.0.1]/').hostname` is '[::7f00:1]', and
  // `new URL('http://[64:ff9b::169.254.169.254]/').hostname` is '[64:ff9b::a9fe:a9fe]' — real
  // normalized forms a caller could actually send, not just isPrivateAddress unit inputs.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called for a private embedded-IPv4 host');
  });
  for (const url of ['http://[::127.0.0.1]/', 'http://[64:ff9b::169.254.169.254]/']) {
    const result = await fetchUrl(url);
    assert.equal(result.error, "Can't fetch that page: that address is private or internal.", url);
  }
});

test('isPrivateAddress flags a private address embedded via the NAT64 local-use prefix (RFC 8215, 64:ff9b:1::/48)', () => {
  for (const ip of [
    '64:ff9b:1:7f00:0:100::',   // /48 layout (u=0) hex form = 127.0.0.1
    '64:ff9b:1:a9fe:a9:fe00::', // /48 layout (u=0) hex form = 169.254.169.254 (cloud metadata)
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress flags a private address embedded via the 6to4 and Teredo tunneling prefixes', () => {
  for (const ip of [
    '2002:7f00:1::',            // 6to4 (RFC 3056) hex form = 127.0.0.1
    '2002:a9fe:a9fe::',         // same, hex form = 169.254.169.254 (cloud metadata address)
    '2001::80ff:fffe',          // Teredo (RFC 4380) obfuscated client address = 127.0.0.1
    '2001::5601:5601',          // same, obfuscated client address = 169.254.169.254
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress flags private addresses even when RFC 5952 canonical compression drops one or both trailing hex groups', () => {
  // The WHATWG URL parser always serializes with the shortest hextet, so a /96-embedded IPv4
  // address whose upper 16 (or all 32) bits are zero compresses further than the two-hextet
  // forms above: `new URL('http://[::0.0.1.1]/').hostname` is '[::101]' (one hextet), and
  // `new URL('http://[64:ff9b::0.0.0.0]/').hostname` is '[64:ff9b::]' (zero hextets).
  for (const ip of [
    '::101',        // deprecated IPv4-compatible, one trailing hextet = 0.0.1.1 (0.0.0.0/8)
    '64:ff9b::1',   // NAT64 well-known prefix, one trailing hextet = 0.0.0.1 (0.0.0.0/8)
    '64:ff9b::',    // NAT64 well-known prefix, zero trailing hextets = 0.0.0.0 (0.0.0.0/8)
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress allows public addresses', () => {
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700::1111',
    '::808:808',              // deprecated IPv4-compatible hex form = 8.8.8.8 (public)
    '::8.8.8.8',              // same, dotted-decimal textual form (public)
    '64:ff9b::808:808',       // NAT64 well-known prefix hex form = 8.8.8.8 (public)
    '64:ff9b:1:808:8:800::',  // NAT64 local-use prefix (/48 layout) hex form = 8.8.8.8 (public)
    '2002:808:808::',         // 6to4 hex form = 8.8.8.8 (public)
    '2001::f7f7:f7f7',        // Teredo obfuscated client address = 8.8.8.8 (public)
  ]) {
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

test('extractTitle returns undefined for an empty or whitespace-only <title>', () => {
  assert.equal(extractTitle('<html><head><title></title></head></html>'), undefined);
  assert.equal(extractTitle('<html><head><title>   </title></head></html>'), undefined);
});

test('htmlToText strips script and style content entirely', () => {
  const html = '<p>Hello</p><script>alert(1)</script><style>.a{color:red}</style><p>World</p>';
  const text = htmlToText(html);
  assert.match(text, /Hello/);
  assert.match(text, /World/);
  assert.doesNotMatch(text, /alert/);
  assert.doesNotMatch(text, /color:red/);
});

test('htmlToText strips an unterminated <script> (e.g. cut off by MAX_BYTES truncation) instead of leaking its raw contents', () => {
  const html = '<p>Hello</p><script>var secretApiKey = "sk-abc123"; doSomething(';
  const text = htmlToText(html);
  assert.match(text, /Hello/);
  assert.doesNotMatch(text, /secretApiKey/);
});

test('htmlToText does not mistake a custom element like <svg-icon>/<template-card> for an unterminated <svg>/<template>', () => {
  const html = '<p>Hello</p><svg-icon>icon text</svg-icon><template-card>card text</template-card><p>World</p>';
  const text = htmlToText(html);
  assert.match(text, /Hello/);
  assert.match(text, /icon text/);
  assert.match(text, /card text/);
  assert.match(text, /World/);
});

test('htmlToText strips <head> content (title, meta) so it is not duplicated into the body text', () => {
  const html = '<html><head><title>Page Title</title><meta name="description" content="a description"></head><body><p>Hello world</p></body></html>';
  const text = htmlToText(html);
  assert.match(text, /Hello world/);
  assert.doesNotMatch(text, /Page Title/);
  assert.doesNotMatch(text, /a description/);
});

test('htmlToText does not mistake <header> for an unterminated <head> block', () => {
  const html = '<header>Site Nav</header><p>Hello world</p>';
  const text = htmlToText(html);
  assert.match(text, /Site Nav/);
  assert.match(text, /Hello world/);
});

test('htmlToText drops an unterminated HTML comment instead of leaking its contents', () => {
  const html = '<p>Hello</p><!-- internal note: do not shi';
  const text = htmlToText(html);
  assert.match(text, /Hello/);
  assert.doesNotMatch(text, /internal note/);
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

test('htmlToText does not throw on out-of-range numeric entities', () => {
  const text = htmlToText('<p>a &#9999999; b</p>');
  assert.match(text, /a/);
  assert.match(text, /b/);
});

test('htmlToText turns self-closing <br/> into a newline', () => {
  assert.equal(htmlToText('one<br/>two<br />three'), 'one\ntwo\nthree');
});

test('htmlToText backs off one char when truncation would split a surrogate pair', () => {
  // 😀 (U+1F600) is a UTF-16 surrogate pair; a naive slice(0, 5) would land mid-pair and
  // leave a lone (invalid) surrogate in the output.
  const text = htmlToText('abcd\u{1F600}e', 5);
  assert.equal(text, 'abcd…');
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
  // explicit BLOCKED_HOSTS entries; foo.localhost hits the `.localhost` suffix rule instead. The
  // trailing-dot variants are the same RFC 1035 "root" FQDN spelling, resolved identically by DNS.
  for (const host of [
    'localhost',
    'metadata',
    'metadata.google.internal',
    'foo.localhost',
    'localhost.',
    'metadata.',
    'metadata.google.internal.',
    'foo.localhost.',
  ]) {
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

test('fetchUrl allows a literal public IP host through guardHost, unlike a private one', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({
    headers: { 'content-type': 'text/plain' },
    body: 'hello from a public IP',
  }));
  const result = await fetchUrl('http://8.8.8.8/');
  assert.equal(result.text, 'hello from a public IP');
  assert.equal(result.error, undefined);
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
  assert.doesNotMatch(result.text ?? '', /Hi/);
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

test('fetchUrl sniffs HTML by body content when the response has no Content-Type header', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({
    headers: {}, // no content-type at all, unlike every other fetchUrl test in this file
    body: '<html><head><title>Sniffed</title></head><body><p>Hello world</p></body></html>',
  }));
  const result = await fetchUrl('https://example.com/no-content-type');
  assert.equal(result.title, 'Sniffed'); // only extracted on the isHtml path
  assert.match(result.text ?? '', /Hello world/);
});

test('fetchUrl does not split a surrogate pair sitting at the MAX_CHARS boundary of a non-HTML body (r.text() fallback)', async (t) => {
  // 5999 'a's + a surrogate-pair emoji straddles chars 5999-6000, exactly the truncation
  // boundary. Without truncateSafely, plain `.slice(0, 6000)` would leave a lone high
  // surrogate as the last character.
  const body = 'a'.repeat(5999) + '\u{1F600}' + 'END';
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body }));
  const result = await fetchUrl('https://example.com/plain.txt');
  assert.equal(result.text, 'a'.repeat(5999) + '…');
  const lastCode = result.text!.charCodeAt(result.text!.length - 2);
  assert.ok(lastCode < 0xd800 || lastCode > 0xdbff, 'must not end on a lone high surrogate');
});

test('fetchUrl does not split a surrogate pair sitting at the MAX_CHARS boundary of a streamed non-HTML body', async (t) => {
  const body = 'a'.repeat(5999) + '\u{1F600}' + 'z'.repeat(3000);
  const { response } = fakeStreamResponse([new TextEncoder().encode(body)], { headers: { 'content-type': 'text/plain' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  const result = await fetchUrl('https://example.com/huge-plain.txt');
  assert.equal(result.text, 'a'.repeat(5999) + '…');
  const lastCode = result.text!.charCodeAt(result.text!.length - 2);
  assert.ok(lastCode < 0xd800 || lastCode > 0xdbff, 'must not end on a lone high surrogate');
});

test('fetchUrl appends an ellipsis to a truncated non-HTML body, same as it does for HTML', async (t) => {
  // Before the fix, a truncated plain-text/JSON/etc. body was cut with no indicator at all,
  // while a truncated HTML page always got htmlToText's ellipsis suffix — so the model could
  // tell it was seeing a partial HTML page but not a partial non-HTML one.
  const body = 'x'.repeat(6500); // over the 6000-char MAX_CHARS cap
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body }));
  const result = await fetchUrl('https://example.com/huge.txt');
  assert.ok(result.text?.endsWith('…'), 'truncated non-HTML text must end with an ellipsis');
  assert.equal(result.text, 'x'.repeat(6000) + '…');
});

test('fetchUrl does not append an ellipsis to a non-HTML body that was not truncated', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body: 'short body' }));
  const result = await fetchUrl('https://example.com/short.txt');
  assert.equal(result.text, 'short body');
});

test('fetchUrl still signals truncation when a byte-capped read trims back under MAX_CHARS via trailing whitespace', async (t) => {
  // 100 real chars, then enough space padding to blow past MAX_BYTES before the stream's own
  // end — readBounded stops reading mid-stream (never observes `done`), so real content past
  // its cap may have gone unread. body.trim() alone would collapse this back down to 100 chars
  // (well under MAX_CHARS) and hide that entirely; the fix must force the ellipsis anyway.
  const real = new TextEncoder().encode('r'.repeat(100));
  const space = new Uint8Array(500_000).fill(32); // 500,000 space bytes per chunk
  const chunks = [real, ...Array.from({ length: 4 }, () => space)]; // 100 + 2,000,000 bytes; cap is 2,000,000
  const { response } = fakeStreamResponse(chunks, { headers: { 'content-type': 'text/plain' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  const result = await fetchUrl('https://example.com/padded.txt');
  assert.equal(result.text, 'r'.repeat(100) + '…');
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
  assert.equal(result.text?.length, 6001); // capped to MAX_CHARS + an ellipsis, like any other truncated body
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
  assert.equal(result.text?.length, 6001);
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

test('fetchUrl reports the actual downloaded byte count as webfetch.bytes telemetry, not the UTF-16 string length', async (t) => {
  // '日本語' is 3 UTF-16 code units (body.length === 3) but 9 bytes in UTF-8 — before the fix,
  // fetchHop reported body.length (3) as `webfetch.bytes`, undercounting real multi-byte content
  // by a factor of 3.
  const encoded = new TextEncoder().encode('日本語');
  const { response } = fakeStreamResponse([encoded], { headers: { 'content-type': 'text/plain' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  spanExporter.reset();
  const result = await fetchUrl('https://example.com/cjk');
  assert.equal(result.text, '日本語');
  const span = spanExporter.getFinishedSpans().find((s) => s.name === 'tool.web_fetch');
  assert.equal(span?.attributes['webfetch.bytes'], encoded.byteLength);
});

test('fetchUrl reports the actual downloaded byte count as webfetch.bytes telemetry on the r.text() fallback path too', async (t) => {
  const body = '日本語'; // same 3 UTF-16 units / 9 UTF-8 bytes mismatch, via fakeResponse's non-streaming path
  t.mock.method(globalThis, 'fetch', async () => fakeResponse({ headers: { 'content-type': 'text/plain' }, body }));
  spanExporter.reset();
  const result = await fetchUrl('https://example.com/cjk-fallback');
  assert.equal(result.text, body);
  const span = spanExporter.getFinishedSpans().find((s) => s.name === 'tool.web_fetch');
  assert.equal(span?.attributes['webfetch.bytes'], Buffer.byteLength(body, 'utf8'));
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

test('fetchUrl caps an all-redirects chain at exactly MAX_REDIRECTS redirects (one more fetch for the final hop)', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return fakeResponse({ status: 302, headers: { location: 'https://example.com/next' } });
  });
  const result = await fetchUrl('https://example.com/start');
  // MAX_REDIRECTS (5) redirect fetches, plus the one final fetch that gives up instead of
  // redirecting again — 6 total. Fails against the pre-fix `hop < MAX_REDIRECTS` loop bound,
  // which stopped one fetch short of this and never let a legitimate MAX_REDIRECTS-length
  // redirect chain reach its real destination.
  assert.equal(calls, 6);
  assert.equal(result.error, 'That page redirected too many times.');
});

test('fetchUrl follows exactly MAX_REDIRECTS redirects and still lands on the final page', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    calls++;
    const u = input.toString();
    const hopIndex = Number(u.match(/\/hop(\d+)$/)?.[1]);
    if (hopIndex < 5) return fakeResponse({ status: 302, headers: { location: `https://example.com/hop${hopIndex + 1}` } });
    return fakeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'final page text' });
  });
  const result = await fetchUrl('https://example.com/hop0');
  assert.equal(calls, 6);
  assert.equal(result.url, 'https://example.com/hop5');
  assert.equal(result.text, 'final page text');
});

test('fetchUrl cancels the response body on a redirect instead of leaking the connection', async (t) => {
  const { response, state } = fakeResponseWithUncancelledBody({ status: 302, headers: { location: 'https://example.com/next' } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    // Second hop: a plain fakeResponse (body: undefined) so the loop can terminate normally.
    if (calls === 2) return fakeResponse({ headers: { 'content-type': 'text/plain' }, body: 'final page text' });
    return response;
  });
  await fetchUrl('https://example.com/start');
  assert.equal(state.cancelled, true);
});

test('fetchUrl ignores a redirect hop\'s body.cancel() failure rather than letting it propagate', async (t) => {
  // Same "already closed" hazard as readBounded's reader.cancel(), but for cancelBody() —
  // the redirect/non-OK branches must swallow it too rather than let it surface as fetchUrl's
  // own error in place of the redirect chain's real outcome.
  const { response, state } = fakeResponseWithUncancelledBody({
    status: 302,
    headers: { location: 'https://example.com/next' },
    cancelThrows: true,
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 2) return fakeResponse({ headers: { 'content-type': 'text/plain' }, body: 'final page text' });
    return response;
  });
  const result = await fetchUrl('https://example.com/start');
  assert.equal(state.cancelled, true);
  assert.equal(result.text, 'final page text');
});

test('fetchUrl cancels the response body on a non-OK status instead of leaking the connection', async (t) => {
  const { response, state } = fakeResponseWithUncancelledBody({ status: 404 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await fetchUrl('https://example.com/missing');
  assert.equal(state.cancelled, true);
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

test('webFetch tool schema rejects a blank or over-length url, and trims whitespace', () => {
  // Same defense-in-depth every other model-supplied free-text tool input applies (weather's
  // city, animation's topic/title/step, wolfram/web_search's query): url was the one loosely-typed
  // v.string() left unbounded, so a model echoing an oversized blob back into a follow-up
  // web_fetch call could reach fetchUrl's SSRF-guarded redirect loop with no cap at all.
  assert.throws(() => v.parse(webFetch.input, { url: '   ' }));
  assert.throws(() => v.parse(webFetch.input, { url: `https://example.com/${'x'.repeat(2000)}` }));
  assert.doesNotThrow(() => v.parse(webFetch.input, { url: `https://example.com/${'x'.repeat(1980)}` }));
  assert.equal(v.parse(webFetch.input, { url: '  https://example.com  ' }).url, 'https://example.com');
});

test('webFetch.run() falls back to no signal when the flue runtime supplies none', async (t) => {
  const { sentinel, getSignal } = withCapturedTimeoutSignal(t);
  const input = v.parse(webFetch.input, { url: 'https://example.com' });
  await webFetch.run({ input, signal: undefined });
  // No caller signal -> fetchUrl's own bounded default timeout signal, not undefined.
  assert.equal(getSignal(), sentinel);
});

