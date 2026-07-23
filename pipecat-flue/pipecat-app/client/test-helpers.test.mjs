// Characterization test for test-helpers.mjs itself — the shared harness every other
// client/*.test.mjs relies on to pull functions out of index.html, yet which has never had its
// own extraction logic (the not-found error path, the async-prefix carry-over, dep-binding)
// pinned by a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml, extractFunction, extractFunctionWithDeps, makeClassList } from './test-helpers.mjs';

const html = readClientHtml();

test('readClientHtml reads the real shipped index.html', () => {
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /function present\(/);
});

test('extractFunction: extracts a plain (non-async) function verbatim', () => {
  const src = extractFunction(html, 'setStatus');
  assert.match(src, /^function setStatus\(/);
  assert.match(src, /statusText\.textContent = text/);
  // Balanced to the function's own closing brace, not some later one.
  assert.equal(src.at(-1), '}');
});

test('extractFunction: keeps a preceding `async` modifier so the source stays valid standalone', () => {
  const src = extractFunction(html, 'present');
  assert.match(src, /^async function present\(/);
});

test('extractFunction: throws when the named function is not in the html', () => {
  assert.throws(() => extractFunction(html, 'thisFunctionDoesNotExist'), /thisFunctionDoesNotExist not found/);
});

test('extractFunctionWithDeps: binds free variables as closed-over parameters', () => {
  const calls = [];
  const fn = extractFunctionWithDeps(html, 'setStatus', {
    statusText: { set textContent(v) { calls.push(['textContent', v]); } },
    statusEl: { set className(v) { calls.push(['className', v]); } },
  });
  fn('hi', 'warn');
  assert.deepEqual(calls, [['textContent', 'hi'], ['className', 'warn']]);
});

test('extractFunctionWithDeps: works with zero deps for a function needing none', () => {
  const fn = extractFunctionWithDeps(html, 'buildAnimationSvgUrl', {});
  assert.equal(fn('sine'), '/animation-svg/sine');
});

test('makeClassList: starts empty when called with no seed', () => {
  const classList = makeClassList();
  assert.ok(!classList.has('connected'));
});

test('makeClassList: seeds initial classes from the given array', () => {
  const classList = makeClassList(['connected', 'live']);
  assert.ok(classList.has('connected'));
  assert.ok(classList.has('live'));
});

test('makeClassList: add/remove/has track membership independently of the seed', () => {
  const classList = makeClassList(['connected']);
  classList.add('live');
  classList.remove('connected');
  assert.ok(classList.has('live'));
  assert.ok(!classList.has('connected'));
});
