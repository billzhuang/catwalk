// Characterization test for index.html's `handleDataChannelMessage`, run with plain
// `node --test` (no bundler/deps, matching this client's zero-build convention). It reads the
// real <script> source out of index.html — rather than a copy — so it can't drift from what
// ships. Pins the one thing that must hold across a refactor of this function: it never throws
// and never returns a value, for any data-channel payload shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'index.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.html`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return html.slice(start, i + 1);
}

const handleDataChannelMessage = new Function(`return (${extractFunction('handleDataChannelMessage')});`)();

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
