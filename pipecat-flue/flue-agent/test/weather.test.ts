import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCode, WMO } from '../src/weather.ts';

test('describeCode maps known WMO codes', () => {
  assert.equal(describeCode(0), 'clear sky');
  assert.equal(describeCode(61), 'slight rain');
  assert.equal(describeCode(95), 'thunderstorm');
});

test('describeCode handles unknown / missing codes', () => {
  assert.equal(describeCode(undefined), 'unknown');
  assert.equal(describeCode(4242), 'code 4242');
});

test('WMO table covers the common precipitation codes', () => {
  for (const code of [0, 1, 2, 3, 45, 51, 61, 63, 65, 71, 80, 95]) {
    assert.ok(WMO[code], `missing description for code ${code}`);
  }
});

test('config: section-aware parse keeps both blocks separate', async () => {
  // loadBlocks parses the real ~/env file; assert the two resources don't collide.
  const { loadBlocks, pickBlock } = await import('../src/config.ts');
  const blocks = loadBlocks();
  assert.ok(blocks.length >= 1, 'at least one credential block');
  if (blocks.length >= 2) {
    const eu2 = pickBlock(blocks, ['us-2']);
    const eu1 = pickBlock(blocks, ['us-1'], blocks.length - 1);
    assert.notEqual(eu2.endpoint, eu1.endpoint, 'east-us-2 and east-us-1 endpoints differ');
  }
});
