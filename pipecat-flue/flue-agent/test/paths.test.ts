import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { expandHome, parseEnvLines, parseKeyValue } from '../src/paths.ts';

test('expandHome expands a leading ~ against the home directory', () => {
  assert.equal(expandHome('~/env/aifoundry.sh'), resolve(homedir(), 'env/aifoundry.sh'));
});

test('expandHome leaves absolute and relative paths unchanged', () => {
  assert.equal(expandHome('/etc/aifoundry.sh'), '/etc/aifoundry.sh');
  assert.equal(expandHome('env/aifoundry.sh'), 'env/aifoundry.sh');
});

test('expandHome leaves a ~-prefixed path with no separator unchanged (not a ~/ path)', () => {
  assert.equal(expandHome('~env/aifoundry.sh'), '~env/aifoundry.sh');
  assert.equal(expandHome('~a'), '~a');
});

test('expandHome expands a bare ~ to the home directory', () => {
  assert.equal(expandHome('~'), homedir());
});

test('parseKeyValue strips a leading export and lowercases the key', () => {
  assert.deepEqual(parseKeyValue('export apikey=abc123'), ['apikey', 'abc123']);
  assert.deepEqual(parseKeyValue('APIKEY=abc123'), ['apikey', 'abc123']);
});

test('parseKeyValue strips surrounding single or double quotes from the value', () => {
  assert.deepEqual(parseKeyValue('key="abc123"'), ['key', 'abc123']);
  assert.deepEqual(parseKeyValue("key='abc123'"), ['key', 'abc123']);
});

test('parseKeyValue strips only one quote layer per end from a doubly-quoted value', () => {
  // Mirrors bot/azure.py's load_blocks, which parses this same ~/env/aifoundry.sh file
  // and must strip a doubly-quoted value (e.g. `""key""`) down to `"key"` too, not `key`.
  assert.deepEqual(parseKeyValue('apikey=""key-with-doubled-quotes""'), ['apikey', '"key-with-doubled-quotes"']);
});

test('parseKeyValue keeps `=` signs inside the value (splits on the first one only)', () => {
  assert.deepEqual(parseKeyValue('endpoint=https://x.example/v1?a=b'), ['endpoint', 'https://x.example/v1?a=b']);
});

test('parseKeyValue trims surrounding whitespace from key and value', () => {
  assert.deepEqual(parseKeyValue('  key  =  value  '), ['key', 'value']);
});

test('parseEnvLines classifies comment headers and key=value pairs, skipping blank/non-= lines', () => {
  const text = '\n# east-us-2\napikey=abc\n\nnot-a-pair\nexport openai_endpoint="https://x.example"\n';
  assert.deepEqual(parseEnvLines(text), [
    { kind: 'header', label: 'east-us-2' },
    { kind: 'pair', key: 'apikey', value: 'abc' },
    { kind: 'pair', key: 'openai_endpoint', value: 'https://x.example' },
  ]);
});

test('parseEnvLines strips leading #s and whitespace from a header label', () => {
  assert.deepEqual(parseEnvLines('##  loud header  '), [{ kind: 'header', label: 'loud header' }]);
});
