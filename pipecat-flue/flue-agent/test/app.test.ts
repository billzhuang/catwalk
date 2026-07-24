import { test } from 'node:test';
import assert from 'node:assert/strict';
import app, { handleFlueEvent } from '../src/app.ts';

async function getAnimation(id: string) {
  const res = await app.request(`/animation/${id}`);
  return res.json();
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
  handleFlueEvent({ type: 'tool_start', toolName: 'show_math_animation', args: { topic: 'sine' } } as any);
  // Nothing to look up by — just proving it doesn't throw is the point here.
});

test('handleFlueEvent stores show_math_animation state keyed by conversationId', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-1',
    args: { topic: 'fourier_series', title: 'Fourier series', steps: ['step one', 'step two'] },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-1'), {
    topic: 'fourier_series',
    title: 'Fourier series',
    steps: ['step one', 'step two'],
    stepIndex: 0,
    revision: 1,
  });
});

test('handleFlueEvent stores state reachable by instanceId when conversationId is absent', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    instanceId: 'inst-app-1',
    args: { topic: 'sine' },
  } as any);
  const body = await getAnimation('inst-app-1');
  assert.equal(body.topic, 'sine');
  assert.equal(body.revision, 1);
});

test('handleFlueEvent applies control_math_animation to the stored step and bumps revision', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-2',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  } as any);
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'control_math_animation',
    conversationId: 'conv-app-2',
    args: { action: 'next' },
  } as any);
  const body = await getAnimation('conv-app-2');
  assert.equal(body.stepIndex, 1);
  assert.equal(body.revision, 2);
});

test('handleFlueEvent registers control_math_animation\'s fresh instanceId as a lookup alias, like show_math_animation does', async () => {
  // Mirrors state-map.test.ts's documented shape: a stable conversationId alongside a per-call
  // instanceId that's different on every tool call.
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-realias',
    instanceId: 'inst-app-realias-1',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  } as any);
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'control_math_animation',
    conversationId: 'conv-app-realias',
    instanceId: 'inst-app-realias-2',
    args: { action: 'next' },
  } as any);
  // The control call's own instanceId must be a valid lookup alias for the state it just
  // updated, exactly as show_math_animation's instanceId alias would be.
  const body = await getAnimation('inst-app-realias-2');
  assert.equal(body.topic, 'on_the_fly');
  assert.equal(body.stepIndex, 1);
  assert.equal(body.revision, 2);
});

test('handleFlueEvent no-ops control_math_animation when nothing was shown yet', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'control_math_animation',
    conversationId: 'conv-app-never-shown',
    args: { action: 'next' },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-never-shown'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent ignores show_math_animation with a non-string topic', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-bad-topic',
    args: { topic: 123 },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-bad-topic'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent no-ops control_math_animation when action is missing', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-no-action',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  } as any);
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'control_math_animation',
    conversationId: 'conv-app-no-action',
    args: {},
  } as any);
  const body = await getAnimation('conv-app-no-action');
  assert.equal(body.stepIndex, 0);
  assert.equal(body.revision, 1);
});

test('handleFlueEvent no-ops control_math_animation on a hand-built topic with no steps', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-no-steps',
    args: { topic: 'sine' },
  } as any);
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'control_math_animation',
    conversationId: 'conv-app-no-steps',
    args: { action: 'next' },
  } as any);
  const body = await getAnimation('conv-app-no-steps');
  assert.equal(body.stepIndex, 0);
  assert.equal(body.revision, 1);
});

test('handleFlueEvent skips storing a non-canonical topic missing title/steps (would 404 in the client)', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-unrenderable',
    args: { topic: 'fourier_series' },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-unrenderable'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a non-canonical topic with only a title, no steps', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-unrenderable-2',
    args: { topic: 'fourier_series', title: 'Fourier series' },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-unrenderable-2'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a whitespace-only title/steps (schema would reject it in run())', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-whitespace-only',
    args: { topic: 'fourier_series', title: '   ', steps: ['   ', '\t'] },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-whitespace-only'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing more than 6 steps (schema would reject it in run())', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-too-many-steps',
    args: {
      topic: 'fourier_series',
      title: 'Fourier series',
      steps: Array.from({ length: 7 }, (_, i) => `step ${i}`),
    },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-too-many-steps'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a title longer than 80 characters (schema would reject it in run())', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-long-title',
    args: { topic: 'fourier_series', title: 'a'.repeat(81), steps: ['step'] },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-long-title'), { topic: null, stepIndex: 0, revision: 0 });
});

test('handleFlueEvent skips storing a step longer than 65 characters (schema would reject it in run())', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-long-step',
    args: { topic: 'fourier_series', title: 'Fourier series', steps: ['a'.repeat(66)] },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-long-step'), { topic: null, stepIndex: 0, revision: 0 });
});

test('GET /animation/:id keeps an actively-polled conversation alive under sustained eviction pressure', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'show_math_animation',
    conversationId: 'conv-app-actively-viewed',
    args: { topic: 'on_the_fly', title: 'A topic', steps: ['a', 'b', 'c'] },
  } as any);

  // Simulate other conversations churning through the shared MAX_ANIMATION_ENTRIES=1000 cap
  // while the browser keeps polling our conversation every so often, exactly as it would while
  // an animation is still on screen and the student hasn't triggered another tool call.
  for (let i = 0; i < 1000; i++) {
    if (i % 50 === 0) await getAnimation('conv-app-actively-viewed');
    handleFlueEvent({
      type: 'tool_start',
      toolName: 'show_math_animation',
      conversationId: `conv-app-load-${i}`,
      args: { topic: 'sine' },
    } as any);
  }

  // Without the GET handler touching the entry on read, this conversation would be the
  // least-recently-touched one (its last write was before all the load traffic) and would have
  // been evicted long before the loop finished.
  const body = await getAnimation('conv-app-actively-viewed');
  assert.equal(body.topic, 'on_the_fly');
});

test('handleFlueEvent ignores an unrelated tool_start', async () => {
  handleFlueEvent({
    type: 'tool_start',
    toolName: 'get_weather',
    conversationId: 'conv-app-3',
    args: { place: 'Seattle' },
  } as any);
  assert.deepEqual(await getAnimation('conv-app-3'), { topic: null, stepIndex: 0, revision: 0 });
});
