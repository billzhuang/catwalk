// Characterization test for index.html's `buildAnimationSvgUrl`, run with plain `node --test`
// (no bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// query-string construction that `present()` relies on: title/steps/stepIndex are each optional
// and independently gated, and the URL falls back to no query string when none are provided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction } from './test-helpers.mjs';

const html = readClientHtml();
const buildAnimationSvgUrl = new Function(`return (${extractFunction(html, 'buildAnimationSvgUrl')});`)();

test('buildAnimationSvgUrl with only a topic omits the query string', () => {
  assert.equal(buildAnimationSvgUrl('sine'), '/animation-svg/sine');
});

test('buildAnimationSvgUrl encodes the topic segment', () => {
  assert.equal(buildAnimationSvgUrl('a b/c'), '/animation-svg/a%20b%2Fc');
});

test('buildAnimationSvgUrl omits an empty title but includes a non-empty one', () => {
  assert.equal(buildAnimationSvgUrl('sine', ''), '/animation-svg/sine');
  assert.equal(buildAnimationSvgUrl('sine', 'My Title'), '/animation-svg/sine?title=My+Title');
});

test('buildAnimationSvgUrl appends one steps param per array entry, ignoring non-arrays', () => {
  assert.equal(
    buildAnimationSvgUrl('sine', null, ['step1', 'step2']),
    '/animation-svg/sine?steps=step1&steps=step2'
  );
  assert.equal(buildAnimationSvgUrl('sine', null, 'not-an-array'), '/animation-svg/sine');
  assert.equal(buildAnimationSvgUrl('sine', null, undefined), '/animation-svg/sine');
});

test('buildAnimationSvgUrl includes an integer stepIndex, including zero, but not non-integers', () => {
  assert.equal(buildAnimationSvgUrl('sine', null, null, 2), '/animation-svg/sine?step=2');
  assert.equal(buildAnimationSvgUrl('sine', null, null, 0), '/animation-svg/sine?step=0');
  assert.equal(buildAnimationSvgUrl('sine', null, null, '2'), '/animation-svg/sine');
  assert.equal(buildAnimationSvgUrl('sine', null, null, NaN), '/animation-svg/sine');
  assert.equal(buildAnimationSvgUrl('sine', null, null, undefined), '/animation-svg/sine');
});

test('buildAnimationSvgUrl combines title, steps, and stepIndex in declaration order', () => {
  assert.equal(
    buildAnimationSvgUrl('derivative', 'Slope', ['intro', 'tangent'], 1),
    '/animation-svg/derivative?title=Slope&steps=intro&steps=tangent&step=1'
  );
});
