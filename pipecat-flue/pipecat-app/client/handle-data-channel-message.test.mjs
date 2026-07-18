// Characterization test for index.html's `handleDataChannelMessage`, run with plain
// `node --test` (no bundler/deps, matching this client's zero-build convention). It reads the
// real <script> source out of index.html — rather than a copy — so it can't drift from what
// ships. Pins the one thing that must hold across a refactor of this function: it never throws
// and never returns a value, for any data-channel payload shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction } from './test-helpers.mjs';

const html = readClientHtml();
const handleDataChannelMessage = new Function(`return (${extractFunction(html, 'handleDataChannelMessage')});`)();

test('handleDataChannelMessage never throws and has no return value, across message shapes', () => {
  const inputs = [
    'ping',
    'ping-keepalive',
    'not json',
    '"a string"',
    '{"type":"signalling"}',
    '{"foo":"bar"}',
    '[]',
    'null',
    null,
    undefined,
    123,
  ];
  for (const input of inputs) {
    const result = handleDataChannelMessage(input);
    assert.strictEqual(result, undefined, `expected no return value for input: ${JSON.stringify(input)}`);
  }
});
