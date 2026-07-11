import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBraveUrl, interpretBraveResponse } from '../src/websearch.ts';

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
