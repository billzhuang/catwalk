// Characterization test for index.html's `handleChipClick`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// chip-preview trigger that used to live inline in the chip click listener, which had zero test
// coverage unlike every sibling inline handler in this file (teardown, present, pollAnimation,
// handleConnectionStateChange, ...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

test('handleChipClick(topic) previews the given topic via present()', () => {
  const presentCalls = [];
  const handleChipClick = extractFunctionWithDeps(html, 'handleChipClick', {
    present: (topic) => presentCalls.push(topic),
  });

  handleChipClick('pythagoras');

  assert.deepEqual(presentCalls, ['pythagoras']);
});
