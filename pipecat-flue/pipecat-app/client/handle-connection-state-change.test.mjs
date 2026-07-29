// Characterization test for index.html's `handleConnectionStateChange`, run with plain
// `node --test` (no bundler/deps, matching this client's zero-build convention). It reads the
// real <script> source out of index.html — rather than a copy — so it can't drift from what
// ships. Pins the connected/disconnected UI transitions that used to live inline in connect()'s
// `pc.onconnectionstatechange` handler, which had zero test coverage unlike every sibling inline
// function in this file (teardown, present, pollAnimation, ...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps, loadRealSetMicUI } from './test-helpers.mjs';

const html = readClientHtml();

function loadHandleConnectionStateChange() {
  const statusCalls = [];
  const startPollingCalls = [];
  const teardownCalls = [];
  // The real setMicUI, bound to this test's own micWrap/micBtn mocks, so the assertions below
  // still observe handleConnectionStateChange's actual end state rather than a mocked call.
  const { setMicUI, micWrap, micBtn } = loadRealSetMicUI(html);
  const deps = {
    connected: false,
    setMicUI,
    setStatus: (...args) => statusCalls.push(args),
    startPolling: () => startPollingCalls.push([]),
    teardown: (reason) => teardownCalls.push(reason),
  };
  const handleConnectionStateChange = extractFunctionWithDeps(html, 'handleConnectionStateChange', deps);
  return { handleConnectionStateChange, micWrap, micBtn, statusCalls, startPollingCalls, teardownCalls };
}

test('handleConnectionStateChange("connected") marks the UI live and starts polling', () => {
  const { handleConnectionStateChange, micWrap, micBtn, statusCalls, startPollingCalls, teardownCalls } =
    loadHandleConnectionStateChange();

  handleConnectionStateChange('connected');

  assert.ok(micWrap.classList.has('connected'));
  assert.ok(micBtn.classList.has('live'));
  assert.equal(micBtn.textContent, 'Listening…');
  assert.equal(micBtn.disabled, false);
  assert.deepEqual(statusCalls, [['Connected — just start talking', 'on']]);
  assert.equal(startPollingCalls.length, 1);
  assert.equal(teardownCalls.length, 0);
});

test('handleConnectionStateChange("failed") tears down with a failed-specific reason', () => {
  const { handleConnectionStateChange, teardownCalls, startPollingCalls } = loadHandleConnectionStateChange();

  handleConnectionStateChange('failed');

  assert.deepEqual(teardownCalls, ['Connection failed']);
  assert.equal(startPollingCalls.length, 0);
});

test('handleConnectionStateChange("disconnected") leaves an already-active call\'s polling and mic untouched', () => {
  const { handleConnectionStateChange, micWrap, micBtn, statusCalls, teardownCalls, startPollingCalls } =
    loadHandleConnectionStateChange();

  // Establish a genuinely active call first — the same live state connect()'s "connected"
  // transition leaves in place — so this test proves "disconnected" preserves an in-progress
  // call's mic/polling state, not just that a fixture with nothing active stays inactive.
  handleConnectionStateChange('connected');
  assert.equal(startPollingCalls.length, 1);

  handleConnectionStateChange('disconnected');

  // Per the WebRTC spec, "disconnected" is transient and can self-recover back to "connected" —
  // unlike "failed"/"closed", it must not tear down the call, stop polling, or release the mic.
  assert.deepEqual(teardownCalls, []);
  assert.equal(startPollingCalls.length, 1); // no additional interval started
  assert.ok(micWrap.classList.has('connected'));
  assert.ok(micBtn.classList.has('live'));
  assert.equal(micBtn.textContent, 'Listening…');
  assert.deepEqual(statusCalls.at(-1), ['Reconnecting…']);
});

test('handleConnectionStateChange("disconnected") tears down a connection that never connected', () => {
  const { handleConnectionStateChange, statusCalls, teardownCalls, startPollingCalls } =
    loadHandleConnectionStateChange();

  // No prior "connected" transition — this is a connection attempt that went straight from
  // "connecting" to "disconnected" without ever establishing a live call. Unlike the
  // already-active-call case above, there's nothing to preserve, so this must tear down rather
  // than leave the mic button (disabled since connect()'s entry) stuck with no way to retry.
  handleConnectionStateChange('disconnected');

  assert.deepEqual(teardownCalls, ['Could not connect']);
  assert.equal(startPollingCalls.length, 0);
  assert.deepEqual(statusCalls, []);
});

test('handleConnectionStateChange("closed") tears down with a generic reason', () => {
  const { handleConnectionStateChange, teardownCalls } = loadHandleConnectionStateChange();

  handleConnectionStateChange('closed');

  assert.deepEqual(teardownCalls, ['Disconnected']);
});

test('handleConnectionStateChange is a no-op for a transient, non-terminal state', () => {
  const { handleConnectionStateChange, statusCalls, startPollingCalls, teardownCalls } =
    loadHandleConnectionStateChange();

  handleConnectionStateChange('connecting');

  assert.deepEqual(statusCalls, []);
  assert.equal(startPollingCalls.length, 0);
  assert.equal(teardownCalls.length, 0);
});
