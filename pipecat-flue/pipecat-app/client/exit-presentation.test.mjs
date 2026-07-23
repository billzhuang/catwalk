// Characterization test for index.html's `exitPresentation`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins what
// exitPresentation() does to the DOM, ahead of caching the `#stage` lookup (exitPresentation()
// and present() currently each call document.getElementById("stage") fresh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps, makeClassList } from './test-helpers.mjs';

const html = readClientHtml();

function makeStageEl(initialAriaHidden) {
  const attrs = { 'aria-hidden': initialAriaHidden };
  return { setAttribute: (k, v) => { attrs[k] = v; }, attrs };
}

test('exitPresentation() hides the stage, clears the svg, and removes the presenting class', () => {
  const stageEl = makeStageEl('false');
  const stageSvg = { innerHTML: '<svg>mock</svg>' };
  const bodyClassList = makeClassList(['presenting']);
  const document = {
    body: { classList: bodyClassList },
    getElementById: (id) => (id === 'stage' ? stageEl : undefined),
  };

  const exitPresentation = extractFunctionWithDeps(html, 'exitPresentation', { document, stageSvg, stageEl });
  exitPresentation();

  assert.equal(stageEl.attrs['aria-hidden'], 'true');
  assert.equal(stageSvg.innerHTML, '');
  assert.ok(!bodyClassList.has('presenting'));
});
