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
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.html`);
  const braceStart = html.indexOf('{', start);
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
