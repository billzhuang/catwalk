'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient } = require('./loadClient.js');

test('buildAnimationSvgUrl: topic only', () => {
  const { sandbox } = loadClient();
  assert.equal(sandbox.buildAnimationSvgUrl('sine'), '/animation-svg/sine');
});

test('buildAnimationSvgUrl: encodes the topic', () => {
  const { sandbox } = loadClient();
  assert.equal(
    sandbox.buildAnimationSvgUrl('a b/c'),
    '/animation-svg/' + encodeURIComponent('a b/c'),
  );
});

test('buildAnimationSvgUrl: passes title, repeated steps, and an integer stepIndex through as query params', () => {
  const { sandbox } = loadClient();
  const url = sandbox.buildAnimationSvgUrl('custom', 'My Title', ['step one', 'step two'], 1);
  const parsed = new URL(url, 'http://x');
  assert.equal(parsed.pathname, '/animation-svg/custom');
  assert.equal(parsed.searchParams.get('title'), 'My Title');
  assert.deepEqual(parsed.searchParams.getAll('steps'), ['step one', 'step two']);
  assert.equal(parsed.searchParams.get('step'), '1');
});

test('buildAnimationSvgUrl: omits title/steps/step when absent, and step when not an integer', () => {
  const { sandbox } = loadClient();
  const url = sandbox.buildAnimationSvgUrl('sine', undefined, undefined, undefined);
  assert.equal(url, '/animation-svg/sine');
  // stepIndex must be an integer (Number.isInteger) — a non-integer/NaN is dropped, not stringified.
  const url2 = sandbox.buildAnimationSvgUrl('sine', undefined, undefined, NaN);
  assert.equal(url2, '/animation-svg/sine');
});

test('buildOfferBody: shapes the /api/offer payload with clientId as request_data', () => {
  const { sandbox } = loadClient();
  // buildOfferBody's return value is a plain object literal constructed inside the vm context,
  // so it belongs to a different realm than this file's Object.prototype — deepStrictEqual
  // treats otherwise-identical objects from different realms as unequal, hence per-field checks.
  const body = sandbox.buildOfferBody({ sdp: 'v=0...', type: 'offer' }, 'client-123');
  assert.equal(body.sdp, 'v=0...');
  assert.equal(body.type, 'offer');
  assert.equal(body.pc_id, null);
  assert.equal(body.request_data.clientId, 'client-123');
  assert.deepEqual(Object.keys(body).sort(), ['pc_id', 'request_data', 'sdp', 'type']);
});

test('setMicUI(true): marks connected, switches to "Listening…", re-enables the button', () => {
  const { sandbox, elements } = loadClient();
  sandbox.setMicUI(true);
  assert.equal(elements.get('micWrap').classList.contains('connected'), true);
  assert.equal(elements.get('mic').classList.contains('live'), true);
  assert.equal(elements.get('mic').textContent, 'Listening…');
  assert.equal(elements.get('mic').disabled, false);
});

test('setMicUI(false): clears connected state and resets the label to "Connect"', () => {
  const { sandbox, elements } = loadClient();
  sandbox.setMicUI(true);
  sandbox.setMicUI(false);
  assert.equal(elements.get('micWrap').classList.contains('connected'), false);
  assert.equal(elements.get('mic').classList.contains('live'), false);
  assert.equal(elements.get('mic').textContent, 'Connect');
});

test('handleConnectionStateChange("connected"): flips mic UI live and shows the connected status', () => {
  const { sandbox, elements } = loadClient();
  sandbox.handleConnectionStateChange('connected');
  assert.equal(elements.get('micWrap').classList.contains('connected'), true);
  assert.equal(elements.get('status-text').textContent, 'Connected — just start talking');
  assert.equal(elements.get('status').className, 'on');
});

test('handleConnectionStateChange("disconnected"): shows a transient reconnecting status without tearing the call down', () => {
  const { sandbox, elements } = loadClient();
  sandbox.handleConnectionStateChange('connected');
  sandbox.handleConnectionStateChange('disconnected');
  assert.equal(elements.get('status-text').textContent, 'Reconnecting…');
  // Per the WebRTC spec comment in the source, "disconnected" must NOT tear down —
  // the mic stays marked connected so a self-recovering blip doesn't drop the call.
  assert.equal(elements.get('micWrap').classList.contains('connected'), true);
});

test('handleConnectionStateChange("failed"): tears down with an error status', () => {
  const { sandbox, elements } = loadClient();
  sandbox.handleConnectionStateChange('connected');
  sandbox.handleConnectionStateChange('failed');
  assert.equal(elements.get('status-text').textContent, 'Connection failed');
  assert.equal(elements.get('status').className, 'err');
  assert.equal(elements.get('micWrap').classList.contains('connected'), false);
  assert.equal(elements.get('mic').textContent, 'Connect');
});

test('handleConnectionStateChange("closed"): tears down with a plain "Disconnected" status (no error styling)', () => {
  const { sandbox, elements } = loadClient();
  sandbox.handleConnectionStateChange('connected');
  sandbox.handleConnectionStateChange('closed');
  assert.equal(elements.get('status-text').textContent, 'Disconnected');
  assert.equal(elements.get('status').className, '');
});

test('present(): renders the fetched SVG and enters presentation mode', async () => {
  const { sandbox, elements, body } = loadClient({
    fetchImpl: async () => ({ ok: true, text: async () => '<svg>ok</svg>' }),
  });
  const rendered = await sandbox.present('sine', 'Sine', undefined, undefined, undefined);
  assert.equal(rendered, true);
  assert.equal(elements.get('stage-svg').innerHTML, '<svg>ok</svg>');
  assert.equal(elements.get('stage-title').textContent, 'Sine');
  assert.equal(body.classList.contains('presenting'), true);
  assert.equal(elements.get('stage').attrs['aria-hidden'], 'false');
});

test('present(): falls back to a humanized topic when no title is given', async () => {
  const { sandbox, elements } = loadClient({
    fetchImpl: async () => ({ ok: true, text: async () => '<svg/>' }),
  });
  await sandbox.present('unit_circle', undefined, undefined, undefined, undefined);
  assert.equal(elements.get('stage-title').textContent, 'unit circle');
});

test('present(): a non-ok fetch leaves the stage untouched and returns false', async () => {
  const { sandbox, elements } = loadClient({
    fetchImpl: async () => ({ ok: false }),
  });
  const rendered = await sandbox.present('sine', 'Sine', undefined, undefined, undefined);
  assert.equal(rendered, false);
  assert.equal(elements.get('stage-svg').innerHTML, '');
});

test('present(): a stale revision (superseded by a newer poll before this fetch resolved) is dropped without touching the DOM', async () => {
  const { sandbox, elements } = loadClient({
    fetchImpl: async (url) => {
      if (String(url).startsWith('/animation/')) {
        return { ok: true, json: async () => ({ topic: 'sine', title: 'Sine', revision: 5 }) };
      }
      return { ok: true, text: async () => '<svg>sine</svg>' };
    },
  });
  // Only pollAnimation() advances lastAnimationRevision (present() itself never writes it), so
  // drive the "current" revision through pollAnimation first — this mirrors the real flow where
  // a later poll tick commits revision 5 before an older in-flight request (revision 3) resolves.
  await sandbox.pollAnimation();
  assert.equal(elements.get('stage-title').textContent, 'Sine');

  const rendered = await sandbox.present('pythagoras', 'Stale', undefined, undefined, 3);
  assert.equal(rendered, false);
  assert.equal(elements.get('stage-title').textContent, 'Sine');
  assert.equal(elements.get('stage-svg').innerHTML, '<svg>sine</svg>');
});

test('exitPresentation(): leaves presentation mode and stops the SVG animation', async () => {
  const { sandbox, elements, body } = loadClient({
    fetchImpl: async () => ({ ok: true, text: async () => '<svg>ok</svg>' }),
  });
  await sandbox.present('sine', 'Sine', undefined, undefined, undefined);
  sandbox.exitPresentation();
  assert.equal(body.classList.contains('presenting'), false);
  assert.equal(elements.get('stage').attrs['aria-hidden'], 'true');
  assert.equal(elements.get('stage-svg').innerHTML, '');
});

test('pollAnimation(): an outer /animation/:id response that arrives after a later poll already applied is discarded, protecting against out-of-order network resolution', async () => {
  const { sandbox } = loadClient();
  const presented = [];
  // present() is a top-level function declaration, so reassigning this property on the vm
  // context's global object rebinds the single global `present` binding pollAnimation() calls.
  sandbox.present = async (topic, title, steps, stepIndex, revision) => {
    presented.push(revision);
    return true;
  };

  let releaseFirstFetch;
  const firstFetchGate = new Promise((resolve) => { releaseFirstFetch = resolve; });
  let fetchCalls = 0;
  sandbox.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      await firstFetchGate;
      return { ok: true, json: async () => ({ topic: 'sine', revision: 1 }) };
    }
    return { ok: true, json: async () => ({ topic: 'pythagoras', revision: 2 }) };
  };

  const firstPoll = sandbox.pollAnimation();
  const secondPoll = sandbox.pollAnimation();
  await secondPoll; // the second (newer) request resolves and applies first
  releaseFirstFetch(); // now let the first (older) request's response arrive late
  await firstPoll;

  // Only the newer revision (2) should ever have reached present(); the stale
  // revision-1 response must be rejected by the pollRequestSeq/latestAppliedPollSeq
  // guard before it gets anywhere near present().
  assert.deepEqual(presented, [2]);
});

test('pollAnimation(): does not re-render when the revision is unchanged', async () => {
  const { sandbox } = loadClient();
  let presentCalls = 0;
  sandbox.present = async () => { presentCalls += 1; return true; };
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ topic: 'sine', revision: 0 }) });

  await sandbox.pollAnimation();

  assert.equal(presentCalls, 0);
});
