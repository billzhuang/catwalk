// Characterization test for index.html's `handleConnectionStateChange`, run with plain
// `node --test` (no bundler/deps, matching this client's zero-build convention). It reads the
// real <script> source out of index.html — rather than a copy — so it can't drift from what
// ships. Pins the connected/disconnected UI transitions that used to live inline in connect()'s
// `pc.onconnectionstatechange` handler, which had zero test coverage unlike every sibling inline
// function in this file (teardown, present, pollAnimation, ...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function makeClassList() {
  const classes = new Set();
  return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) };
}

function loadHandleConnectionStateChange() {
  const micWrap = { classList: makeClassList() };
  const micBtn = { classList: makeClassList(), textContent: '', disabled: true };
  const statusCalls = [];
  const startPollingCalls = [];
  const teardownCalls = [];
  const deps = {
    connected: false,
    micWrap,
    micBtn,
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

test('handleConnectionStateChange("disconnected") tears down with a generic reason', () => {
  const { handleConnectionStateChange, teardownCalls } = loadHandleConnectionStateChange();

  handleConnectionStateChange('disconnected');

  assert.deepEqual(teardownCalls, ['Disconnected']);
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
