// Characterization test for index.html's `sameAnimationSignature`, run with plain `node --test`
// (no bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// revision/epoch equality check shared by pollAnimation and present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction } from './test-helpers.mjs';

const html = readClientHtml();
const sameAnimationSignature = new Function(`return (${extractFunction(html, 'sameAnimationSignature')});`)();

test('sameAnimationSignature is true when both revision and epoch match', () => {
  assert.equal(sameAnimationSignature(1, 'epoch-A', 1, 'epoch-A'), true);
});

test('sameAnimationSignature is false when revision differs', () => {
  assert.equal(sameAnimationSignature(2, 'epoch-A', 1, 'epoch-A'), false);
});

test('sameAnimationSignature is false when epoch differs', () => {
  assert.equal(sameAnimationSignature(1, 'epoch-B', 1, 'epoch-A'), false);
});

test('sameAnimationSignature treats undefined epoch on both sides as matching', () => {
  assert.equal(sameAnimationSignature(1, undefined, 1, undefined), true);
});
