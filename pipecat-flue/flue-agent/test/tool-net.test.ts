import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import {
  boundedText,
  buildQueryUrl,
  createStreamDecoder,
  decodeEntities,
  describeFetchError,
  resolveTimeoutSignal,
  truncateSafely,
  truncateWithEllipsis,
  withLookupError,
  withSpanAndLookupError,
} from '../src/tool-net.ts';

test('boundedText trims surrounding whitespace', () => {
  assert.equal(v.parse(boundedText(10, 'd'), '  hi  '), 'hi');
});

test('boundedText rejects a blank or whitespace-only value', () => {
  assert.throws(() => v.parse(boundedText(10, 'd'), ''));
  assert.throws(() => v.parse(boundedText(10, 'd'), '   '));
});

test('boundedText rejects a value over the configured max length', () => {
  // A model that over-fills a loosely-typed string arg (e.g. echoing a transcript blob as a
  // "city" or "query") must be rejected rather than sent unbounded into a downstream API call.
  assert.throws(() => v.parse(boundedText(5, 'd'), '123456'));
  assert.doesNotThrow(() => v.parse(boundedText(5, 'd'), '12345'));
});

test('buildQueryUrl sets each param on the base URL', () => {
  const url = new URL(buildQueryUrl('https://example.com/api', { q: 'ramen', count: '3' }));
  assert.equal(url.origin + url.pathname, 'https://example.com/api');
  assert.equal(url.searchParams.get('q'), 'ramen');
  assert.equal(url.searchParams.get('count'), '3');
});

test('buildQueryUrl preserves a param value containing reserved query characters as one param', () => {
  const url = new URL(buildQueryUrl('https://example.com/api', { q: 'ramen & noodles = yum', count: '3' }));
  assert.equal(url.searchParams.get('q'), 'ramen & noodles = yum');
  assert.equal(url.searchParams.get('count'), '3');
});

test('createStreamDecoder reassembles a codepoint split across two decode() calls', () => {
  const bytes = new TextEncoder().encode('café'); // é is the 2-byte UTF-8 sequence 0xc3 0xa9
  const splitAt = bytes.length - 1; // splits é's two bytes across the chunk boundary
  const decoder = createStreamDecoder();
  const first = decoder.decode(bytes.slice(0, splitAt));
  const second = decoder.decode(bytes.slice(splitAt));
  assert.equal(first, 'caf');
  assert.equal(second, 'é');
});

test('createStreamDecoder.flush() emits nothing once every chunk has already been fully decoded', () => {
  const decoder = createStreamDecoder();
  decoder.decode(new TextEncoder().encode('hello'));
  assert.equal(decoder.flush(), '');
});

test('describeFetchError reports a plain "timed out" message for AbortSignal.timeout errors', () => {
  assert.equal(describeFetchError(new DOMException('The operation timed out.', 'TimeoutError')), 'the request timed out');
});

test('describeFetchError passes through other errors\' messages unchanged', () => {
  assert.equal(describeFetchError(new Error('fetch failed: ECONNREFUSED')), 'fetch failed: ECONNREFUSED');
});

test('resolveTimeoutSignal is already aborted when the caller signal is already aborted', () => {
  const signal = AbortSignal.abort();
  assert.equal(resolveTimeoutSignal(signal).aborted, true);
});

test('resolveTimeoutSignal falls back to a 15s AbortSignal.timeout() when none is given', (t) => {
  const sentinel = AbortSignal.abort(); // any distinct AbortSignal works as a spy return value
  const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => sentinel);
  const result = resolveTimeoutSignal(undefined);
  assert.equal(result, sentinel);
  assert.equal(timeoutMock.mock.callCount(), 1);
  assert.deepEqual(timeoutMock.mock.calls[0].arguments, [15_000]);
});

test('resolveTimeoutSignal still enforces the default timeout when a non-aborting caller signal is given', (t) => {
  // Regression test: the flue runtime always supplies tools a turn-scoped signal that only
  // aborts on user interruption, never on its own. If resolveTimeoutSignal treated that signal
  // as a full replacement for the default timeout (the old behavior), a hung upstream call would
  // never time out in production. Here the caller signal never aborts, so only the mocked
  // default-timeout firing should be able to abort the combined result.
  const timeoutController = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
  const callerSignal = new AbortController().signal;
  const result = resolveTimeoutSignal(callerSignal);
  assert.equal(result.aborted, false);
  timeoutController.abort();
  assert.equal(result.aborted, true);
});

test('resolveTimeoutSignal still aborts immediately when the caller signal aborts, even before the timeout fires', (t) => {
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal); // never fires in this test
  const callerController = new AbortController();
  const result = resolveTimeoutSignal(callerController.signal);
  callerController.abort();
  assert.equal(result.aborted, true);
});

test('decodeEntities handles numeric and hex character references', () => {
  assert.equal(decodeEntities('&#65;&#x42;&#67;'), 'ABC');
});

test('decodeEntities handles an uppercase-X hex character reference', () => {
  // Per the HTML5 spec, &#x...; and &#X...; are both valid, case-insensitive numeric character
  // references. Some pages/feeds emit the uppercase form; ENTITY_RE previously hardcoded a
  // lowercase x, so it silently failed to decode "&#X2019;" and left it as raw entity text.
  assert.equal(decodeEntities('&#X2019;'), '’');
  assert.equal(decodeEntities('it&#X2019;s'), 'it’s');
});

test('decodeEntities does not double-decode already-escaped sequences', () => {
  // Page text "&lt;tag&gt;" is encoded as "&amp;lt;tag&amp;gt;" — must decode to "&lt;tag&gt;".
  assert.equal(decodeEntities('&amp;lt;tag&amp;gt;'), '&lt;tag&gt;');
});

test('decodeEntities does not let a numeric-escaped "&" collide with adjacent literal "amp;" text', () => {
  // "&#38;" is a numeric-escaped "&", followed by the unrelated literal text "amp;" (e.g. a page
  // explaining HTML entity syntax: "type &#38;amp; to display an ampersand"). A sequential
  // decode-then-rescan pipeline turns the numeric pass's "&" output plus the trailing "amp;"
  // into the substring "&amp;", which a later pass then wrongly collapses a second time down to
  // a bare "&", silently eating "amp;".
  assert.equal(decodeEntities('&#38;amp;'), '&amp;');
  assert.equal(
    decodeEntities('You should write &#38;amp; to escape it'),
    'You should write &amp; to escape it',
  );
});

test('decodeEntities leaves out-of-range numeric references intact instead of throwing', () => {
  assert.equal(decodeEntities('x &#9999999; y'), 'x &#9999999; y');
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;');
});

test('decodeEntities decodes the named entities other than amp/lt/gt', () => {
  // amp/lt/gt are already exercised indirectly by the collision tests above; nbsp/quot/apos
  // have no other test touching them.
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities('say &quot;hi&quot;'), 'say "hi"');
  assert.equal(decodeEntities('it&apos;s'), "it's");
});

test('decodeEntities leaves lone-surrogate numeric references intact instead of producing an invalid surrogate', () => {
  // 55296 (0xd800) is inside the UTF-16 surrogate range, not a valid standalone code point —
  // String.fromCodePoint accepts it anyway, producing a lone surrogate that corrupts to U+FFFD
  // once the string is later encoded as UTF-8 (e.g. in the outbound request body).
  assert.equal(decodeEntities('before &#55296; after'), 'before &#55296; after');
  assert.equal(decodeEntities('&#xd800;'), '&#xd800;');
  assert.equal(decodeEntities('&#xdfff;'), '&#xdfff;'); // low end and high end of the range
});

test('truncateSafely backs off one char rather than split a surrogate pair', () => {
  // 😀 sits across the cut point (chars 4-5 of a 6-char string); a naive slice(0, 5) would
  // return a lone high surrogate.
  assert.equal(truncateSafely('abcd\u{1F600}e', 5), 'abcd');
});

test('truncateSafely is a no-op when text is already within the limit', () => {
  assert.equal(truncateSafely('short', 10), 'short');
});

test('truncateSafely cuts cleanly when the boundary does not split a pair', () => {
  assert.equal(truncateSafely('abcdefgh', 5), 'abcde');
});

test('truncateWithEllipsis appends an ellipsis only when text was actually cut', () => {
  assert.equal(truncateWithEllipsis('abcdefgh', 5), 'abcde…');
});

test('truncateWithEllipsis is a no-op when text is already within the limit', () => {
  assert.equal(truncateWithEllipsis('short', 10), 'short');
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

test('withSpanAndLookupError passes the span through to fn and returns its result', async () => {
  const result = await withSpanAndLookupError<{ ok: boolean; error?: string }>(
    'test.op',
    { city: 'Tokyo' },
    'Test lookup',
    async (span) => {
      span.setAttributes({ done: true });
      return { ok: true };
    },
  );
  assert.deepEqual(result, { ok: true });
});

test('withSpanAndLookupError maps a thrown error to the same shape as withLookupError', async () => {
  const result = await withSpanAndLookupError<{ error?: string }>('test.op', {}, 'Test lookup', async () => {
    throw new Error('boom');
  });
  assert.equal(result.error, 'Test lookup failed: boom');
});
