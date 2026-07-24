/** Generic keyed-alias state map with LRU-ish eviction. No animation-specific logic lives here
 *  — app.ts uses it to store per-conversation AnimationState, keyed by both conversationId and
 *  instanceId aliases, but nothing below depends on that shape beyond the `keys`/`revision`
 *  fields each function needs. */

/** Finds the state stored under any of `keys` (first match wins). Callers with more than one
 *  alias for the same conceptual entry (e.g. app.ts's observe(), keyed by both
 *  event.conversationId and event.instanceId) use this since either alias may be the one under
 *  which a prior call stored the state. */
export function findByAnyKey<T>(map: Map<string, T>, keys: string[]): T | undefined {
  for (const key of keys) {
    const found = map.get(key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Revision to use when storing a new/updated state under `keys`: one past the highest
 *  revision found among any alias already stored (0 if none). Taking the max across all keys,
 *  rather than the first found, guards against an alias mismatch silently reusing a stale
 *  revision. */
export function nextRevision(map: Map<string, { revision: number }>, keys: string[]): number {
  return Math.max(0, ...keys.map((k) => map.get(k)?.revision ?? 0)) + 1;
}

/** Sets `state` under all of `state.keys` in `map`, evicting the least-recently-touched entry
 *  first if that would push `map` to `maxEntries` or beyond. Used by app.ts to bound its
 *  per-conversation animation-state map, which (unlike the original read-and-clear design) is
 *  never cleared by a poll — a long-running server would otherwise retain one entry per
 *  conversation id ever seen. Map iteration order is insertion order, so deleting `state`'s
 *  keys before re-setting them (rather than overwriting in place) is what makes eviction pick
 *  the least-, not just first-, recently touched entry. */
export function storeWithEviction<T extends { keys: string[] }>(
  map: Map<string, T>,
  state: T,
  maxEntries: number,
): void {
  for (const key of state.keys) map.delete(key);
  // A while, not an if: state.keys can add more keys than a single evicted entry frees (e.g. a
  // stale 1-alias entry evicted to make room for a fresh 2-alias one), so one eviction per call
  // isn't always enough to keep the map within maxEntries.
  while (map.size + state.keys.length > maxEntries && map.size > 0) {
    // The while guard (map.size > 0) guarantees this iterator yields a value, despite the
    // `T | undefined` typing IterableIterator.next() carries generically.
    const oldestKey = map.keys().next().value!;
    const oldest = map.get(oldestKey);
    // Only drop an alias if it still resolves to the entry being evicted. A caller's key set
    // for the "same" conceptual conversation can change between stores (e.g. a fresh per-call
    // instanceId alongside a stable conversationId) — when it does, a stale entry's own `keys`
    // list can still list a key that a later store has since reassigned to a newer, live entry.
    // Deleting by list membership alone would wipe that live entry out from under it.
    if (oldest) {
      for (const key of oldest.keys) {
        if (map.get(key) === oldest) {
          map.delete(key);
        }
      }
    }
    // Guarantees the loop always makes progress (deleting oldestKey itself) even if oldest's own
    // `keys` list somehow didn't include it — otherwise a broken invariant here would spin forever
    // instead of just under-evicting once, as the old single-shot `if` would have.
    map.delete(oldestKey);
  }
  for (const key of state.keys) map.set(key, state);
}

/** Refreshes `key`'s entry to the most-recently-touched end of `map`'s iteration order, without
 *  changing its value. `storeWithEviction` only treats writes as activity, but a poll-driven
 *  reader (app.ts's GET /animation/:id, hit ~1/s by a browser actively displaying an animation)
 *  is exactly the kind of activity that should keep an entry alive — otherwise an
 *  actively-viewed conversation can be evicted by unrelated traffic between tool calls. */
export function touch<T extends { keys: string[] }>(map: Map<string, T>, key: string): void {
  const entry = map.get(key);
  if (!entry) return;
  for (const k of entry.keys) map.delete(k);
  for (const k of entry.keys) map.set(k, entry);
}
