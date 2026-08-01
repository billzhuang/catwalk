// Characterization test for the CSS applied to the two "pill button" elements — the topic
// `.chip`s and the presentation-mode `#stage-exit` button. They share an identical base look
// (dark pill, thin line border, light text, fully-rounded corners, pointer cursor) and only
// differ in size/hover color, but that shared declaration set is duplicated verbatim rather than
// factored into one rule. Pins the actual applied declarations (not the raw rule text), so the
// duplication can be merged into a combined selector without this test needing to change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClientHtml } from './test-helpers.mjs';

// Returns every declaration (as "prop: value" strings) from every CSS rule in the <style> block
// whose selector list includes `selector` — merging across rules the way the cascade would, since
// this test only cares what ends up applied, not how many source rules produced it.
function declarationsForSelector(html, selector) {
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleMatch) throw new Error('<style> block not found in index.html');
  const rules = [...styleMatch[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const decls = [];
  for (const [, selectorList, body] of rules) {
    const selectors = selectorList.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const raw of body.split(';')) {
      const decl = raw.trim();
      if (decl) decls.push(decl);
    }
  }
  return decls;
}

const SHARED_BASE_LOOK = [
  'background: #20203a',
  'border: 1px solid var(--line)',
  'color: #d7dbef',
  'border-radius: 999px',
  'cursor: pointer',
];

test('.chip and #stage-exit both apply the shared pill-button base look', () => {
  const html = readClientHtml();
  for (const selector of ['.chip', '#stage-exit']) {
    const decls = declarationsForSelector(html, selector);
    for (const shared of SHARED_BASE_LOOK) {
      assert.ok(decls.includes(shared), `${selector} should declare "${shared}"`);
    }
  }
});

test('.chip and #stage-exit keep their own distinct sizing', () => {
  const html = readClientHtml();
  const chip = declarationsForSelector(html, '.chip');
  const stageExit = declarationsForSelector(html, '#stage-exit');
  assert.ok(chip.includes('padding: 8px 15px'));
  assert.ok(chip.includes('font-size: 13.5px'));
  assert.ok(stageExit.includes('padding: 9px 16px'));
  assert.ok(stageExit.includes('font-size: 14px'));
});
