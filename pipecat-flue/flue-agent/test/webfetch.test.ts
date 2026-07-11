import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, extractTitle, decodeEntities, isPrivateAddress, describeFetchError } from '../src/webfetch.ts';

test('describeFetchError reports a plain "timed out" message for AbortSignal.timeout errors', () => {
  assert.equal(describeFetchError(new DOMException('The operation timed out.', 'TimeoutError')), 'the request timed out');
});

test('describeFetchError passes through other errors\' messages unchanged', () => {
  assert.equal(describeFetchError(new Error('fetch failed: ECONNREFUSED')), 'fetch failed: ECONNREFUSED');
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
