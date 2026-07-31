// Characterization test for index.html's `connect`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. connect()
// wires up a fresh RTCPeerConnection (data channel, tracks, ontrack/onconnectionstatechange) and
// then delegates the offer/answer exchange to negotiateOffer (pinned by its own test file,
// mocked here) — this test exercises the wiring and orchestration, not the negotiation
// round-trip's internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function makePeerConnection() {
  const dc = { onmessage: null };
  const calls = { createDataChannel: [], addTrack: [] };
  const pc = {
    ontrack: null,
    onconnectionstatechange: null,
    createDataChannel: (label, opts) => {
      calls.createDataChannel.push([label, opts]);
      return dc;
    },
    addTrack: (track, stream) => calls.addTrack.push([track, stream]),
  };
  return { pc, dc, calls };
}

function loadConnect({ getUserMedia, peerConnection, negotiateOffer, remoteAudio } = {}) {
  const { pc, dc, calls } = peerConnection ?? makePeerConnection();
  const micBtn = { disabled: false };
  const statusCalls = [];
  const teardownCalls = [];
  const negotiateOfferCalls = [];
  const deps = {
    pc: undefined,
    dc: undefined,
    localStream: undefined,
    micBtn,
    setStatus: (...args) => statusCalls.push(args),
    navigator: { mediaDevices: { getUserMedia: getUserMedia ?? (async () => ({ getTracks: () => [] })) } },
    RTCPeerConnection: function RTCPeerConnectionMock(config) {
      RTCPeerConnectionMock.calls.push(config);
      return pc;
    },
    handleDataChannelMessage: () => {},
    handleConnectionStateChange: () => {},
    negotiateOffer: negotiateOffer ?? (async (target) => negotiateOfferCalls.push(target)),
    teardown: (reason) => teardownCalls.push(reason),
    remoteAudio: remoteAudio ?? { srcObject: null, play: () => Promise.resolve() },
  };
  deps.RTCPeerConnection.calls = [];
  const connect = extractFunctionWithDeps(html, 'connect', deps);
  return { connect, pc, dc, calls, micBtn, statusCalls, teardownCalls, negotiateOfferCalls, RTCPeerConnection: deps.RTCPeerConnection, remoteAudio: deps.remoteAudio };
}

test('connect(): mic permission denied sets an error status, re-enables the button, and never creates a peer connection', async () => {
  const { connect, micBtn, statusCalls, RTCPeerConnection } = loadConnect({
    getUserMedia: async () => { throw new Error('NotAllowedError'); },
  });

  await connect();

  assert.deepEqual(statusCalls, [['Requesting microphone…'], ['Microphone permission denied', 'err']]);
  assert.equal(micBtn.disabled, false);
  assert.equal(RTCPeerConnection.calls.length, 0);
});

test('connect(): disables the mic button immediately, before microphone permission resolves', async () => {
  const { connect, micBtn } = loadConnect({
    getUserMedia: async () => {
      assert.equal(micBtn.disabled, true, 'button must already be disabled while getUserMedia is pending');
      return { getTracks: () => [] };
    },
  });

  await connect();
});

test('connect(): happy path creates the data channel before the offer, wires track/state handlers, and negotiates', async () => {
  const track = { id: 't1' };
  const stream = { getTracks: () => [track] };
  const { connect, pc, dc, calls, statusCalls, teardownCalls, negotiateOfferCalls, RTCPeerConnection, remoteAudio } =
    loadConnect({ getUserMedia: async () => stream });

  await connect();

  assert.deepEqual(RTCPeerConnection.calls, [{ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }]);
  assert.deepEqual(calls.createDataChannel, [['chat', { ordered: true }]]);
  assert.equal(typeof dc.onmessage, 'function');
  assert.deepEqual(calls.addTrack, [[track, stream]]);
  assert.equal(typeof pc.ontrack, 'function');
  const remoteStream = { id: 'remote-stream' };
  pc.ontrack({ streams: [remoteStream] });
  assert.equal(remoteAudio.srcObject, remoteStream);
  assert.equal(typeof pc.onconnectionstatechange, 'function');
  assert.deepEqual(negotiateOfferCalls, [pc]);
  assert.deepEqual(statusCalls, [['Requesting microphone…'], ['Connecting…'], ['Negotiating…']]);
  assert.deepEqual(teardownCalls, []);
});

test('connect(): pc.ontrack swallows a rejected remoteAudio.play() instead of throwing', async () => {
  const remoteAudio = { srcObject: null, play: () => Promise.reject(new Error('autoplay blocked')) };
  const { connect, pc } = loadConnect({ remoteAudio });

  await connect();

  assert.doesNotThrow(() => pc.ontrack({ streams: [{ id: 'remote-stream' }] }));
});

test('connect(): a negotiateOffer rejection tears down instead of reaching "Negotiating…"', async () => {
  const { connect, teardownCalls, statusCalls } = loadConnect({
    negotiateOffer: async () => { throw new Error('offer HTTP 500'); },
  });

  await connect();

  assert.deepEqual(teardownCalls, ['Could not connect']);
  assert.ok(!statusCalls.some(([text]) => text === 'Negotiating…'));
});

test('connect(): a reconnect drops a stale onconnectionstatechange event from the superseded connection, but still forwards the live connection\'s own events', async () => {
  // extractFunctionWithDeps binds `pc` as a closure variable shared across calls to this same
  // connect reference (same pattern teardown.test.mjs relies on) — calling connect() a second
  // time reassigns that shared binding to a new RTCPeerConnection while the first connection's
  // onconnectionstatechange handler is still registered and can still fire. Merely reading the
  // right connection's state isn't enough here: handleConnectionStateChange's "failed"/"closed"
  // branches call the shared teardown(), which would tear down the new, currently-live connection
  // if a stale event from the old one were still forwarded — so the handler must drop it outright
  // once its connection has been superseded, not just report its state accurately.
  const first = makePeerConnection();
  const second = makePeerConnection();
  const peerConnections = [first, second];
  let callIndex = 0;
  const stateChangeCalls = [];
  const micBtn = { disabled: false };
  const deps = {
    pc: undefined, dc: undefined, localStream: undefined, micBtn,
    setStatus: () => {},
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    RTCPeerConnection: function () { return peerConnections[callIndex++].pc; },
    handleDataChannelMessage: () => {},
    handleConnectionStateChange: (state) => stateChangeCalls.push(state),
    negotiateOffer: async () => {},
    teardown: () => {},
    remoteAudio: { srcObject: null, play: () => Promise.resolve() },
  };
  const connect = extractFunctionWithDeps(html, 'connect', deps);

  await connect();
  const staleHandler = first.pc.onconnectionstatechange;
  first.pc.connectionState = 'failed';

  await connect();
  const liveHandler = second.pc.onconnectionstatechange;
  second.pc.connectionState = 'connected';

  // A queued event from the discarded first connection arrives after the reconnect — it must be
  // dropped entirely, not forwarded with the (now merely accurate) 'failed' state.
  staleHandler();
  assert.deepEqual(stateChangeCalls, []);

  // The current connection's own event still reaches the handler normally.
  liveHandler();
  assert.deepEqual(stateChangeCalls, ['connected']);
});

test('connect(): a synchronous addTrack throw tears down instead of leaving the mic button disabled forever', async () => {
  // addTrack can throw synchronously (e.g. InvalidStateError on an already-ended track) — this
  // sits before negotiateOffer runs, so an uncaught throw here left micBtn disabled and the
  // status stuck at "Connecting…" with no teardown, since connect() is invoked fire-and-forget
  // from the click handler with no .catch() of its own.
  const peerConnection = makePeerConnection();
  peerConnection.pc.addTrack = () => { throw new Error('InvalidStateError'); };
  const stream = { getTracks: () => [{ id: 't1' }] };
  const { connect, teardownCalls, statusCalls } = loadConnect({
    peerConnection,
    getUserMedia: async () => stream,
  });

  await connect();

  assert.deepEqual(teardownCalls, ['Could not connect']);
  assert.ok(!statusCalls.some(([text]) => text === 'Negotiating…'));
});
