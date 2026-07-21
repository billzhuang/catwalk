// Characterization test for index.html's `buildOfferBody`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins the
// POST /api/offer payload shape that connect() relies on, split out of connect() alongside
// handleConnectionStateChange so both pieces of connect() are unit-testable on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction } from './test-helpers.mjs';

const html = readClientHtml();
const buildOfferBody = new Function(`return (${extractFunction(html, 'buildOfferBody')});`)();

test('buildOfferBody shapes the offer payload from the local description and clientId', () => {
  const localDescription = { sdp: 'v=0...', type: 'offer' };

  assert.deepEqual(buildOfferBody(localDescription, 'client-123'), {
    sdp: 'v=0...',
    type: 'offer',
    pc_id: null,
    request_data: { clientId: 'client-123' },
  });
});

test('buildOfferBody always sets pc_id to null', () => {
  const localDescription = { sdp: 'v=1', type: 'answer' };

  assert.equal(buildOfferBody(localDescription, 'abc').pc_id, null);
});
