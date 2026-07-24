// Characterization test for index.html's `present`, run with plain `node --test` (no
// bundler/deps, matching this client's zero-build convention). It reads the real <script>
// source out of index.html — rather than a copy — so it can't drift from what ships. Pins what
// present() does to the DOM and network on success/failure, ahead of caching the `#stage` lookup
// (present() and exitPresentation() currently each call document.getElementById("stage") fresh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunctionWithDeps, makeClassList } from './test-helpers.mjs';

const html = readClientHtml();

function makeStageEl() {
  const attrs = {};
  return { setAttribute: (k, v) => { attrs[k] = v; }, attrs };
}

function loadPresent({ stageEl, fetchImpl, buildAnimationSvgUrl, lastAnimationRevision }) {
  const stageSvg = { innerHTML: '' };
  const stageTitle = { textContent: '' };
  const bodyClassList = makeClassList();
  const document = {
    body: { classList: bodyClassList },
    // Bound to the same stageEl regardless of whether present() looks it up itself or (after
    // the fix) uses a module-level `stageEl` const — either way this is what it must affect.
    getElementById: (id) => (id === 'stage' ? stageEl : undefined),
  };
  const present = extractFunctionWithDeps(html, 'present', {
    document,
    fetch: fetchImpl,
    stageSvg,
    stageTitle,
    stageEl,
    buildAnimationSvgUrl: buildAnimationSvgUrl ?? ((topic) => '/animation-svg/' + topic),
    lastAnimationRevision: lastAnimationRevision ?? 0,
  });
  return { present, stageSvg, stageTitle, bodyClassList, stageEl };
}

test('present() fetches the SVG, sets the title, and reveals the stage', async () => {
  const stageEl = makeStageEl();
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push([url, opts]);
    return { ok: true, text: async () => '<svg>mock</svg>' };
  };
  const { present, stageSvg, stageTitle, bodyClassList } = loadPresent({ stageEl, fetchImpl });

  await present('sine', 'My Title', null, null);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], '/animation-svg/sine');
  assert.deepEqual(fetchCalls[0][1], { cache: 'no-store' });
  assert.equal(stageSvg.innerHTML, '<svg>mock</svg>');
  assert.equal(stageTitle.textContent, 'My Title');
  assert.ok(bodyClassList.has('presenting'));
  assert.equal(stageEl.attrs['aria-hidden'], 'false');
});

test('present() falls back to a formatted topic name when no title is given', async () => {
  const stageEl = makeStageEl();
  const fetchImpl = async () => ({ ok: true, text: async () => '<svg/>' });
  const { present, stageTitle } = loadPresent({ stageEl, fetchImpl });

  await present('unit_circle', '', null, null);

  assert.equal(stageTitle.textContent, 'unit circle');
});

test('present() leaves the stage hidden and does not throw when the fetch response is not ok', async () => {
  const stageEl = makeStageEl();
  const fetchImpl = async () => ({ ok: false, text: async () => '' });
  const { present, stageSvg, stageTitle, bodyClassList } = loadPresent({ stageEl, fetchImpl });

  const rendered = await present('sine', 'My Title', null, null);

  assert.equal(rendered, false);
  assert.equal(stageSvg.innerHTML, '');
  assert.equal(stageTitle.textContent, '');
  assert.ok(!bodyClassList.has('presenting'));
  assert.equal(stageEl.attrs['aria-hidden'], undefined);
});

test('present() swallows a rejected fetch instead of throwing', async () => {
  const stageEl = makeStageEl();
  const fetchImpl = async () => { throw new Error('network down'); };
  const { present, bodyClassList } = loadPresent({ stageEl, fetchImpl });

  const rendered = await present('sine', 'My Title', null, null);

  assert.equal(rendered, false);
  assert.ok(!bodyClassList.has('presenting'));
});

test('present() discards a resolved response whose revision a later poll has already superseded', async () => {
  const stageEl = makeStageEl();
  const fetchImpl = async () => ({ ok: true, text: async () => '<svg>stale</svg>' });
  // lastAnimationRevision (2) has already moved past this call's own revision (1) by the time
  // its fetch resolves — simulating a slow response racing a faster, newer poll tick.
  const { present, stageSvg, stageTitle, bodyClassList, stageEl: el } =
    loadPresent({ stageEl, fetchImpl, lastAnimationRevision: 2 });

  const rendered = await present('sine', 'Stale Title', null, null, 1);

  assert.equal(rendered, false);
  assert.equal(stageSvg.innerHTML, '');
  assert.equal(stageTitle.textContent, '');
  assert.ok(!bodyClassList.has('presenting'));
  assert.equal(el.attrs['aria-hidden'], undefined);
});

test('present() renders when its revision still matches the current lastAnimationRevision', async () => {
  const stageEl = makeStageEl();
  const fetchImpl = async () => ({ ok: true, text: async () => '<svg>fresh</svg>' });
  const { present, stageSvg } = loadPresent({ stageEl, fetchImpl, lastAnimationRevision: 5 });

  const rendered = await present('sine', 'Fresh Title', null, null, 5);

  assert.equal(rendered, true);
  assert.equal(stageSvg.innerHTML, '<svg>fresh</svg>');
});
