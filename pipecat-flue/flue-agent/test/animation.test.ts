import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import {
  ANIMATION_TOPICS,
  ANIMATION_INSTRUCTIONS,
  showMathAnimation,
  controlMathAnimation,
  applyAnimationControl,
  storeWithEviction,
  findByAnyKey,
  nextRevision,
  parseShowMathAnimationArgs,
  parseControlAction,
} from '../src/animation.ts';

test('animation instructions require a comprehension check after showing the animation', () => {
  assert.match(ANIMATION_INSTRUCTIONS, /check they actually understood it/);
  assert.match(ANIMATION_INSTRUCTIONS, /apply the\n  specific concept just shown to a new case/);
  assert.ok(
    ANIMATION_INSTRUCTIONS.indexOf('keep speaking naturally') <
      ANIMATION_INSTRUCTIONS.indexOf('check they actually understood it'),
    'comprehension check comes after the spoken explanation guidance',
  );
});

test('hand-built topics run without title/steps', async () => {
  for (const topic of ANIMATION_TOPICS) {
    const result = await showMathAnimation.run({ input: v.parse(showMathAnimation.input, { topic }) });
    assert.deepEqual(result, { topic, shown: true });
  }
});

test('a hand-built topic name that only differs by case/whitespace/dash still runs without title/steps', async () => {
  // bot/animations.py's render() matches SCENES via _normalize_exact (case/whitespace/dash
  // insensitive) before ever looking at title/steps — so if flue required title/steps for
  // "Pythagoras" (finding it non-canonical) while pipecat still routes it to the pinned
  // hand-built scene, the model's title/steps would be silently discarded. Canonical
  // detection here must use the same normalization so both sides agree on what's canonical.
  const input = v.parse(showMathAnimation.input, { topic: 'Pythagoras' });
  const result = await showMathAnimation.run({ input });
  assert.deepEqual(result, { topic: 'Pythagoras', shown: true });
});

test('a loose synonym for a hand-built topic runs without title/steps', async () => {
  // bot/animations.py's ALIASES maps synonyms like "cosine"/"triangle" to a hand-built SCENES
  // entry, but only when render() gets no title/steps (its own doc comment: "a spoken/loosely-
  // worded topic can still hit a hand-built scene"). Since this tool's run() previously required
  // title/steps for any non-exact-canonical topic, the model could never actually produce a call
  // that reaches that fallback — every alias was forced through title/steps, which pipecat's
  // render() always prefers, making the alias lookup unreachable dead code in production.
  for (const alias of ['cosine', 'triangle', 'calculus', 'vector']) {
    const input = v.parse(showMathAnimation.input, { topic: alias });
    const result = await showMathAnimation.run({ input });
    assert.deepEqual(result, { topic: alias, shown: true });
  }
});

test('on-the-fly topic with title and steps runs and echoes the topic', async () => {
  const input = v.parse(showMathAnimation.input, {
    topic: 'fourier_series',
    title: 'Fourier series',
    steps: ['A periodic signal is a sum of sines', 'Each term adds a harmonic'],
  });
  const result = await showMathAnimation.run({ input });
  assert.deepEqual(result, { topic: 'fourier_series', shown: true });
});

test('on-the-fly topic without title rejects', async () => {
  const input = v.parse(showMathAnimation.input, {
    topic: 'fourier_series',
    steps: ['a step'],
  });
  await assert.rejects(async () => { await showMathAnimation.run({ input }); });
});

test('on-the-fly topic without steps rejects', async () => {
  const input = v.parse(showMathAnimation.input, {
    topic: 'fourier_series',
    title: 'Fourier series',
  });
  await assert.rejects(async () => { await showMathAnimation.run({ input }); });
});

test('schema rejects more than 6 steps', () => {
  assert.throws(() =>
    v.parse(showMathAnimation.input, {
      topic: 'fourier_series',
      title: 'Fourier series',
      steps: Array.from({ length: 7 }, (_, i) => `step ${i}`),
    }),
  );
});

test('schema rejects an empty topic', () => {
  assert.throws(() => v.parse(showMathAnimation.input, { topic: '' }));
});

test('control_math_animation echoes a valid action', async () => {
  for (const action of ['next', 'previous', 'repeat']) {
    const input = v.parse(controlMathAnimation.input, { action });
    const result = await controlMathAnimation.run({ input });
    assert.deepEqual(result, { action });
  }
});

test('control_math_animation schema rejects an unknown action', () => {
  assert.throws(() => v.parse(controlMathAnimation.input, { action: 'pause' }));
});

test('applyAnimationControl advances, clamped to the last step', () => {
  assert.equal(applyAnimationControl(0, 3, 'next'), 1);
  assert.equal(applyAnimationControl(2, 3, 'next'), 2); // already at the last step
});

test('applyAnimationControl goes back, clamped to the first step', () => {
  assert.equal(applyAnimationControl(1, 3, 'previous'), 0);
  assert.equal(applyAnimationControl(0, 3, 'previous'), 0); // already at the first step
});

test('applyAnimationControl leaves the index unchanged on repeat', () => {
  assert.equal(applyAnimationControl(1, 3, 'repeat'), 1);
});

test('storeWithEviction stores under every key while under the cap', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a', 'b'], value: 'one' }, 10);
  assert.equal(map.get('a')?.value, 'one');
  assert.equal(map.get('b')?.value, 'one');
  assert.equal(map.size, 2);
});

test('storeWithEviction evicts the least-recently-touched entry once at capacity', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['b'], value: 'second' }, 2);
  // Map is now at its cap of 2; storing a third entry must evict "a" (never touched again).
  storeWithEviction(map, { keys: ['c'], value: 'third' }, 2);
  assert.equal(map.get('a'), undefined);
  assert.equal(map.get('b')?.value, 'second');
  assert.equal(map.get('c')?.value, 'third');
});

test('storeWithEviction refreshes LRU position on update, so a re-touched entry survives', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['b'], value: 'second' }, 2);
  // Re-touch "a" (e.g. a control_math_animation step change) — it should no longer be oldest.
  storeWithEviction(map, { keys: ['a'], value: 'first-updated' }, 2);
  storeWithEviction(map, { keys: ['c'], value: 'third' }, 2);
  assert.equal(map.get('a')?.value, 'first-updated'); // survived: was refreshed, not oldest
  assert.equal(map.get('b'), undefined); // evicted: now the least-recently-touched
  assert.equal(map.get('c')?.value, 'third');
});

test('parseShowMathAnimationArgs parses a hand-built topic with no title/steps', () => {
  assert.deepEqual(parseShowMathAnimationArgs({ topic: 'sine' }), {
    topic: 'sine',
    title: undefined,
    steps: undefined,
  });
});

test('parseShowMathAnimationArgs parses an on-the-fly topic with title and steps', () => {
  assert.deepEqual(
    parseShowMathAnimationArgs({ topic: 'fourier_series', title: 'Fourier series', steps: ['a', 'b'] }),
    { topic: 'fourier_series', title: 'Fourier series', steps: ['a', 'b'] },
  );
});

test('parseShowMathAnimationArgs filters non-string entries out of steps', () => {
  assert.deepEqual(parseShowMathAnimationArgs({ topic: 'sine', steps: ['a', 42, 'b', null] }), {
    topic: 'sine',
    title: undefined,
    steps: ['a', 'b'],
  });
});

test('parseShowMathAnimationArgs drops a non-string title rather than throwing', () => {
  assert.deepEqual(parseShowMathAnimationArgs({ topic: 'sine', title: 42 }), {
    topic: 'sine',
    title: undefined,
    steps: undefined,
  });
});

test('parseShowMathAnimationArgs drops a non-array steps rather than throwing', () => {
  assert.deepEqual(parseShowMathAnimationArgs({ topic: 'sine', steps: 'not an array' }), {
    topic: 'sine',
    title: undefined,
    steps: undefined,
  });
});

test('parseShowMathAnimationArgs returns undefined when topic is missing or not a string', () => {
  assert.equal(parseShowMathAnimationArgs(undefined), undefined);
  assert.equal(parseShowMathAnimationArgs({}), undefined);
  assert.equal(parseShowMathAnimationArgs({ topic: 42 }), undefined);
});

test('parseControlAction returns the action when it is a string', () => {
  assert.equal(parseControlAction({ action: 'next' }), 'next');
});

test('parseControlAction returns undefined when action is missing or not a string', () => {
  assert.equal(parseControlAction(undefined), undefined);
  assert.equal(parseControlAction({}), undefined);
  assert.equal(parseControlAction({ action: 7 }), undefined);
});

test('findByAnyKey returns undefined when none of the keys are stored', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  assert.equal(findByAnyKey(map, ['conv-1', 'inst-1']), undefined);
});

test('findByAnyKey finds the entry under whichever alias key hits first', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['conv-1', 'inst-1'], value: 'stored' }, 10);
  assert.equal(findByAnyKey(map, ['conv-1', 'inst-1'])?.value, 'stored');
  // Only instanceId is known this time (e.g. conversationId wasn't set on this event).
  assert.equal(findByAnyKey(map, ['unknown-conv', 'inst-1'])?.value, 'stored');
});

test('nextRevision is 1 when none of the keys have a stored revision yet', () => {
  const map = new Map<string, { revision: number }>();
  assert.equal(nextRevision(map, ['conv-1', 'inst-1']), 1);
});

test('nextRevision is one past the highest revision found among any alias key', () => {
  const map = new Map<string, { revision: number }>();
  map.set('conv-1', { revision: 3 });
  map.set('inst-1', { revision: 5 }); // mismatched alias with a higher revision
  assert.equal(nextRevision(map, ['conv-1', 'inst-1']), 6);
});

test('storeWithEviction deletes every alias key of the evicted entry', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['conv-1', 'inst-1'], value: 'first' }, 1);
  storeWithEviction(map, { keys: ['conv-2'], value: 'second' }, 1);
  assert.equal(map.get('conv-1'), undefined);
  assert.equal(map.get('inst-1'), undefined); // both aliases gone, not just one
  assert.equal(map.get('conv-2')?.value, 'second');
});

test('storeWithEviction does not delete a key that has since been reused by a newer entry', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  // Same conceptual conversation across two calls, but the second call's key set drops the
  // first call's instanceId alias in favor of a fresh one (a stable conversationId alongside a
  // per-call instanceId, as app.ts's handleFlueEvent does) — 'inst-1' is left behind, still
  // pointing at the stale first entry, while 'conv' now points at the second (live) entry.
  storeWithEviction(map, { keys: ['conv', 'inst-1'], value: 'first' }, 3);
  storeWithEviction(map, { keys: ['conv', 'inst-2'], value: 'second' }, 3);
  assert.equal(map.get('conv')?.value, 'second');
  assert.equal(map.get('inst-1')?.value, 'first'); // orphaned but not yet evicted

  // A third, unrelated store hits the cap; 'inst-1' (oldest untouched key) is picked for
  // eviction. Its stale `keys` list still says ['conv', 'inst-1'] — deleting 'conv' too would
  // wipe out the live 'second' entry, which is still reachable and was just touched.
  storeWithEviction(map, { keys: ['x'], value: 'third' }, 3);
  assert.equal(map.get('inst-1'), undefined); // the stale alias is evicted
  assert.equal(map.get('conv')?.value, 'second'); // the live entry must survive
  assert.equal(map.get('x')?.value, 'third');
});
