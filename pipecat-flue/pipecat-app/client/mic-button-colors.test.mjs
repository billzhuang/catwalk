// Characterization test for #mic's and #mic.live's gradient colors. Both rules re-spell the
// `--blue`/`--red` custom properties as literal hex values instead of referencing them like every
// other rule in the file does, so retuning the palette would silently miss these two gradients.
// Resolves a `var(--name)` reference back to its declared value before comparing, so this test
// pins the *resolved* color (what actually renders) rather than the raw declaration text — it
// stays green whether the rule uses the literal or the custom property.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml } from './test-helpers.mjs';

function customPropertyValue(html, name) {
  const rootMatch = html.match(/:root\s*\{([^}]*)\}/);
  if (!rootMatch) throw new Error(':root block not found in index.html');
  const declMatch = rootMatch[1].match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (!declMatch) throw new Error(`--${name} not declared in :root`);
  return declMatch[1].trim();
}

function resolvedFirstGradientStop(html, selector, customPropertyName) {
  const ruleMatch = html.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
  if (!ruleMatch) throw new Error(`${selector} rule not found in index.html`);
  const gradientMatch = ruleMatch[1].match(/linear-gradient\(145deg,\s*([^,]+),/);
  if (!gradientMatch) throw new Error(`${selector} has no linear-gradient(145deg, ...) background`);
  const stop = gradientMatch[1].trim();
  const varMatch = stop.match(/^var\(--([a-zA-Z0-9-]+)\)$/);
  if (varMatch) return customPropertyValue(html, varMatch[1]);
  assert.equal(stop, customPropertyValue(html, customPropertyName));
  return stop;
}

test('#mic background gradient starts at the --blue custom property value', () => {
  const html = readClientHtml();
  assert.equal(resolvedFirstGradientStop(html, '#mic', 'blue'), customPropertyValue(html, 'blue'));
});

test('#mic.live background gradient starts at the --red custom property value', () => {
  const html = readClientHtml();
  assert.equal(resolvedFirstGradientStop(html, '#mic.live', 'red'), customPropertyValue(html, 'red'));
});
