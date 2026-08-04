// Characterization test for index.html's `exitPresentation`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins what
// exitPresentation() does to the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps, loadRealSetPresentationVisible } from './test-helpers.mjs';

const html = readClientHtml();

test('exitPresentation() hides the stage, clears the svg, and removes the presenting class', () => {
  const stageSvg = { innerHTML: '<svg>mock</svg>' };
  // The real setPresentationVisible, bound to this test's own stageEl/bodyClassList, so the
  // assertions below still observe exitPresentation()'s actual end state rather than a mocked call.
  const { setPresentationVisible, stageEl, bodyClassList } =
    loadRealSetPresentationVisible(html, { initialAriaHidden: 'false', initialClasses: ['presenting'] });

  const exitPresentation = extractFunctionWithDeps(html, 'exitPresentation', { setPresentationVisible, stageSvg });
  exitPresentation();

  assert.equal(stageEl.attrs['aria-hidden'], 'true');
  assert.equal(stageSvg.innerHTML, '');
  assert.ok(!bodyClassList.has('presenting'));
});
