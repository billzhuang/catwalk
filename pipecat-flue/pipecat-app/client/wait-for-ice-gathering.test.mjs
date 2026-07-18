// Characterization test for index.html's `waitForIceGathering`, run with plain `node --test`
// (no bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// three branches that gate whether WebRTC connect() ever proceeds past ICE negotiation: the
// already-complete short-circuit, the listener-driven resolve (and its cleanup), and the 2500ms
// timeout fallback for a peer connection whose ICE gathering never completes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction } from './test-helpers.mjs';

const html = readClientHtml();
const waitForIceGathering = new Function(`return (${extractFunction(html, 'waitForIceGathering')});`)();

function fakePeerConnection(initialState) {
  const listeners = new Map();
  return {
    iceGatheringState: initialState,
    addEventListener: mock.fn((type, cb) => listeners.set(type, cb)),
    removeEventListener: mock.fn((type) => listeners.delete(type)),
    fireStateChange(state) {
      this.iceGatheringState = state;
      listeners.get('icegatheringstatechange')?.();
    },
  };
}

test('waitForIceGathering resolves immediately when already complete, without registering a listener', async () => {
  const pc = fakePeerConnection('complete');
  await waitForIceGathering(pc);
  assert.strictEqual(pc.addEventListener.mock.callCount(), 0);
});

test('waitForIceGathering resolves once gathering completes via the listener, and removes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = fakePeerConnection('new');
  const done = waitForIceGathering(pc);
  pc.fireStateChange('complete');
  await done;
  assert.strictEqual(pc.removeEventListener.mock.callCount(), 1);
  assert.deepStrictEqual(pc.removeEventListener.mock.calls[0].arguments, ['icegatheringstatechange', pc.addEventListener.mock.calls[0].arguments[1]]);
});

test('waitForIceGathering falls back to resolving after the 2500ms timeout if gathering never completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pc = fakePeerConnection('new');
  const done = waitForIceGathering(pc);
  t.mock.timers.tick(2500);
  await done;
  assert.strictEqual(pc.iceGatheringState, 'new');
});
