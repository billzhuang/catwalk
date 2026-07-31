import { readEnvLines } from './paths.ts';
import { createLazyCache, resolveTrimmedEnv } from './model-config.ts';

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

/** A section still being gathered by loadBlocks's line loop — mutable, unlike the `AzureBlock`
 *  it's later filtered/mapped into once `apikey`/`openai_endpoint` are both present. `confirmed`
 *  used to be tracked out-of-band via a `WeakSet<Record<string, string>>` keyed on the block
 *  object (present only for a block whose opening header proved itself a genuine new section);
 *  it's now an explicit field instead, so "was this block ever confirmed" is a typed property of
 *  the block rather than a second parallel structure callers had to keep in sync. Mirrors
 *  azure.py's `_ScanBlock` dataclass, which already made this same change. */
interface ScanBlock {
  label: string;
  confirmed: boolean;
  apikey: string;
  openai_endpoint: string;
}

/** Applies a single header (`# ...`) line to the in-progress block scan, deciding whether it
 *  starts a new section, relabels the still-empty stub currently being gathered, or is just an
 *  inline note inside the section already in progress. Returns the block that should be `cur`
 *  after this line. Pulled out of loadBlocks's line loop because this is the single trickiest
 *  decision in the parser, and keeping it in its own function lets it be reasoned about (and
 *  tested via loadBlocks) independently of the surrounding key=value scan.
 *
 *  A `#` line starts a new section if it opens a new paragraph (the common aifoundry.sh
 *  convention) OR the current block already has both required keys — so a header immediately
 *  following a complete section, with no blank line, still starts a new one. Otherwise it's an
 *  inline note (e.g. a rotation date) inside the section still being gathered, and must not split
 *  that section into two incomplete blocks.
 *
 *  But if `cur` is itself still an empty, *unconfirmed* stub (no keys gathered yet, and it was
 *  only opened because the previous section had just completed — not because this header opened
 *  a fresh paragraph), this header can't be "inline inside" a section that never really started,
 *  and pushing a second, sibling stub would bury the prior header's label as an orphan while this
 *  one's real section only inherits whatever keys follow. Relabel the still-empty stub in place
 *  instead, so a run of blank-line-less headers collapses onto whichever one immediately precedes
 *  keys. A *confirmed* stub — one that did open a fresh paragraph, the strong "this is a real
 *  section" signal — is left alone: a header can't demote it, only add to it as an inline note
 *  (e.g. `# east-us-2` directly followed by `# rotate quarterly`, with neither key yet, must keep
 *  the `east-us-2` label).
 *
 *  The fresh-paragraph/complete-section check runs FIRST, before the stub-relabel check: a fresh
 *  paragraph is the strong "this is really a new section" signal and must win even when `cur` is
 *  itself an unconfirmed stub — otherwise a stub gets relabeled onto a fresh-paragraph header
 *  without ever being marked confirmed, so a *later* blank-line-less note can still relabel it a
 *  second time and silently steal the real section's label before its credentials arrive. */
function applyHeaderLine(
  cur: ScanBlock | null,
  blocks: ScanBlock[],
  line: { label: string; freshParagraph: boolean },
): ScanBlock | null {
  if (line.freshParagraph || !cur || (cur.apikey && cur.openai_endpoint)) {
    const isNewSection = line.freshParagraph || !cur;
    const next: ScanBlock = { label: line.label, confirmed: isNewSection, apikey: '', openai_endpoint: '' };
    blocks.push(next);
    return next;
  }
  if (!cur.confirmed && !cur.apikey && !cur.openai_endpoint) {
    cur.label = line.label;
    return cur;
  }
  return cur;
}

export function loadBlocks(path = resolveTrimmedEnv(process.env.AIFOUNDRY_ENV, '~/env/aifoundry.sh')): AzureBlock[] {
  const blocks: ScanBlock[] = [];
  let cur: ScanBlock | null = null;
  for (const line of readEnvLines(path)) {
    if (line.kind === 'header') {
      cur = applyHeaderLine(cur, blocks, line);
      continue;
    }
    if (!cur) {
      cur = { label: '(default)', confirmed: false, apikey: '', openai_endpoint: '' };
      blocks.push(cur);
    }
    // Only apikey/openai_endpoint ever feed the AzureBlock returned below (mirrors azure.py's
    // load_blocks), so any other key (a stray `label=` line, or an unrecognized one) is
    // intentionally ignored here rather than stored.
    if (line.key === 'apikey') cur.apikey = line.value;
    else if (line.key === 'openai_endpoint') cur.openai_endpoint = line.value;
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

const chatBlockCache = createLazyCache<AzureBlock>(() => pickBlock(loadBlocks(), ['east-us-2'], 0));

/** Test-only: clear the memoized chat block so tests can exercise chatBlock's
 *  file-parsing path independently instead of relying on test execution order. */
export function _resetChatBlockCacheForTests(): void {
  chatBlockCache.resetForTests();
}

/** Chat (gpt-5.4) lives on the east-us-2 resource. Memoized once resolved — this is called on
 *  every /v1/chat/completions request (azure-proxy.ts), so without caching we'd readFileSync and
 *  re-run the section-aware parse of aifoundry.sh on every single LLM turn. */
export function chatBlock(): AzureBlock {
  return chatBlockCache.get();
}
