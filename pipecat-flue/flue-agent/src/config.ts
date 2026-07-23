import { readFileSync } from 'node:fs';
import { expandHome, parseEnvLines } from './paths.ts';

/**
 * Azure credentials are read at runtime from ~/env/aifoundry.sh and never
 * committed. The file groups two resources under `# east-us-2` / `# east-us-1`
 * comment headers, each with `apikey=` and `openai_endpoint=` (same var names),
 * so we parse it section-aware rather than sourcing it.
 */
export interface AzureBlock {
  label: string;
  apikey: string;
  endpoint: string; // OpenAI-compatible root, e.g. https://<res>.openai.azure.com/openai/v1
}

export function loadBlocks(path = process.env.AIFOUNDRY_ENV ?? '~/env/aifoundry.sh'): AzureBlock[] {
  const text = readFileSync(expandHome(path), 'utf8');
  const blocks: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const line of parseEnvLines(text)) {
    if (line.kind === 'header') {
      // A `#` line starts a new section if it opens a new paragraph (the common aifoundry.sh
      // convention) OR the current block already has both required keys — so a header
      // immediately following a complete section, with no blank line, still starts a new one.
      // Otherwise it's an inline note (e.g. a rotation date) inside the section still being
      // gathered, and must not split that section into two incomplete blocks.
      if (line.freshParagraph || !cur || (cur.apikey && cur.openai_endpoint)) {
        cur = { label: line.label };
        blocks.push(cur);
      }
      continue;
    }
    if (!cur) {
      cur = { label: '(default)' };
      blocks.push(cur);
    }
    if (line.key === 'label') continue; // don't let a stray `label=` line clobber the header's label
    cur[line.key] = line.value;
  }
  return blocks
    .filter((b) => b.apikey && b.openai_endpoint)
    .map((b) => ({ label: b.label, apikey: b.apikey, endpoint: b.openai_endpoint.replace(/\/+$/, '') }));
}

/** Pick the first block whose label or endpoint matches any needle, else index. */
export function pickBlock(blocks: AzureBlock[], needles: string[], fallbackIndex = 0): AzureBlock {
  for (const b of blocks) {
    const hay = `${b.label} ${b.endpoint}`.toLowerCase();
    if (needles.some((n) => hay.includes(n))) return b;
  }
  const b = blocks.at(fallbackIndex) ?? blocks[0];
  if (!b) throw new Error('No Azure credential blocks found in aifoundry.sh');
  return b;
}

/** Chat (gpt-5.4) lives on the east-us-2 resource. */
export function chatBlock(): AzureBlock {
  return pickBlock(loadBlocks(), ['east-us-2'], 0);
}
