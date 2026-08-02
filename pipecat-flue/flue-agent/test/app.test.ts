import { test } from 'node:test';
import assert from 'node:assert/strict';
import app, { handleFlueEvent } from '../src/app.ts';

// Strips `epoch` (a per-process random id, not deterministic across test runs) so the many
// exact-shape assertions below don't need to know about it — see the dedicated epoch tests.
async function getAnimation(id: string) {
  const res = await app.request(`/animation/${id}`);
  const { epoch, ...body } = await res.json();
  return body;
}

/** Fires a `tool_start` observation at handleFlueEvent. Every test below needs one of these —
 *  differing only in toolName/conversationId/instanceId/args — so this is the one place that
 *  spells out the `{ type: 'tool_start', ... }` event shape instead of each test repeating it. */
function fireToolStart(fields: {
  toolName: string;
  conversationId?: string;
  instanceId?: string;
  args?: unknown;
}) {
  handleFlueEvent({ type: 'tool_start', ...fields } as any);
}

test('GET /health reports ok and a resolved model', async () => {
  const res = await app.request('/health');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.model, 'string');
});

test('GET /metrics reports the cache-rate shape', async () => {
  const res = await app.request('/metrics');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.calls, 'number');
  assert.equal(typeof body.cacheRate, 'number');
});

test('GET /animation/:id defaults to no topic when nothing was ever stored', async () => {
  const body = await getAnimation('never-seen-conversation');
  assert.deepEqual(body, { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent ignores events that are not tool_start', async () => {
  handleFlueEvent({ type: 'tool', toolName: 'show_math_animation', conversationId: 'ignored-1' } as any);
  assert.deepEqual(await getAnimation('ignored-1'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent ignores a tool_start with neither conversationId nor instanceId', () => {
  fireToolStart({ toolName: 'show_math_animation', args: { topic: 'sine' } });
  // Nothing to look up by — just proving it doesn't throw is the point here.
});

test('handleFlueEvent stores show_math_animation state keyed by conversationId', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-1',
    args: { topic: 'fourier_series', title: 'Fourier series', steps: ['step one', 'step two'] },
  });
  assert.deepEqual(await getAnimation('conv-app-1'), {
    topic: 'fourier_series',
    title: 'Fourier series',
    steps: ['step one', 'step two'],
    stepIndex: 0,
    revision: 1,
  });
});

test('handleFlueEvent stores state reachable by instanceId when conversationId is absent', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    instanceId: 'inst-app-1',
    args: { topic: 'sine' },
  });
  const body = await getAnimation('inst-app-1');
  assert.equal(body.topic, 'sine');
  assert.equal(body.revision, 1);
});

test('handleFlueEvent applies control_math_animation to the stored step and bumps revision', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-2',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-2',
    args: { action: 'next' },
  });
  const body = await getAnimation('conv-app-2');
  assert.equal(body.stepIndex, 1);
  assert.equal(body.revision, 2);
});

test('handleFlueEvent registers control_math_animation\'s fresh instanceId as a lookup alias, like show_math_animation does', async () => {
  // Mirrors state-map.test.ts's documented shape: a stable conversationId alongside a per-call
  // instanceId that's different on every tool call.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-realias',
    instanceId: 'inst-app-realias-1',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-realias',
    instanceId: 'inst-app-realias-2',
    args: { action: 'next' },
  });
  // The control call's own instanceId must be a valid lookup alias for the state it just
  // updated, exactly as show_math_animation's instanceId alias would be.
  const body = await getAnimation('inst-app-realias-2');
  assert.equal(body.topic, 'on_the_fly');
  assert.equal(body.stepIndex, 1);
  assert.equal(body.revision, 2);
});

test('handleFlueEvent no-ops control_math_animation when nothing was shown yet', async () => {
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-never-shown',
    args: { action: 'next' },
  });
  assert.deepEqual(await getAnimation('conv-app-never-shown'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent ignores show_math_animation with a non-string topic', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-bad-topic',
    args: { topic: 123 },
  });
  assert.deepEqual(await getAnimation('conv-app-bad-topic'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent no-ops control_math_animation when action is missing', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-no-action',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-no-action',
    args: {},
  });
  const body = await getAnimation('conv-app-no-action');
  assert.equal(body.stepIndex, 0);
  assert.equal(body.revision, 1);
});

test('handleFlueEvent no-ops control_math_animation when action is outside the tool\'s own picklist', async () => {
  // "restart" is a string, so a naive `typeof action === 'string'` check would accept it — but
  // the real control_math_animation tool call would fail its v.picklist(['next','previous',
  // 'repeat']) schema and never run. Revision must stay unbumped, same as the missing-action case
  // above, or the client would re-render off a call that never actually succeeded.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-bad-action',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-bad-action',
    args: { action: 'restart' },
  });
  const body = await getAnimation('conv-app-bad-action');
  assert.equal(body.stepIndex, 0);
  assert.equal(body.revision, 1);
});

test('handleFlueEvent no-ops control_math_animation on a hand-built topic with no steps', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-no-steps',
    args: { topic: 'sine' },
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-no-steps',
    args: { action: 'next' },
  });
  const body = await getAnimation('conv-app-no-steps');
  assert.equal(body.stepIndex, 0);
  assert.equal(body.revision, 1);
});

test('handleFlueEvent drops steps sent alongside a canonical topic, keeping control_math_animation a no-op', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-canonical-with-steps',
    args: { topic: 'sine', title: 'Sine wave', steps: ['a', 'b', 'c'] },
  });
  assert.deepEqual(await getAnimation('conv-app-canonical-with-steps'), {
    topic: 'sine',
    stepIndex: 0,
    revision: 1,
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-canonical-with-steps',
    args: { action: 'next' },
  });
  const body = await getAnimation('conv-app-canonical-with-steps');
  assert.equal(body.stepIndex, 0);
  assert.equal(body.revision, 1);
});

test('handleFlueEvent keeps title/steps for an on-the-fly topic that collides with an ALIASES synonym', async () => {
  // "triangle" is an ALIASES synonym for the hand-built "pythagoras" scene, but
  // bot/animations.py's render() lets a caller-supplied title+steps pair override that loose
  // synonym match and render the generic on-the-fly scene instead — so this content must survive
  // into stored state, unlike an exact canonical topic's incidental title/steps.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-alias-with-content',
    args: { topic: 'triangle', title: 'Triangle inequality', steps: ['a', 'b', 'c'] },
  });
  assert.deepEqual(await getAnimation('conv-app-alias-with-content'), {
    topic: 'triangle',
    title: 'Triangle inequality',
    steps: ['a', 'b', 'c'],
    stepIndex: 0,
    revision: 1,
  });
  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-alias-with-content',
    args: { action: 'next' },
  });
  const body = await getAnimation('conv-app-alias-with-content');
  assert.equal(body.stepIndex, 1);
  assert.equal(body.revision, 2);
});

test('handleFlueEvent drops a lone title/steps sent alongside an ALIASES synonym (render() ignores partial content)', async () => {
  // Only a title, no steps: bot/animations.py's render() requires BOTH to take the generic
  // path, so a lone title would be silently ignored there too — storing it would let
  // control_math_animation wrongly stay a no-op forever (no steps) while a stray title lingered.
  // Stored topic is the resolved canonical name ("pythagoras"), not the raw synonym
  // ("triangle") — see the next test for why.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-alias-partial-content',
    args: { topic: 'triangle', title: 'Triangle inequality' },
  });
  assert.deepEqual(await getAnimation('conv-app-alias-partial-content'), {
    topic: 'pythagoras',
    stepIndex: 0,
    revision: 1,
  });
});

test('handleFlueEvent stores the resolved canonical topic for an ALIASES synonym, not the raw synonym', async () => {
  // bot/animations.py's render() renders the pythagoras scene for "triangle" (an ALIASES
  // synonym), but the client's title fallback is `title || topic.replace(/_/g, " ")` — so
  // storing the raw synonym as `topic` would caption the pythagoras scene "triangle" instead of
  // naming the scene actually on screen.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-alias-canonical-name',
    args: { topic: 'triangle' },
  });
  assert.deepEqual(await getAnimation('conv-app-alias-canonical-name'), {
    topic: 'pythagoras',
    stepIndex: 0,
    revision: 1,
  });
});

test('handleFlueEvent skips storing a non-canonical topic missing title/steps (would 404 in the client)', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-unrenderable',
    args: { topic: 'fourier_series' },
  });
  assert.deepEqual(await getAnimation('conv-app-unrenderable'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a non-canonical topic with only a title, no steps', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-unrenderable-2',
    args: { topic: 'fourier_series', title: 'Fourier series' },
  });
  assert.deepEqual(await getAnimation('conv-app-unrenderable-2'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a whitespace-only title/steps (schema would reject it in run())', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-whitespace-only',
    args: { topic: 'fourier_series', title: '   ', steps: ['   ', '\t'] },
  });
  assert.deepEqual(await getAnimation('conv-app-whitespace-only'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing more than 6 steps (schema would reject it in run())', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-too-many-steps',
    args: {
      topic: 'fourier_series',
      title: 'Fourier series',
      steps: Array.from({ length: 7 }, (_, i) => `step ${i}`),
    },
  });
  assert.deepEqual(await getAnimation('conv-app-too-many-steps'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a title longer than 80 characters (schema would reject it in run())', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-long-title',
    args: { topic: 'fourier_series', title: 'a'.repeat(81), steps: ['step'] },
  });
  assert.deepEqual(await getAnimation('conv-app-long-title'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a step longer than 65 characters (schema would reject it in run())', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-long-step',
    args: { topic: 'fourier_series', title: 'Fourier series', steps: ['a'.repeat(66)] },
  });
  assert.deepEqual(await getAnimation('conv-app-long-step'), { topic: null, stepIndex: 0, revision: 0 });
});

test('GET /animation/:id keeps an actively-polled conversation alive under sustained eviction pressure', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-actively-viewed',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  });

  // Simulate other conversations churning through the shared MAX_ANIMATION_ENTRIES=1000 cap
  // while the browser keeps polling our conversation every so often, exactly as it would while
  // an animation is still on screen and the student hasn't triggered another tool call.
  for (let i = 0; i < 1000; i++) {
    if (i % 50 === 0) await getAnimation('conv-app-actively-viewed');
    fireToolStart({
      toolName: 'show_math_animation',
      conversationId: `conv-app-load-${i}`,
      args: { topic: 'sine' },
    });
  }

  // Without the GET handler touching the entry on read, this conversation would be the
  // least-recently-touched one (its last write was before all the load traffic) and would have
  // been evicted long before the loop finished.
  const body = await getAnimation('conv-app-actively-viewed');
  assert.equal(body.topic, 'on_the_fly');
});

test('handleFlueEvent ignores an unrelated tool_start', async () => {
  fireToolStart({
    toolName: 'get_weather',
    conversationId: 'conv-app-3',
    args: { place: 'Seattle' },
  });
  assert.deepEqual(await getAnimation('conv-app-3'), { topic: null, stepIndex: 0, revision: 0 });
});

test('GET /animation/:id includes a non-empty epoch that stays the same across repeated polls of one conversation', async () => {
  // animationState is in-memory only, so a flue-agent restart (or an idle conversation's entry
  // getting evicted under load — see the dedicated eviction/epoch test below) wipes a
  // conversation's entry, and the next entry for that same id starts revision back at 1 (see
  // nextRevision in state-map.ts) — indistinguishable, by revision alone, from that
  // conversation's very first animation. `epoch` is minted fresh per entry precisely so a client
  // can catch that case too, alongside revision — so absent any store in between, repeated polls
  // of the same, still-live entry return the exact same epoch every time.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-epoch-stable',
    args: { topic: 'sine' },
  });
  const first = await app.request('/animation/conv-app-epoch-stable');
  const firstBody = await first.json();
  const second = await app.request('/animation/conv-app-epoch-stable');
  const secondBody = await second.json();

  assert.equal(typeof firstBody.epoch, 'string');
  assert.notEqual(firstBody.epoch, '');
  assert.equal(firstBody.epoch, secondBody.epoch);
});

test('control_math_animation carries the existing entry\'s epoch forward across a step change', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-epoch-step',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  });
  const before = await app.request('/animation/conv-app-epoch-step');
  const beforeBody = await before.json();

  fireToolStart({
    toolName: 'control_math_animation',
    conversationId: 'conv-app-epoch-step',
    args: { action: 'next' },
  });
  const after = await app.request('/animation/conv-app-epoch-step');
  const afterBody = await after.json();

  assert.equal(afterBody.revision, beforeBody.revision + 1);
  // The client only needs revision to change here, not epoch — this is the same live entry,
  // just advancing a step, not a fresh-start it should re-fetch the whole SVG for from scratch.
  assert.equal(afterBody.epoch, beforeBody.epoch);
});

test('an idle conversation evicted then revived under the same id gets a different epoch, not just revision 1 again', async () => {
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-evict-revive',
    args: { topic: 'sine' },
  });
  const before = await app.request('/animation/conv-app-evict-revive');
  const beforeBody = await before.json();
  assert.equal(beforeBody.revision, 1);

  // Churn enough unrelated conversations through the shared MAX_ANIMATION_ENTRIES=1000 cap,
  // without ever polling conv-app-evict-revive (unlike the actively-polled test above), so it
  // becomes least-recently-touched and gets evicted — mirroring a browser tab that disconnected
  // and stopped polling while its animation was still the last thing shown. Since epoch is now
  // minted per-entry (not process-wide), none of this unrelated churn should perturb any other
  // conversation's own epoch — only conv-app-evict-revive's, once it's actually evicted and
  // revived below.
  for (let i = 0; i < 1200; i++) {
    fireToolStart({
      toolName: 'show_math_animation',
      conversationId: `conv-app-evict-revive-load-${i}`,
      args: { topic: 'sine' },
    });
  }

  // Revive: same conversation id, a genuinely new animation. Its old entry was evicted, so
  // nextRevision finds nothing stored under this id and starts back at 1 — indistinguishable,
  // by revision alone, from this conversation's very first animation.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-evict-revive',
    args: { topic: 'pythagoras' },
  });
  const after = await app.request('/animation/conv-app-evict-revive');
  const afterBody = await after.json();
  assert.equal(afterBody.revision, 1);
  assert.notEqual(afterBody.epoch, beforeBody.epoch);
});

test('evicting unrelated idle conversations does not change a third, untouched conversation\'s epoch', async () => {
  // Direct regression for the process-wide-epoch design this replaced: that version re-minted a
  // single epoch shared by every response on any eviction anywhere, so once the shared cap was
  // saturated, ordinary new-conversation traffic made every actively-viewed animation look "new"
  // to its client and needlessly re-fetch/restart, even though its own topic/revision never
  // changed. Scoping epoch per-entry means unrelated evictions must leave it alone.
  fireToolStart({
    toolName: 'show_math_animation',
    conversationId: 'conv-app-epoch-bystander',
    args: { topic: 'sine' },
  });
  const before = await app.request('/animation/conv-app-epoch-bystander');
  const beforeBody = await before.json();

  for (let i = 0; i < 1200; i++) {
    fireToolStart({
      toolName: 'show_math_animation',
      conversationId: `conv-app-epoch-bystander-load-${i}`,
      args: { topic: 'sine' },
    });
    if (i % 50 === 0) await app.request('/animation/conv-app-epoch-bystander'); // keep it alive
  }

  const after = await app.request('/animation/conv-app-epoch-bystander');
  const afterBody = await after.json();
  assert.equal(afterBody.revision, beforeBody.revision);
  assert.equal(afterBody.epoch, beforeBody.epoch);
});
