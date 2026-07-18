import { test } from 'node:test';
import assert from 'node:assert/strict';
import weatherAgent, { description, route } from '../src/agents/weather.ts';
import { buildInstructions } from '../src/instructions.ts';
import { WEATHER_INSTRUCTIONS } from '../src/weather.ts';
import { TIME_INSTRUCTIONS } from '../src/time.ts';
import { WOLFRAM_INSTRUCTIONS } from '../src/wolfram.ts';
import { ANIMATION_INSTRUCTIONS } from '../src/animation.ts';
import { WEBSEARCH_INSTRUCTIONS } from '../src/websearch.ts';
import { WEBFETCH_INSTRUCTIONS } from '../src/webfetch.ts';

const EXPECTED_TOOL_NAMES = [
  'get_weather',
  'get_time',
  'ask_wolfram',
  'show_math_animation',
  'control_math_animation',
  'web_search',
  'web_fetch',
];

test('description identifies this as the voice pipeline harness', () => {
  assert.equal(description, 'Spoken voice assistant — the flue harness in the voice pipeline.');
});

test('initialize() resolves model/thinkingLevel from env, defaulting when unset', async () => {
  const config = await weatherAgent.initialize({ env: {} } as any);
  assert.equal(config.model, 'azure/gpt-5.4');
  assert.equal(config.thinkingLevel, 'low');
});

test('initialize() honors FLUE_MODEL / FLUE_THINKING_LEVEL overrides', async () => {
  const config = await weatherAgent.initialize({
    env: { FLUE_MODEL: 'azure/DeepSeek-R1', FLUE_THINKING_LEVEL: 'high' },
  } as any);
  assert.equal(config.model, 'azure/DeepSeek-R1');
  assert.equal(config.thinkingLevel, 'high');
});

test('initialize() wires exactly the seven expected tools, in order', async () => {
  const config = await weatherAgent.initialize({ env: {} } as any);
  assert.deepEqual(config.tools?.map((tool) => tool.name), EXPECTED_TOOL_NAMES);
});

test('initialize() composes instructions from every tool block, in order', async () => {
  const config = await weatherAgent.initialize({ env: {} } as any);
  assert.equal(
    config.instructions,
    buildInstructions([
      WEATHER_INSTRUCTIONS,
      TIME_INSTRUCTIONS,
      WOLFRAM_INSTRUCTIONS,
      ANIMATION_INSTRUCTIONS,
      WEBSEARCH_INSTRUCTIONS,
      WEBFETCH_INSTRUCTIONS,
    ]),
  );
});

test('route is a pass-through middleware: it always calls next() and does not intercept', async () => {
  let callCount = 0;
  const next = async () => {
    callCount += 1;
    return 'sentinel';
  };
  const result = await route({} as any, next);
  assert.equal(callCount, 1);
  assert.equal(result, 'sentinel');
});
