'use strict';

// Loads client/index.html's inline <script> into a Node vm context so its
// functions can be unit-tested directly, per the script's own comments
// (handleDataChannelMessage/handleConnectionStateChange were split out
// specifically "so the ... logic is unit-testable ... independent of the
// RTCPeerConnection that node's test runner can't provide"). No bundler/
// build step is introduced — this reads the same file the browser serves.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

const ELEMENT_IDS = [
  'mic',
  'micWrap',
  'status',
  'status-text',
  'stage-svg',
  'stage-title',
  'remote',
  'stage',
  'stage-exit',
];

function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (matches.length === 0) throw new Error('index.html: no inline <script> block found');
  return matches[matches.length - 1][1];
}

function makeClassList() {
  const names = new Set();
  return {
    add: (...ns) => ns.forEach((n) => names.add(n)),
    remove: (...ns) => ns.forEach((n) => names.delete(n)),
    contains: (n) => names.has(n),
  };
}

function makeElement(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    dataset: {},
    classList: makeClassList(),
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {},
  };
}

// Returns { sandbox, elements } — sandbox exposes every top-level function
// declaration from the script (buildAnimationSvgUrl, present, pollAnimation,
// handleConnectionStateChange, setMicUI, buildOfferBody, teardown, ...) as an
// assignable/callable property, since a classic (non-module) script's
// top-level function declarations become properties of the vm context's
// global object. `fetchImpl` stubs the only network call the tested
// functions make.
function loadClient({ fetchImpl } = {}) {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const script = extractInlineScript(html);

  const elements = new Map(ELEMENT_IDS.map((id) => [id, makeElement(id)]));
  const body = makeElement('body');

  const sandbox = {
    console,
    URLSearchParams,
    fetch: fetchImpl || (async () => { throw new Error('fetch was not stubbed for this test'); }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    self: {},
    document: {
      getElementById: (id) => elements.get(id) || makeElement(id),
      querySelectorAll: () => [],
      addEventListener: () => {},
      body,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'client/index.html (inline script)' });

  return { sandbox, elements, body };
}

module.exports = { loadClient };
