import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlocks, pickBlock, chatBlock } from '../src/config.ts';

const FIXTURE = `
# east-us-2
apikey=abc123
openai_endpoint=https://res-us2.openai.azure.com/openai/v1/

# east-us-1
export apikey="def456"
export openai_endpoint='https://res-us1.openai.azure.com/openai/v1'
`;

function withFixture(contents: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
  const file = join(dir, 'aifoundry.sh');
  writeFileSync(file, contents);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadBlocks parses section-aware key=value blocks, stripping export/quotes/trailing slash', () => {
  withFixture(FIXTURE, (file) => {
    const blocks = loadBlocks(file);
    assert.deepEqual(blocks, [
      { label: 'east-us-2', apikey: 'abc123', endpoint: 'https://res-us2.openai.azure.com/openai/v1' },
      { label: 'east-us-1', apikey: 'def456', endpoint: 'https://res-us1.openai.azure.com/openai/v1' },
    ]);
  });
});

test('loadBlocks drops blocks missing apikey or openai_endpoint', () => {
  withFixture(
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

test('pickBlock matches by label/endpoint substring, else falls back by index', () => {
  const blocks = [
    { label: 'east-us-2', apikey: 'a', endpoint: 'https://res-us2.example' },
    { label: 'east-us-1', apikey: 'b', endpoint: 'https://res-us1.example' },
  ];
  assert.equal(pickBlock(blocks, ['us-1'], 0).label, 'east-us-1');
  assert.equal(pickBlock(blocks, ['nope'], 0).label, 'east-us-2');
  // blocks[-1] is undefined via bracket access in JS (no negative indexing), so this
  // falls through to the `?? blocks[0]` default rather than picking the last block.
  assert.equal(pickBlock(blocks, ['nope'], -1).label, 'east-us-2');
});

test('pickBlock throws when there are no blocks', () => {
  assert.throws(() => pickBlock([], ['x'], 0), /No Azure credential blocks/);
});

test('chatBlock resolves the east-us-2 block from an explicit AIFOUNDRY_ENV path', () => {
  withFixture(FIXTURE, (file) => {
    const prev = process.env.AIFOUNDRY_ENV;
    process.env.AIFOUNDRY_ENV = file;
    try {
      assert.deepEqual(chatBlock(), {
        label: 'east-us-2',
        apikey: 'abc123',
        endpoint: 'https://res-us2.openai.azure.com/openai/v1',
      });
    } finally {
      if (prev === undefined) delete process.env.AIFOUNDRY_ENV;
      else process.env.AIFOUNDRY_ENV = prev;
    }
  });
});

test('loadBlocks expands a leading ~ against the home directory', () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = mkdtempSync(join(tmpdir(), 'config-home-'));
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX; mock both so this test is
  // platform-independent.
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    mkdirSync(join(fakeHome, 'env'), { recursive: true });
    writeFileSync(join(fakeHome, 'env', 'aifoundry.sh'), FIXTURE);
    const blocks = loadBlocks('~/env/aifoundry.sh');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].label, 'east-us-2');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
