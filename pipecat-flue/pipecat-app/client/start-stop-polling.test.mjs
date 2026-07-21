// Characterization test for index.html's `startPolling`/`stopPolling`, run with plain
// `node --test` (no bundler/deps, matching this client's zero-build convention). It reads the
// real <script> source out of index.html — rather than a copy — so it can't drift from what
// ships. Every other inline function in this file already has a dedicated test; these two were
// only ever mocked out by teardown.test.mjs/handle-connection-state-change.test.mjs, never
// exercised as real code. They share the module-level `pollTimer` variable, so both are
// extracted together into one fresh closure per test. Pins: startPolling's self-stop-before-start
// (avoids a leaked second setInterval if it's called twice without an intervening disconnect,
// e.g. an ICE restart) and stopPolling's `if (pollTimer)` guard (avoids clearInterval(null) when
// teardown() runs before a connection ever reached "connected").
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction } from './test-helpers.mjs';

const html = readClientHtml();
const startPollingSrc = extractFunction(html, 'startPolling');
const stopPollingSrc = extractFunction(html, 'stopPolling');

function loadPolling({ setInterval: setIntervalFn, clearInterval: clearIntervalFn, pollAnimation }) {
  const factory = new Function(
    'setInterval', 'clearInterval', 'pollAnimation',
    `let pollTimer = null;
     ${startPollingSrc}
     ${stopPollingSrc}
     return { startPolling, stopPolling, getPollTimer: () => pollTimer };`,
  );
  return factory(setIntervalFn, clearIntervalFn, pollAnimation);
}

test('startPolling stops any existing timer before starting a new one, so a repeat call cannot leak an interval', () => {
  let nextHandle = 1;
  const setInterval = mock.fn(() => nextHandle++);
  const clearInterval = mock.fn();
  const { startPolling } = loadPolling({ setInterval, clearInterval, pollAnimation: () => {} });

  startPolling();
  startPolling();

  assert.strictEqual(setInterval.mock.callCount(), 2);
  assert.strictEqual(clearInterval.mock.callCount(), 1);
  assert.strictEqual(clearInterval.mock.calls[0].arguments[0], 1);
});

test('startPolling schedules pollAnimation on a 1000ms interval and records the handle', () => {
  const setInterval = mock.fn(() => 7);
  const pollAnimation = () => {};
  const { startPolling, getPollTimer } = loadPolling({ setInterval, clearInterval: mock.fn(), pollAnimation });

  startPolling();

  assert.strictEqual(setInterval.mock.callCount(), 1);
  assert.strictEqual(setInterval.mock.calls[0].arguments[0], pollAnimation);
  assert.strictEqual(setInterval.mock.calls[0].arguments[1], 1000);
  assert.strictEqual(getPollTimer(), 7);
});

test('stopPolling clears the active interval and resets the handle to null', () => {
  const setInterval = mock.fn(() => 42);
  const clearInterval = mock.fn();
  const { startPolling, stopPolling, getPollTimer } = loadPolling({ setInterval, clearInterval, pollAnimation: () => {} });

  startPolling();
  stopPolling();

  assert.strictEqual(clearInterval.mock.callCount(), 1);
  assert.strictEqual(clearInterval.mock.calls[0].arguments[0], 42);
  assert.strictEqual(getPollTimer(), null);
});

test('stopPolling is a no-op when no timer has ever been started, guarding against clearInterval(null)', () => {
  const clearInterval = mock.fn();
  const { stopPolling, getPollTimer } = loadPolling({ setInterval: mock.fn(), clearInterval, pollAnimation: () => {} });

  stopPolling();

  assert.strictEqual(clearInterval.mock.callCount(), 0);
  assert.strictEqual(getPollTimer(), null);
});
