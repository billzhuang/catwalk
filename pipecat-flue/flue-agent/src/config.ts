import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Azure credentials are read at runtime from ~/env/aifoundry.sh and never
 * committed. The file groups two resources under `# east-us-2` / `# east-us-1`
 * comment headers, each with `apikey=` and `openapi_endpoint=` (same var names),
 * so we parse it section-aware rather than sourcing it.
 */
export interface AzureBlock {
  label: string;
  apikey: string;
  endpoint: string; // OpenAI-compatible root, e.g. https://<res>.openai.azure.com/openai/v1
}

export function loadBlocks(path = process.env.AIFOUNDRY_ENV ?? '~/env/aifoundry.sh'): AzureBlock[] {
  const file = path.startsWith('~') ? resolve(homedir(), path.slice(2)) : path;
  const text = readFileSync(file, 'utf8');
  const blocks: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (s.startsWith('#')) {
      cur = { label: s.replace(/^#+\s*/, '') };
      blocks.push(cur);
      continue;
    }
    if (!s || !s.includes('=')) continue;
    const [k, ...rest] = s.replace(/^export\s+/, '').split('=');
    const v = rest.join('=').trim().replace(/^["']|["']$/g, '');
    if (!cur) {
      cur = { label: '(default)' };
      blocks.push(cur);
    }
    cur[k.trim().toLowerCase()] = v;
  }
  return blocks
    .filter((b) => b.apikey && b.openapi_endpoint)
    .map((b) => ({ label: b.label, apikey: b.apikey, endpoint: b.openapi_endpoint.replace(/\/+$/, '') }));
}

/** Pick the first block whose label or endpoint matches any needle, else index. */
export function pickBlock(blocks: AzureBlock[], needles: string[], fallbackIndex = 0): AzureBlock {
  for (const b of blocks) {
    const hay = `${b.label} ${b.endpoint}`.toLowerCase();
    if (needles.some((n) => hay.includes(n))) return b;
  }
  const b = blocks[fallbackIndex] ?? blocks[0];
  if (!b) throw new Error('No Azure credential blocks found in aifoundry.sh');
  return b;
}

/** Chat (gpt-5.4) lives on the east-us-2 resource. */
export function chatBlock(): AzureBlock {
  return pickBlock(loadBlocks(), ['us-2', 'esat-us-2'], 0);
}
