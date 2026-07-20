import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlocks, pickBlock, chatBlock } from '../src/config.ts';
import { withEnvVars, withTempFile } from './test-helpers.ts';

const FIXTURE = `
# east-us-2
apikey=abc123
openai_endpoint=https://res-us2.openai.azure.com/openai/v1/

# east-us-1
export apikey="def456"
export openai_endpoint='https://res-us1.openai.azure.com/openai/v1'
`;

function withFixture<T>(contents: string, fn: (path: string) => T | Promise<T>): Promise<T> {
  return withTempFile('config-test-', 'aifoundry.sh', contents, fn);
}

test('loadBlocks parses section-aware key=value blocks, stripping export/quotes/trailing slash', async () => {
  await withFixture(FIXTURE, (file) => {
    const blocks = loadBlocks(file);
    assert.deepEqual(blocks, [
      { label: 'east-us-2', apikey: 'abc123', endpoint: 'https://res-us2.openai.azure.com/openai/v1' },
      { label: 'east-us-1', apikey: 'def456', endpoint: 'https://res-us1.openai.azure.com/openai/v1' },
    ]);
  });
});

test('loadBlocks drops blocks missing apikey or openai_endpoint', async () => {
  await withFixture(
    `
# incomplete
apikey=onlykey

# complete
apikey=k
openai_endpoint=https://res.openai.azure.com/openai/v1
`,
    (file) => {
      const blocks = loadBlocks(file);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].label, 'complete');
    },
  );
});

test('loadBlocks ignores a stray `label=` line instead of clobbering the header label', async () => {
  await withFixture(
    `
# east-us-2
apikey=k
openai_endpoint=https://res.openai.azure.com/openai/v1
label=hijacked
`,
    (file) => {
      const blocks = loadBlocks(file);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].label, 'east-us-2');
    },
  );
});

test('loadBlocks defaults to a "(default)" label for key=value lines preceding any header', async () => {
  await withFixture(
    `
apikey=k
openai_endpoint=https://res.openai.azure.com/openai/v1
`,
    (file) => {
      const blocks = loadBlocks(file);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].label, '(default)');
    },
  );
});

test('pickBlock matches by label/endpoint substring, else falls back by index', () => {
  const blocks = [
    { label: 'east-us-2', apikey: 'a', endpoint: 'https://res-us2.example' },
    { label: 'east-us-1', apikey: 'b', endpoint: 'https://res-us1.example' },
  ];
  assert.equal(pickBlock(blocks, ['us-1'], 0).label, 'east-us-1');
  assert.equal(pickBlock(blocks, ['nope'], 0).label, 'east-us-2');
  // A negative fallbackIndex should pick from the end, like Python's blocks[-1].
  assert.equal(pickBlock(blocks, ['nope'], -1).label, 'east-us-1');
});

test('pickBlock throws when there are no blocks', () => {
  assert.throws(() => pickBlock([], ['x'], 0), /No Azure credential blocks/);
});

test('chatBlock resolves the east-us-2 block from an explicit AIFOUNDRY_ENV path', async () => {
  await withFixture(FIXTURE, (file) =>
    withEnvVars({ AIFOUNDRY_ENV: file }, () => {
      assert.deepEqual(chatBlock(), {
        label: 'east-us-2',
        apikey: 'abc123',
        endpoint: 'https://res-us2.openai.azure.com/openai/v1',
      });
    }),
  );
});

test('chatBlock matches "east-us-2" specifically, not any block containing "us-2"', async () => {
  // A non-matching block comes first, so this only passes if chatBlock() actually
  // matches on "east-us-2" rather than falling through to the index-0 fallback.
  // (A prior version matched on the looser "us-2" substring — which a real
  // "west-us-2" resource would also satisfy — plus a dead, unreachable
  // "esat-us-2" typo needle; both were tightened/removed.)
  await withFixture(
    `
# west-us-2
apikey=key-w2
openai_endpoint=https://res-w2.openai.azure.com/openai/v1

# east-us-2
apikey=key-e2
openai_endpoint=https://res-e2.openai.azure.com/openai/v1
`,
    (file) =>
      withEnvVars({ AIFOUNDRY_ENV: file }, () => {
        assert.equal(chatBlock().label, 'east-us-2');
      }),
  );
});

test('loadBlocks expands a leading ~ against the home directory', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'config-home-'));
  try {
    // os.homedir() reads USERPROFILE on Windows and HOME on POSIX; mock both so this test is
    // platform-independent.
    await withEnvVars({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
      mkdirSync(join(fakeHome, 'env'), { recursive: true });
      writeFileSync(join(fakeHome, 'env', 'aifoundry.sh'), FIXTURE);
      const blocks = loadBlocks('~/env/aifoundry.sh');
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].label, 'east-us-2');
    });
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
