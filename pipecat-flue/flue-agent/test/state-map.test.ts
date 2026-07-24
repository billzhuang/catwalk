import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeWithEviction, findByAnyKey, nextRevision, touch } from '../src/state-map.ts';

test('storeWithEviction stores under every key while under the cap', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a', 'b'], value: 'one' }, 10);
  assert.equal(map.get('a')?.value, 'one');
  assert.equal(map.get('b')?.value, 'one');
  assert.equal(map.size, 2);
});

test('storeWithEviction evicts the least-recently-touched entry once at capacity', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['b'], value: 'second' }, 2);
  // Map is now at its cap of 2; storing a third entry must evict "a" (never touched again).
  storeWithEviction(map, { keys: ['c'], value: 'third' }, 2);
  assert.equal(map.get('a'), undefined);
  assert.equal(map.get('b')?.value, 'second');
  assert.equal(map.get('c')?.value, 'third');
});

test('storeWithEviction refreshes LRU position on update, so a re-touched entry survives', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['b'], value: 'second' }, 2);
  // Re-touch "a" (e.g. a control_math_animation step change) — it should no longer be oldest.
  storeWithEviction(map, { keys: ['a'], value: 'first-updated' }, 2);
  storeWithEviction(map, { keys: ['c'], value: 'third' }, 2);
  assert.equal(map.get('a')?.value, 'first-updated'); // survived: was refreshed, not oldest
  assert.equal(map.get('b'), undefined); // evicted: now the least-recently-touched
  assert.equal(map.get('c')?.value, 'third');
});

test('storeWithEviction evicts more than one entry when the incoming state has more keys than a single evicted entry frees', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['b'], value: 'second' }, 2);
  // Map is at its cap of 2 (one key each). The incoming entry brings 2 keys, so evicting just
  // "a" (freeing 1 slot) isn't enough to stay within the cap — "b" must go too.
  storeWithEviction(map, { keys: ['c1', 'c2'], value: 'third' }, 2);
  assert.equal(map.get('a'), undefined);
  assert.equal(map.get('b'), undefined);
  assert.equal(map.get('c1')?.value, 'third');
  assert.equal(map.get('c2')?.value, 'third');
  assert.equal(map.size, 2);
});

test('storeWithEviction evicts only what a duplicate key set actually needs', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['x'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['y'], value: 'second' }, 2);
  // The incoming state lists the same key twice — a Map dedupes them, so this only needs 1 new
  // slot. Budgeting off the raw array length (2) instead of the distinct count (1) would evict
  // one entry too many.
  storeWithEviction(map, { keys: ['a', 'a'], value: 'third' }, 2);
  assert.equal(map.get('x'), undefined); // evicted: oldest, and the only one actually needed
  assert.equal(map.get('y')?.value, 'second'); // must survive: only 1 slot was needed
  assert.equal(map.get('a')?.value, 'third');
  assert.equal(map.size, 2);
});

test('findByAnyKey returns undefined when none of the keys are stored', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  assert.equal(findByAnyKey(map, ['conv-1', 'inst-1']), undefined);
});

test('findByAnyKey finds the entry under whichever alias key hits first', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['conv-1', 'inst-1'], value: 'stored' }, 10);
  assert.equal(findByAnyKey(map, ['conv-1', 'inst-1'])?.value, 'stored');
  // Only instanceId is known this time (e.g. conversationId wasn't set on this event).
  assert.equal(findByAnyKey(map, ['unknown-conv', 'inst-1'])?.value, 'stored');
});

test('nextRevision is 1 when none of the keys have a stored revision yet', () => {
  const map = new Map<string, { revision: number }>();
  assert.equal(nextRevision(map, ['conv-1', 'inst-1']), 1);
});

test('nextRevision is one past the highest revision found among any alias key', () => {
  const map = new Map<string, { revision: number }>();
  map.set('conv-1', { revision: 3 });
  map.set('inst-1', { revision: 5 }); // mismatched alias with a higher revision
  assert.equal(nextRevision(map, ['conv-1', 'inst-1']), 6);
});

test('storeWithEviction deletes every alias key of the evicted entry', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['conv-1', 'inst-1'], value: 'first' }, 1);
  storeWithEviction(map, { keys: ['conv-2'], value: 'second' }, 1);
  assert.equal(map.get('conv-1'), undefined);
  assert.equal(map.get('inst-1'), undefined); // both aliases gone, not just one
  assert.equal(map.get('conv-2')?.value, 'second');
});

test('touch refreshes an entry\'s LRU position without changing its value, so it survives a later eviction', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  storeWithEviction(map, { keys: ['a'], value: 'first' }, 2);
  storeWithEviction(map, { keys: ['b'], value: 'second' }, 2);
  // "a" is oldest here; touching it (e.g. a GET /animation/:id read) should make "b" the one
  // evicted next, even though "a" itself was never re-stored.
  touch(map, 'a');
  storeWithEviction(map, { keys: ['c'], value: 'third' }, 2);
  assert.equal(map.get('a')?.value, 'first'); // survived: touched, not oldest anymore
  assert.equal(map.get('b'), undefined); // evicted: now the least-recently-touched
  assert.equal(map.get('c')?.value, 'third');
});

test('touch is a no-op for a key that resolves to nothing', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  touch(map, 'missing'); // must not throw
  assert.equal(map.size, 0);
});

test('storeWithEviction does not delete a key that has since been reused by a newer entry', () => {
  const map = new Map<string, { keys: string[]; value: string }>();
  // Same conceptual conversation across two calls, but the second call's key set drops the
  // first call's instanceId alias in favor of a fresh one (a stable conversationId alongside a
  // per-call instanceId, as app.ts's handleFlueEvent does) — 'inst-1' is left behind, still
  // pointing at the stale first entry, while 'conv' now points at the second (live) entry.
  storeWithEviction(map, { keys: ['conv', 'inst-1'], value: 'first' }, 3);
  storeWithEviction(map, { keys: ['conv', 'inst-2'], value: 'second' }, 3);
  assert.equal(map.get('conv')?.value, 'second');
  assert.equal(map.get('inst-1')?.value, 'first'); // orphaned but not yet evicted

  // A third, unrelated store hits the cap; 'inst-1' (oldest untouched key) is picked for
  // eviction. Its stale `keys` list still says ['conv', 'inst-1'] — deleting 'conv' too would
  // wipe out the live 'second' entry, which is still reachable and was just touched.
  storeWithEviction(map, { keys: ['x'], value: 'third' }, 3);
  assert.equal(map.get('inst-1'), undefined); // the stale alias is evicted
  assert.equal(map.get('conv')?.value, 'second'); // the live entry must survive
  assert.equal(map.get('x')?.value, 'third');
});
