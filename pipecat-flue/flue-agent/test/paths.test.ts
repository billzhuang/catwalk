import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { expandHome } from '../src/paths.ts';

test('expandHome expands a leading ~ against the home directory', () => {
  assert.equal(expandHome('~/env/aifoundry.sh'), resolve(homedir(), 'env/aifoundry.sh'));
});

test('expandHome leaves absolute and relative paths unchanged', () => {
  assert.equal(expandHome('/etc/aifoundry.sh'), '/etc/aifoundry.sh');
  assert.equal(expandHome('env/aifoundry.sh'), 'env/aifoundry.sh');
});
