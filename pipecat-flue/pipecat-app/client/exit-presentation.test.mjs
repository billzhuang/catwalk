// Characterization test for index.html's `exitPresentation`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins what
// exitPresentation() does to the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps, makeClassList, makeStageEl } from './test-helpers.mjs';

const html = readClientHtml();

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
