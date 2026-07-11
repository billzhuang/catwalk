import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, resolveThinkingLevel } from '../src/model-config.ts';

test('resolveModel: defaults to azure/gpt-5.4 when unset', () => {
  assert.equal(resolveModel({}), 'azure/gpt-5.4');
});

test('resolveModel: honors FLUE_MODEL override (e.g. an existing DeepSeek deployment)', () => {
  assert.equal(resolveModel({ FLUE_MODEL: 'azure/DeepSeek-R1' }), 'azure/DeepSeek-R1');
});

test('resolveModel: blank override falls back to the default', () => {
  assert.equal(resolveModel({ FLUE_MODEL: '  ' }), 'azure/gpt-5.4');
});

test('resolveThinkingLevel: defaults to low when unset', () => {
  assert.equal(resolveThinkingLevel({}), 'low');
});

test('resolveThinkingLevel: honors a valid override, case-insensitively', () => {
  assert.equal(resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'HIGH' }), 'high');
  assert.equal(resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'off' }), 'off');
});

test('resolveThinkingLevel: falls back to the default on an unrecognized value', () => {
  assert.equal(resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'ludicrous' }), 'low');
});
