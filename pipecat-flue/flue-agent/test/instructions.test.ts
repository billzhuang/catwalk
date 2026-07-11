import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstructions } from '../src/instructions.ts';

test('buildInstructions composes persona, tool sections in order, and closing', () => {
  const out = buildInstructions(['## Tool: alpha\nfirst', '## Tool: beta\nsecond']);
  assert.match(out, /You are Aria/);
  assert.ok(out.indexOf('## Tool: alpha') < out.indexOf('## Tool: beta'), 'sections stay in call order');
  assert.match(out, /Being a good conversational partner/);
  assert.ok(
    out.indexOf('## Tool: beta') < out.indexOf('Being a good conversational partner'),
    'tool sections land before the closing',
  );
});

test('buildInstructions is deterministic — no per-call variance to bust the prompt cache', () => {
  const a = buildInstructions(['## Tool: alpha\nfirst']);
  const b = buildInstructions(['## Tool: alpha\nfirst']);
  assert.equal(a, b);
});

test('buildInstructions works with zero tool sections', () => {
  const out = buildInstructions([]);
  assert.match(out, /You are Aria/);
  assert.match(out, /Being a good conversational partner/);
});
