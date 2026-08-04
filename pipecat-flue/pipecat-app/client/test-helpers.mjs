// Shared harness for characterization tests that pin functions defined inline in index.html's
// <script> tag. Reads the real shipped file — rather than a copy — so tests can't drift from what
// actually ships, matching this client's zero-build convention (plain `node --test`, no bundler).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function readClientHtml() {
  return readFileSync(join(__dirname, 'index.html'), 'utf8');
}

export function extractFunction(html, name) {
  const marker = html.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`function ${name} not found in index.html`);
  // Keep a preceding `async ` modifier in the extracted source, or `await` inside an async
  // function's body would be a syntax error once re-evaluated stand-alone via `new Function(...)`.
  const asyncPrefix = 'async ';
  const start = html.startsWith(asyncPrefix, marker - asyncPrefix.length) ? marker - asyncPrefix.length : marker;
  const braceStart = html.indexOf('{', marker);
  let depth = 0;
  let i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return html.slice(start, i + 1);
}

// Like extractFunction, but for a function whose body references free variables (document,
// fetch, sibling module-level consts) instead of only its own parameters. `deps` binds each
// free-variable name to a mock; `new Function` closes over them as its own parameter list.
export function extractFunctionWithDeps(html, name, deps) {
  const src = extractFunction(html, name);
  const depNames = Object.keys(deps);
  const factory = new Function(...depNames, `return (${src});`);
  return factory(...depNames.map((k) => deps[k]));
}

// A DOM classList stand-in, shared by every test that mocks a micWrap/micBtn/bodyClassList/
// stageEl element passed into extractFunctionWithDeps.
export function makeClassList(initial = []) {
  const classes = new Set(initial);
  return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) };
}

// A #stage element stand-in, shared by present.test.mjs and exit-presentation.test.mjs.
// initialAriaHidden is left undefined for tests that don't care about the pre-call state.
export function makeStageEl(initialAriaHidden) {
  const attrs = { 'aria-hidden': initialAriaHidden };
  return { setAttribute: (k, v) => { attrs[k] = v; }, attrs };
}

// Builds micWrap/micBtn mocks plus the real setMicUI bound to them, for every test (set-mic-ui,
// teardown, handle-connection-state-change) that needs setMicUI's actual mic-appearance toggle
// rather than a stubbed call, so assertions observe its real end state. Initial classes/text/
// disabled default to each call site's own prior fixture state — pass only what a given test
// needs to start non-default.
export function loadRealSetMicUI(html, {
  micWrapClasses = [], micBtnClasses = [], micBtnText = '', micBtnDisabled = true,
} = {}) {
  const micWrap = { classList: makeClassList(micWrapClasses) };
  const micBtn = { classList: makeClassList(micBtnClasses), textContent: micBtnText, disabled: micBtnDisabled };
  const setMicUI = extractFunctionWithDeps(html, 'setMicUI', { micWrap, micBtn });
  return { setMicUI, micWrap, micBtn };
}

// Builds a bodyClassList/stageEl pair plus the real setPresentationVisible bound to them, for
// present.test.mjs and exit-presentation.test.mjs, so both observe setPresentationVisible's actual
// end state (class + aria-hidden) rather than a stubbed call — same reasoning as loadRealSetMicUI
// above. initialAriaHidden/initialClasses default to each call site's own prior fixture state.
export function loadRealSetPresentationVisible(html, { initialAriaHidden, initialClasses = [] } = {}) {
  const stageEl = makeStageEl(initialAriaHidden);
  const document = { body: { classList: makeClassList(initialClasses) } };
  const setPresentationVisible = extractFunctionWithDeps(html, 'setPresentationVisible', { document, stageEl });
  return { setPresentationVisible, stageEl, bodyClassList: document.body.classList };
}
