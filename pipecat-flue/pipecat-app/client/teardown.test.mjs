// Characterization test for index.html's `teardown`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// reason-to-status-class mapping and the pc/dc teardown that the rest of the client's inline
// functions (present, pollAnimation, exitPresentation, ...) already have coverage for but
// teardown() itself never did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function makeClassList(initial = []) {
  const classes = new Set(initial);
  return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) };
}

function loadTeardown({ pc = null, localStream = null } = {}) {
  const statusCalls = [];
  const stopPollingCalls = [];
  const micWrap = { classList: makeClassList(['connected']) };
  const micBtn = { classList: makeClassList(['live']), textContent: 'Listening…', disabled: true };
  // The real setMicUI, bound to this test's own micWrap/micBtn mocks, so the assertions below
  // still observe teardown's actual end state rather than a mocked call.
  const setMicUI = extractFunctionWithDeps(html, 'setMicUI', { micWrap, micBtn });
  const deps = {
    connected: true,
    stopPolling: () => stopPollingCalls.push([]),
    setMicUI,
    setStatus: (...args) => statusCalls.push(args),
    pc,
    dc: {},
    localStream,
  };
  const teardown = extractFunctionWithDeps(html, 'teardown', deps);
  return { teardown, deps, statusCalls, stopPollingCalls, micWrap, micBtn };
}

test('teardown() with no reason resets UI to the default disconnected state', () => {
  const { teardown, statusCalls, stopPollingCalls, micWrap, micBtn } = loadTeardown();

  teardown();

  assert.equal(stopPollingCalls.length, 1);
  assert.ok(!micWrap.classList.has('connected'));
  assert.ok(!micBtn.classList.has('live'));
  assert.equal(micBtn.textContent, 'Connect');
  assert.equal(micBtn.disabled, false);
  assert.deepEqual(statusCalls, [['Not connected', '']]);
});

test('teardown("Disconnected") sets plain status without the error class', () => {
  const { teardown, statusCalls } = loadTeardown();

  teardown('Disconnected');

  assert.deepEqual(statusCalls, [['Disconnected', '']]);
});

test('teardown("Connection failed") sets the error status class', () => {
  const { teardown, statusCalls } = loadTeardown();

  teardown('Connection failed');

  assert.deepEqual(statusCalls, [['Connection failed', 'err']]);
});

test('teardown() closes an existing peer connection and nulls it out', () => {
  let closeCalls = 0;
  const pc = { close: () => { closeCalls++; } };
  const { teardown } = loadTeardown({ pc });

  teardown('Disconnected');
  assert.equal(closeCalls, 1);

  // extractFunctionWithDeps binds pc as a closure variable shared across calls to this same
  // teardown reference (unlike the deps object, which is never itself mutated) — so calling the
  // *same* closure again is what actually observes `pc = null` sticking: a second call must not
  // invoke close() again, since the guard `if (pc)` should now be false.
  teardown('Disconnected');
  assert.equal(closeCalls, 1);
});

test('teardown() swallows a throwing pc.close() instead of propagating it', () => {
  const pc = { close: () => { throw new Error('already closed'); } };
  const { teardown } = loadTeardown({ pc });

  assert.doesNotThrow(() => teardown('Disconnected'));
});

test('teardown() is a no-op on pc when there is no peer connection', () => {
  const { teardown } = loadTeardown({ pc: null });

  assert.doesNotThrow(() => teardown());
});

// pc.close() does not stop locally-captured getUserMedia tracks added via addTrack — without an
// explicit t.stop() per track, the mic device stays acquired (browser recording indicator stays
// lit) after disconnect. These pin that teardown() actually stops them.
test('teardown() stops every track on the local media stream and clears it', () => {
  const stopCalls = [];
  const track1 = { stop: () => stopCalls.push('t1') };
  const track2 = { stop: () => stopCalls.push('t2') };
  const localStream = { getTracks: () => [track1, track2] };
  const { teardown } = loadTeardown({ localStream });

  teardown('Disconnected');
  assert.deepEqual(stopCalls, ['t1', 't2']);

  // extractFunctionWithDeps binds localStream as a closure variable shared across calls to this
  // same teardown reference (same pattern the existing pc test above relies on) — a second call
  // must not stop the same tracks again, since the guard `if (localStream)` should now be false.
  teardown('Disconnected');
  assert.deepEqual(stopCalls, ['t1', 't2']);
});

test('teardown() swallows a throwing track.stop() instead of propagating it', () => {
  const localStream = { getTracks: () => [{ stop: () => { throw new Error('already stopped'); } }] };
  const { teardown } = loadTeardown({ localStream });

  assert.doesNotThrow(() => teardown('Disconnected'));
});

test('teardown() still stops later tracks after an earlier one throws', () => {
  const stopCalls = [];
  const throwing = { stop: () => { stopCalls.push('bad'); throw new Error('already stopped'); } };
  const track2 = { stop: () => stopCalls.push('t2') };
  const localStream = { getTracks: () => [throwing, track2] };
  const { teardown } = loadTeardown({ localStream });

  teardown('Disconnected');

  assert.deepEqual(stopCalls, ['bad', 't2']);
});

test('teardown() is a no-op on the local stream when there is none', () => {
  const { teardown } = loadTeardown({ localStream: null });

  assert.doesNotThrow(() => teardown());
});
