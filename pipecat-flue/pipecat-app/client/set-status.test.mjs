// Characterization test for index.html's `setStatus`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Every
// call site in index.html either passes a status class (e.g. "on", "err") or omits it, relying
// on `cls || ""` to clear it back to the plain/default look; this pins both branches, which had
// no dedicated coverage of their own (other tests only stub setStatus out as a dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function loadSetStatus() {
  const statusText = { textContent: '' };
  const statusEl = { className: '' };
  const setStatus = extractFunctionWithDeps(html, 'setStatus', { statusText, statusEl });
  return { setStatus, statusText, statusEl };
}

test('setStatus sets the message text and status class when a class is given', () => {
  const { setStatus, statusText, statusEl } = loadSetStatus();

  setStatus('Connected — just start talking', 'on');

  assert.equal(statusText.textContent, 'Connected — just start talking');
  assert.equal(statusEl.className, 'on');
});

test('setStatus clears the status class back to "" when no class is given', () => {
  const { setStatus, statusText, statusEl } = loadSetStatus();
  statusEl.className = 'on';

  setStatus('Requesting microphone…');

  assert.equal(statusText.textContent, 'Requesting microphone…');
  assert.equal(statusEl.className, '');
});
