// Characterization test for index.html's `pollAnimation`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// revision-gated dispatch to present() that the rest of the client's functions (buildAnimationSvgUrl,
// present, waitForIceGathering, ...) already have coverage for but pollAnimation itself never did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function loadPollAnimation({ fetchImpl, initialRevision = 0 }) {
  const presentCalls = [];
  const pollAnimation = extractFunctionWithDeps(html, 'pollAnimation', {
    fetch: fetchImpl,
    clientId: 'test-client-id',
    lastAnimationRevision: initialRevision,
    present: (...args) => presentCalls.push(args),
  });
  return { pollAnimation, presentCalls };
}

test('pollAnimation() fetches this tab\'s clientId and presents a new revision', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push([url, opts]);
    return { ok: true, json: async () => ({ topic: 'sine', title: 'Sine', steps: ['a'], stepIndex: 2, revision: 1 }) };
  };
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl });

  await pollAnimation();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], '/animation/test-client-id');
  assert.deepEqual(fetchCalls[0][1], { cache: 'no-store' });
  assert.deepEqual(presentCalls, [['sine', 'Sine', ['a'], 2]]);
});

test('pollAnimation() does not present again when the revision is unchanged', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ topic: 'sine', revision: 3 }) });
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl, initialRevision: 3 });

  await pollAnimation();

  assert.deepEqual(presentCalls, []);
});

test('pollAnimation() does not present when there is no topic yet', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ topic: null, revision: 0 }) });
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl });

  await pollAnimation();

  assert.deepEqual(presentCalls, []);
});

test('pollAnimation() does not present when the response is not ok', async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => { throw new Error('should not be read'); } });
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl });

  await pollAnimation();

  assert.deepEqual(presentCalls, []);
});

test('pollAnimation() swallows a rejected fetch instead of throwing', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl });

  await assert.doesNotReject(pollAnimation());
  assert.deepEqual(presentCalls, []);
});
