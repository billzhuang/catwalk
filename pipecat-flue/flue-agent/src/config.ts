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
  // A block is "confirmed" once its opening header proved itself a genuine new section — either
  // it opened a fresh paragraph (blank-line-preceded), or there was no prior block at all. A
  // block opened only because the *previous* section had just completed, with no blank line, is
  // left unconfirmed: that header might really just be a note, so a following header can still
  // relabel it (see below).
  const confirmed = new WeakSet<Record<string, string>>();
  let cur: Record<string, string> | null = null;
  for (const line of parseEnvLines(text)) {
    if (line.kind === 'header') {
      // A `#` line starts a new section if it opens a new paragraph (the common aifoundry.sh
      // convention) OR the current block already has both required keys — so a header
      // immediately following a complete section, with no blank line, still starts a new one.
      // Otherwise it's an inline note (e.g. a rotation date) inside the section still being
      // gathered, and must not split that section into two incomplete blocks.
      //
      // But if `cur` is itself still an empty, *unconfirmed* stub (no keys gathered yet, and it
      // was only opened because the previous section had just completed — not because this
      // header opened a fresh paragraph), this header can't be "inline inside" a section that
      // never really started, and pushing a second, sibling stub would bury the prior header's
      // label as an orphan while this one's real section only inherits whatever keys follow.
      // Relabel the still-empty stub in place instead, so a run of blank-line-less headers
      // collapses onto whichever one immediately precedes keys. A *confirmed* stub — one that
      // did open a fresh paragraph, the strong "this is a real section" signal — is left alone:
      // a header can't demote it, only add to it as an inline note (e.g. `# east-us-2` directly
      // followed by `# rotate quarterly`, with neither key yet, must keep the `east-us-2` label).
      if (cur && !confirmed.has(cur) && !cur.apikey && !cur.openai_endpoint) {
        cur.label = line.label;
      } else if (line.freshParagraph || !cur || (cur.apikey && cur.openai_endpoint)) {
        const isNewSection = line.freshParagraph || !cur;
        cur = { label: line.label };
        blocks.push(cur);
        if (isNewSection) confirmed.add(cur);
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
