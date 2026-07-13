import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import {
  ANIMATION_TOPICS,
  ANIMATION_INSTRUCTIONS,
  showMathAnimation,
  controlMathAnimation,
  applyAnimationControl,
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
