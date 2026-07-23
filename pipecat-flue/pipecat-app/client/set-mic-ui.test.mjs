// Characterization test for index.html's `setMicUI`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// mic button/wrap connected-vs-idle toggle extracted out of handleConnectionStateChange's
// "connected" branch and teardown's inverse reset, which used to repeat these same
// class/text/disabled writes in opposite directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps, makeClassList } from './test-helpers.mjs';

const html = readClientHtml();

function loadSetMicUI() {
  const micWrap = { classList: makeClassList() };
  const micBtn = { classList: makeClassList(['live']), textContent: 'Listening…', disabled: true };
  const setMicUI = extractFunctionWithDeps(html, 'setMicUI', { micWrap, micBtn });
  return { setMicUI, micWrap, micBtn };
}

test('setMicUI(true) marks the UI live, sets the listening label, and enables the button', () => {
  const { setMicUI, micWrap, micBtn } = loadSetMicUI();
  micBtn.disabled = true;

  setMicUI(true);

  assert.ok(micWrap.classList.has('connected'));
  assert.ok(micBtn.classList.has('live'));
  assert.equal(micBtn.textContent, 'Listening…');
  assert.equal(micBtn.disabled, false);
});

test('setMicUI(false) resets the UI to the idle appearance and enables the button', () => {
  const { setMicUI, micWrap, micBtn } = loadSetMicUI();
  micWrap.classList.add('connected');

  setMicUI(false);

  assert.ok(!micWrap.classList.has('connected'));
  assert.ok(!micBtn.classList.has('live'));
  assert.equal(micBtn.textContent, 'Connect');
  assert.equal(micBtn.disabled, false);
});
