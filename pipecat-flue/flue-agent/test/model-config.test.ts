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

test('resolveThinkingLevel: warns with the bad value, valid options, and fallback on an unrecognized value', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'ludicrous' });
  assert.equal(warnMock.mock.callCount(), 1);
  const [message] = warnMock.mock.calls[0].arguments;
  assert.match(message, /FLUE_THINKING_LEVEL=ludicrous is not a recognized thinking level/);
  assert.match(message, /off, minimal, low, medium, high, xhigh, max/);
  assert.match(message, /falling back to low/);
});

test('resolveThinkingLevel: does not warn on a valid override', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'high' });
  assert.equal(warnMock.mock.callCount(), 0);
});
