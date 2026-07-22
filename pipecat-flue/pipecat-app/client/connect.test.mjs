// Characterization test for index.html's `connect`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. connect()
// is the one top-level inline function left with zero test coverage: earlier refactors split its
// testable pieces out (buildOfferBody, handleConnectionStateChange) precisely so those didn't
// need a full RTCPeerConnection/getUserMedia mock, but connect() itself — the orchestration that
// wires them together — was never pinned. This test mocks the WebRTC/mic surface to do that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function makePeerConnection() {
  const dc = { onmessage: null };
  const calls = { createDataChannel: [], addTrack: [], setLocalDescription: [], setRemoteDescription: [] };
  const pc = {
    localDescription: { type: 'offer', sdp: 'local-sdp' },
    ontrack: null,
    onconnectionstatechange: null,
    createDataChannel: (label, opts) => {
      calls.createDataChannel.push([label, opts]);
      return dc;
    },
    addTrack: (track, stream) => calls.addTrack.push([track, stream]),
    createOffer: async () => ({ type: 'offer', sdp: 'fresh-offer' }),
    setLocalDescription: async (desc) => calls.setLocalDescription.push(desc),
    setRemoteDescription: async (desc) => calls.setRemoteDescription.push(desc),
  };
  return { pc, dc, calls };
}

function loadConnect({ getUserMedia, peerConnection, fetchImpl } = {}) {
  const { pc, dc, calls } = peerConnection ?? makePeerConnection();
  const micBtn = { disabled: false };
  const statusCalls = [];
  const teardownCalls = [];
  const waitForIceGatheringCalls = [];
  const buildOfferBodyCalls = [];
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
    waitForIceGathering: async (target) => waitForIceGatheringCalls.push(target),
    fetch: fetchImpl ?? (async () => ({ ok: true, json: async () => ({ type: 'answer', sdp: 'remote-sdp' }) })),
    buildOfferBody: (localDescription, clientId) => {
      buildOfferBodyCalls.push([localDescription, clientId]);
      return { sdp: localDescription, clientId };
    },
    clientId: 'client-123',
    teardown: (reason) => teardownCalls.push(reason),
  };
  deps.RTCPeerConnection.calls = [];
  const connect = extractFunctionWithDeps(html, 'connect', deps);
  return { connect, pc, dc, calls, micBtn, statusCalls, teardownCalls, waitForIceGatheringCalls, buildOfferBodyCalls, RTCPeerConnection: deps.RTCPeerConnection };
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
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push([url, opts]);
    return { ok: true, json: async () => ({ type: 'answer', sdp: 'remote-sdp' }) };
  };
  const { connect, pc, dc, calls, statusCalls, teardownCalls, waitForIceGatheringCalls, buildOfferBodyCalls, RTCPeerConnection } =
    loadConnect({ getUserMedia: async () => stream, fetchImpl });

  await connect();

  assert.deepEqual(RTCPeerConnection.calls, [{ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }]);
  assert.deepEqual(calls.createDataChannel, [['chat', { ordered: true }]]);
  assert.equal(typeof dc.onmessage, 'function');
  assert.deepEqual(calls.addTrack, [[track, stream]]);
  assert.equal(typeof pc.ontrack, 'function');
  assert.equal(typeof pc.onconnectionstatechange, 'function');
  assert.deepEqual(waitForIceGatheringCalls, [pc]);
  assert.deepEqual(buildOfferBodyCalls, [[pc.localDescription, 'client-123']]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], '/api/offer');
  assert.equal(fetchCalls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0][1].body), { sdp: pc.localDescription, clientId: 'client-123' });
  assert.deepEqual(calls.setRemoteDescription, [{ type: 'answer', sdp: 'remote-sdp' }]);
  assert.deepEqual(statusCalls, [['Requesting microphone…'], ['Connecting…'], ['Negotiating…']]);
  assert.deepEqual(teardownCalls, []);
});

test('connect(): a non-ok offer response tears down instead of negotiating', async () => {
  const { connect, teardownCalls, statusCalls } = loadConnect({
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });

  await connect();

  assert.deepEqual(teardownCalls, ['Could not connect']);
  assert.ok(!statusCalls.some(([text]) => text === 'Negotiating…'));
});

test('connect(): a setRemoteDescription rejection tears down instead of negotiating', async () => {
  const peerConnection = makePeerConnection();
  peerConnection.pc.setRemoteDescription = async () => { throw new Error('setRemoteDescription failed'); };
  const { connect, teardownCalls, statusCalls } = loadConnect({ peerConnection });

  await connect();

  assert.deepEqual(teardownCalls, ['Could not connect']);
  assert.ok(!statusCalls.some(([text]) => text === 'Negotiating…'));
});
