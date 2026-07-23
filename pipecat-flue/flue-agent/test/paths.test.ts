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
    { kind: 'header', label: 'east-us-2', freshParagraph: true },
    { kind: 'pair', key: 'apikey', value: 'abc' },
    { kind: 'pair', key: 'openai_endpoint', value: 'https://x.example' },
  ]);
});

test('parseEnvLines strips leading #s and whitespace from a header label', () => {
  assert.deepEqual(parseEnvLines('##  loud header  '), [
    { kind: 'header', label: 'loud header', freshParagraph: true },
  ]);
});

test('parseEnvLines strips every leading #/space run from a header label, not just the first', () => {
  // Mirrors bot/azure.py's load_blocks, which strips a header label via `s.lstrip("# ")` — a
  // character-class strip that keeps consuming '#' and ' ' regardless of grouping. A label
  // starting with its own '#' after the header's own leading "# " (e.g. someone prefixing a
  // note with "#1") must come out the same on both sides: 'lstrip("# ")` doesn't stop at the
  // first non-#-non-space run the way a single `^#+\s*` regex pass would.
  assert.deepEqual(parseEnvLines('# #1 rotate quarterly'), [
    { kind: 'header', label: '1 rotate quarterly', freshParagraph: true },
  ]);
});

test('parseEnvLines marks freshParagraph false for a header that does not open a new paragraph', () => {
  // A header is only a genuine new-paragraph boundary when it's the first line of the file or
  // right after a blank line — every other `#` line (an inline note mid-section, or a header
  // immediately following another line with no blank separator) gets freshParagraph: false.
  // It's still emitted as a 'header' entry either way: config.ts's loadBlocks decides whether
  // to actually treat it as a new section, using this flag plus its own completeness check.
  const text = '# a\napikey=1\n# b\nopenai_endpoint=2\n\n# c\napikey=3\n';
  assert.deepEqual(parseEnvLines(text), [
    { kind: 'header', label: 'a', freshParagraph: true },
    { kind: 'pair', key: 'apikey', value: '1' },
    { kind: 'header', label: 'b', freshParagraph: false },
    { kind: 'pair', key: 'openai_endpoint', value: '2' },
    { kind: 'header', label: 'c', freshParagraph: true },
    { kind: 'pair', key: 'apikey', value: '3' },
  ]);
});
