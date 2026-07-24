// Characterization test for index.html's `pollAnimation`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// revision-gated dispatch to present() that the rest of the client's functions (buildAnimationSvgUrl,
// present, waitForIceGathering, ...) already have coverage for but pollAnimation itself never did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps } from './test-helpers.mjs';

const html = readClientHtml();

function loadPollAnimation({ fetchImpl, initialRevision = 0, presentResults = [true] }) {
  const presentCalls = [];
  // Default to simulating a successful render (matching production's `return true`), so tests
  // that don't care about present()'s outcome aren't tripped up by the retry-on-failure logic.
  // presentResults is consumed one value per call; the last value repeats once exhausted.
  const present = async (...args) => {
    presentCalls.push(args);
    return presentResults[Math.min(presentCalls.length - 1, presentResults.length - 1)];
  };
  const pollAnimation = extractFunctionWithDeps(html, 'pollAnimation', {
    fetch: fetchImpl,
    clientId: 'test-client-id',
    lastAnimationRevision: initialRevision,
    pollRequestSeq: 0,
    latestAppliedPollSeq: 0,
    present,
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
  assert.deepEqual(presentCalls, [['sine', 'Sine', ['a'], 2, 1]]);

  // A consecutive poll with the same revision must not present again — proves
  // pollAnimation's own `lastAnimationRevision = data.revision` assignment stuck,
  // not just that a preset initialRevision happened to match.
  await pollAnimation();
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(presentCalls, [['sine', 'Sine', ['a'], 2, 1]]);
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

test('pollAnimation() discards a late response from an earlier poll once a later poll has already applied', async () => {
  // setInterval fires the next tick without waiting for the previous one's fetch, so an
  // earlier-issued request's response can resolve after a later-issued one's.
  const resolvers = [];
  const fetchImpl = () => new Promise((resolve) => resolvers.push(resolve));
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl });

  const firstPoll = pollAnimation();  // seq 1, issued first
  const secondPoll = pollAnimation(); // seq 2, issued second

  // The second (later) request's response arrives first.
  resolvers[1]({ ok: true, json: async () => ({ topic: 'sine', revision: 2 }) });
  await secondPoll;
  assert.deepEqual(presentCalls, [['sine', undefined, undefined, undefined, 2]]);

  // The first (earlier) request's response arrives late — it must not roll state backward.
  resolvers[0]({ ok: true, json: async () => ({ topic: 'sine', revision: 1 }) });
  await firstPoll;
  assert.deepEqual(presentCalls, [['sine', undefined, undefined, undefined, 2]]);
});

test('pollAnimation() retries a revision on the next tick when present() fails to render it', async () => {
  // Without the fix, pollAnimation commits `lastAnimationRevision = data.revision` before
  // present() resolves, so a transient present() failure (dropped fetch, non-2xx) leaves that
  // revision permanently marked "seen" — the student's screen sticks with nothing on-screen and
  // no later tick ever retries it, since the server's revision never changes on its own.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ topic: 'sine', revision: 7 }) });
  const { pollAnimation, presentCalls } = loadPollAnimation({ fetchImpl, presentResults: [false] });

  await pollAnimation();
  assert.deepEqual(presentCalls, [['sine', undefined, undefined, undefined, 7]]);

  // Same revision, still failing to render — must retry, not silently give up forever.
  await pollAnimation();
  assert.deepEqual(presentCalls, [
    ['sine', undefined, undefined, undefined, 7],
    ['sine', undefined, undefined, undefined, 7],
  ]);
});

test('pollAnimation() does not roll back a newer revision when an older, concurrent present() call later fails', async () => {
  // A stale present(7) call can still be in flight (awaited inside its own pollAnimation
  // invocation) when a later poll tick sees a newer revision 8, commits it, and successfully
  // presents it. When the stale present(7) call finally resolves with failure, its rollback check
  // must compare against the *current* lastAnimationRevision (8) — not blindly reset it to 0 —
  // or it would wrongly erase the newer, already-rendered revision's "seen" state.
  const fetchResolvers = [];
  const fetchImpl = () => new Promise((resolve) => fetchResolvers.push(resolve));
  const presentResolvers = [];
  const presentCalls = [];
  const present = (...args) =>
    new Promise((resolve) => {
      presentCalls.push(args);
      presentResolvers.push(resolve);
    });
  const pollAnimation = extractFunctionWithDeps(html, 'pollAnimation', {
    fetch: fetchImpl,
    clientId: 'test-client-id',
    lastAnimationRevision: 0,
    pollRequestSeq: 0,
    latestAppliedPollSeq: 0,
    present,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const firstPoll = pollAnimation(); // will land on revision 7
  fetchResolvers[0]({ ok: true, json: async () => ({ topic: 'sine', revision: 7 }) });
  await flush(); // let pollAnimation reach its `await present(...)` for revision 7, without resolving it

  const secondPoll = pollAnimation(); // a later, newer poll: revision 8
  fetchResolvers[1]({ ok: true, json: async () => ({ topic: 'sine', revision: 8 }) });
  await flush();
  presentResolvers[1](true); // present(8) succeeds
  await secondPoll;

  presentResolvers[0](false); // the stale present(7) call finally fails
  await firstPoll;

  assert.deepEqual(presentCalls, [
    ['sine', undefined, undefined, undefined, 7],
    ['sine', undefined, undefined, undefined, 8],
  ]);

  // A further poll still reporting the current revision (8, unchanged) must not re-present — if
  // the failed present(7) had wrongly reset state to 0, this would incorrectly retrigger present().
  const thirdPoll = pollAnimation();
  fetchResolvers[2]({ ok: true, json: async () => ({ topic: 'sine', revision: 8 }) });
  await thirdPoll;
  assert.equal(presentCalls.length, 2);
});
