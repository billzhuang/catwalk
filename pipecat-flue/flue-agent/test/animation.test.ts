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

test('storeWithEviction deletes every alias key of the evicted entry', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['conv-1', 'inst-1'], value: 'first' }, 1);
  storeWithEviction(map, { keys: ['conv-2'], value: 'second' }, 1);
  assert.equal(map.get('conv-1'), undefined);
  assert.equal(map.get('inst-1'), undefined); // both aliases gone, not just one
  assert.equal(map.get('conv-2')?.value, 'second');
});
