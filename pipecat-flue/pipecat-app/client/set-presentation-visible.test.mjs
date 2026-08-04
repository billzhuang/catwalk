// Characterization test for index.html's `setPresentationVisible`, run with plain `node --test`
// (no bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// stage visible-vs-hidden toggle extracted out of present()'s reveal and exitPresentation()'s
// inverse hide, which used to repeat these same class/aria-hidden writes in opposite directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, loadRealSetPresentationVisible } from './test-helpers.mjs';

const html = readClientHtml();

test('setPresentationVisible(true) adds the presenting class and un-hides the stage', () => {
  const { setPresentationVisible, stageEl, bodyClassList } = loadRealSetPresentationVisible(html);

  setPresentationVisible(true);

  assert.ok(bodyClassList.has('presenting'));
  assert.equal(stageEl.attrs['aria-hidden'], 'false');
});

test('setPresentationVisible(false) removes the presenting class and hides the stage', () => {
  const { setPresentationVisible, stageEl, bodyClassList } =
    loadRealSetPresentationVisible(html, { initialAriaHidden: 'false', initialClasses: ['presenting'] });

  setPresentationVisible(false);

  assert.ok(!bodyClassList.has('presenting'));
  assert.equal(stageEl.attrs['aria-hidden'], 'true');
});
