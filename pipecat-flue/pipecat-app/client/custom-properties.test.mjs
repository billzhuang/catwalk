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

// --blue-rgb/--red-rgb (used by rgba(var(--blue-rgb), alpha) box-shadows, since rgba() only takes
// a per-color alpha as a fourth argument the hex --blue/--red properties can't supply on their
// own) are the same colors as --blue/--red in a different format. Nothing at parse/render time
// checks the two stay in sync, so this pins that they can't silently drift apart.
function rootCustomPropertyValue(html, name) {
  const rootMatch = html.match(/:root\s*\{([^}]*)\}/);
  const m = rootMatch[1].match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} not declared in :root`);
  return m[1].trim();
}

function hexToRgbTriplet(hex) {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`not a #rrggbb hex color: ${hex}`);
  return m.slice(1, 4).map((h) => parseInt(h, 16)).join(', ');
}

test('--blue-rgb/--red-rgb decompose their hex --blue/--red counterparts', () => {
  const html = readClientHtml();
  for (const [hexName, rgbName] of [['blue', 'blue-rgb'], ['red', 'red-rgb']]) {
    assert.equal(rootCustomPropertyValue(html, rgbName), hexToRgbTriplet(rootCustomPropertyValue(html, hexName)));
  }
});
