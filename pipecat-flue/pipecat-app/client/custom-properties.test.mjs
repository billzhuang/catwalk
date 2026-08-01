// Characterization test for index.html's `:root` CSS custom properties: every declared
// `--name` should actually be read somewhere via `var(--name`, or it's dead — leftover from an
// earlier palette iteration that nothing renders with anymore. Reads the real shipped file
// (not a copy), matching this client's zero-build convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml } from './test-helpers.mjs';

function declaredCustomProperties(html) {
  const rootMatch = html.match(/:root\s*\{([^}]*)\}/);
  if (!rootMatch) throw new Error(':root block not found in index.html');
  return [...rootMatch[1].matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]);
}

function unusedCustomProperties(html) {
  return declaredCustomProperties(html).filter((name) => !html.includes(`var(--${name}`));
}

test('every :root custom property is referenced by a var(--...) somewhere in the file', () => {
  const html = readClientHtml();
  assert.deepEqual(unusedCustomProperties(html), []);
});
