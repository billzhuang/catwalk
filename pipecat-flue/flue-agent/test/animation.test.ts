import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';
import {
  ANIMATION_TOPICS,
  ANIMATION_INSTRUCTIONS,
  showMathAnimation,
  controlMathAnimation,
  applyAnimationControl,
  parseShowMathAnimationArgs,
  parseControlAction,
  isRenderableAnimationInput,
  isExactCanonicalTopic,
  resolveCanonicalTopic,
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

test('schema rejects a topic longer than 60 characters', () => {
  assert.throws(() => v.parse(showMathAnimation.input, { topic: 'a'.repeat(61) }));
});

test('schema rejects a title longer than 80 characters', () => {
  assert.throws(() =>
    v.parse(showMathAnimation.input, {
      topic: 'fourier_series',
      title: 'a'.repeat(81),
      steps: ['step'],
    }),
  );
});

test('schema rejects a step longer than 65 characters', () => {
  assert.throws(() =>
    v.parse(showMathAnimation.input, {
      topic: 'fourier_series',
      title: 'Fourier series',
      steps: ['a'.repeat(66)],
    }),
  );
});

test('isRenderableAnimationInput rejects more than 6 steps, matching the schema', () => {
  // This is the bug isRenderableAnimationInput exists to prevent one layer up: if it disagreed
  // with the tool's own valibot caps, app.ts's observe() handler would commit animation state
  // for a call that run()'s schema validation is about to reject, leaving the browser rendering
  // something the model believes never got shown.
  const steps = Array.from({ length: 7 }, (_, i) => `step ${i}`);
  assert.equal(isRenderableAnimationInput('fourier_series', 'Fourier series', steps), false);
});

test('isRenderableAnimationInput accepts exactly 6 steps', () => {
  const steps = Array.from({ length: 6 }, (_, i) => `step ${i}`);
  assert.equal(isRenderableAnimationInput('fourier_series', 'Fourier series', steps), true);
});

test('isRenderableAnimationInput rejects a title longer than 80 characters, matching the schema', () => {
  assert.equal(isRenderableAnimationInput('fourier_series', 'a'.repeat(81), ['step']), false);
});

test('isRenderableAnimationInput accepts a title of exactly 80 characters', () => {
  assert.equal(isRenderableAnimationInput('fourier_series', 'a'.repeat(80), ['step']), true);
});

test('isRenderableAnimationInput rejects a step longer than 65 characters, matching the schema', () => {
  assert.equal(isRenderableAnimationInput('fourier_series', 'Fourier series', ['a'.repeat(66)]), false);
});

test('isRenderableAnimationInput accepts a step of exactly 65 characters', () => {
  assert.equal(isRenderableAnimationInput('fourier_series', 'Fourier series', ['a'.repeat(65)]), true);
});

test('isRenderableAnimationInput rejects a non-canonical topic longer than 60 characters, matching the schema', () => {
  // Mirrors the title/steps bound tests above: a model-supplied topic slug longer than the
  // tool's own v.maxLength(60) must be rejected here too, or app.ts's observe() handler commits
  // animation state for a call that run()'s schema validation is about to reject.
  assert.equal(isRenderableAnimationInput('a'.repeat(61), 'Title', ['step']), false);
});

test('isRenderableAnimationInput accepts a non-canonical topic of exactly 60 characters', () => {
  assert.equal(isRenderableAnimationInput('a'.repeat(60), 'Title', ['step']), true);
});

test('isRenderableAnimationInput rejects a whitespace-only non-canonical topic', () => {
  assert.equal(isRenderableAnimationInput('   ', 'Title', ['step']), false);
});

test('isExactCanonicalTopic is true for each hand-built topic', () => {
  for (const topic of ANIMATION_TOPICS) {
    assert.equal(isExactCanonicalTopic(topic), true);
  }
});

test('isExactCanonicalTopic is true for a case/whitespace variant of a hand-built topic', () => {
  assert.equal(isExactCanonicalTopic('Pythagoras'), true);
  assert.equal(isExactCanonicalTopic(' derivative '), true);
  assert.equal(isExactCanonicalTopic('SINE'), true);
});

test('isExactCanonicalTopic is false for an ANIMATION_ALIASES synonym', () => {
  // The whole reason this function is distinct from isCanonicalTopic: a synonym like "triangle"
  // must NOT count as an exact match, or a caller storing title/steps for on-the-fly content that
  // happens to collide with an alias would have that content wrongly discarded.
  for (const alias of ['cosine', 'triangle', 'calculus', 'vector']) {
    assert.equal(isExactCanonicalTopic(alias), false);
  }
});

test('isExactCanonicalTopic is false for an unrelated topic string', () => {
  assert.equal(isExactCanonicalTopic('fourier_series'), false);
  assert.equal(isExactCanonicalTopic(''), false);
});

test('resolveCanonicalTopic returns the topic itself for an exact canonical match', () => {
  for (const topic of ANIMATION_TOPICS) {
    assert.equal(resolveCanonicalTopic(topic), topic);
  }
  assert.equal(resolveCanonicalTopic('Pythagoras'), 'pythagoras');
});

test('resolveCanonicalTopic resolves an ALIASES synonym to the scene it actually renders', () => {
  // bot/animations.py's render() renders the pythagoras scene for "triangle" — if this returned
  // "triangle" instead, a caller storing it as display state would caption that scene wrong.
  assert.equal(resolveCanonicalTopic('triangle'), 'pythagoras');
  assert.equal(resolveCanonicalTopic('cosine'), 'sine');
  assert.equal(resolveCanonicalTopic('tangent'), 'derivative');
  assert.equal(resolveCanonicalTopic('vector'), 'vectors');
});

test('resolveCanonicalTopic returns undefined for a non-canonical topic', () => {
  assert.equal(resolveCanonicalTopic('fourier_series'), undefined);
  assert.equal(resolveCanonicalTopic(''), undefined);
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

