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

test('buildInstructions includes Socratic teaching-style guidance between persona and tool sections', () => {
  const out = buildInstructions(['## Tool: alpha\nfirst']);
  assert.match(out, /guiding question or a small hint/);
  assert.match(out, /Drop the Socratic approach and just give the direct answer/);
  assert.ok(
    out.indexOf('You are Aria') < out.indexOf('Teaching style') &&
      out.indexOf('Teaching style') < out.indexOf('## Tool: alpha'),
    'teaching style lands after the persona and before tool sections',
  );
});

test('buildInstructions excludes simple calculations and factual questions from Socratic guidance', () => {
  const out = buildInstructions([]);
  assert.match(out, /does not apply to a simple, direct calculation/);
  assert.match(out, /just answer those directly/);
});

test('buildInstructions calls out frustration/confusion signals beyond an explicit ask for the answer', () => {
  const out = buildInstructions([]);
  assert.match(out, /I don't get it/);
  assert.match(out, /same question two or more times, even if not consecutively/);
  assert.match(out, /cue\s+to change strategy/);
});

test('buildInstructions directs a simplify-and-encourage response instead of escalating on frustration', () => {
  const out = buildInstructions([]);
  assert.match(out, /break the current step into something smaller/);
  assert.match(out, /brief line of encouragement/);
  assert.match(out, /switch fully to a direct\s+answer/);
});
