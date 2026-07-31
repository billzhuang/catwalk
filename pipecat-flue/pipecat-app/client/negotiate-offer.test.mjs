// Characterization test for index.html's `negotiateOffer`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// offer/answer exchange split out of connect(): publishing a fresh local offer, waiting for ICE
// gathering, POSTing to the server, and applying the answer — including the non-ok-response and
// setRemoteDescription-rejection failure paths that connect() relies on to trigger its own
// teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function loadNegotiateOffer({ fetchImpl, setRemoteDescription } = {}) {
  const calls = { setLocalDescription: [], setRemoteDescription: [] };
  const waitForIceGatheringCalls = [];
  const buildOfferBodyCalls = [];
  const fetchCalls = [];
  const pc = {
    localDescription: { type: 'offer', sdp: 'local-sdp' },
    createOffer: async () => ({ type: 'offer', sdp: 'fresh-offer' }),
    setLocalDescription: async (desc) => calls.setLocalDescription.push(desc),
    setRemoteDescription: setRemoteDescription ?? (async (desc) => calls.setRemoteDescription.push(desc)),
  };
  const deps = {
    waitForIceGathering: async (target) => waitForIceGatheringCalls.push(target),
    fetch: fetchImpl ?? (async (url, opts) => {
      fetchCalls.push([url, opts]);
      return { ok: true, json: async () => ({ type: 'answer', sdp: 'remote-sdp' }) };
    }),
    buildOfferBody: (localDescription, clientId) => {
      buildOfferBodyCalls.push([localDescription, clientId]);
      return { sdp: localDescription, clientId };
    },
    clientId: 'client-123',
  };
  const negotiateOffer = extractFunctionWithDeps(html, 'negotiateOffer', deps);
  return { negotiateOffer, pc, calls, waitForIceGatheringCalls, buildOfferBodyCalls, fetchCalls };
}

test('negotiateOffer publishes a fresh local offer, waits for ICE gathering, then posts and applies the answer', async () => {
  const { negotiateOffer, pc, calls, waitForIceGatheringCalls, buildOfferBodyCalls, fetchCalls } = loadNegotiateOffer();

  await negotiateOffer(pc);

  assert.deepEqual(calls.setLocalDescription, [{ type: 'offer', sdp: 'fresh-offer' }]);
  assert.deepEqual(waitForIceGatheringCalls, [pc]);
  assert.deepEqual(buildOfferBodyCalls, [[pc.localDescription, 'client-123']]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], '/api/offer');
  assert.equal(fetchCalls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0][1].body), { sdp: pc.localDescription, clientId: 'client-123' });
  assert.deepEqual(calls.setRemoteDescription, [{ type: 'answer', sdp: 'remote-sdp' }]);
});

test('negotiateOffer throws on a non-ok offer response instead of applying a remote description', async () => {
  const { negotiateOffer, pc, calls } = loadNegotiateOffer({
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });

  await assert.rejects(() => negotiateOffer(pc), /offer HTTP/);
  assert.deepEqual(calls.setRemoteDescription, []);
});

test('negotiateOffer propagates a setRemoteDescription rejection instead of swallowing it', async () => {
  const { negotiateOffer, pc } = loadNegotiateOffer({
    setRemoteDescription: async () => { throw new Error('setRemoteDescription failed'); },
  });

  await assert.rejects(() => negotiateOffer(pc), /setRemoteDescription failed/);
});
