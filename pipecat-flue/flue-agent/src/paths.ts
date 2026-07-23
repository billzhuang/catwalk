import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Expand a leading `~` to the user's home directory — the `~/env/*.sh` runtime-secret
 *  convention shared by config.ts's aifoundry.sh loader and websearch.ts's brave.sh loader.
 *  Pure, unit-testable. Only an exact `~` or a `~/`-prefixed path is expanded; a path like
 *  `~foo` (no separator) is a different, unsupported shell convention and passes through
 *  unchanged rather than being mis-sliced. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

/** Strip every leading '#' or ' ' character from a header line, mirroring bot/azure.py's
 *  `s.lstrip("# ")`: a character-class strip that keeps consuming '#'/' ' regardless of how
 *  they're grouped, unlike a single `^#+\s*` regex pass (which stops after one run of '#' plus
 *  one run of whitespace and would leave a second '#' — e.g. a label that itself starts with
 *  '#' — in place). The two "parity" parsers must agree on this same ~/env/aifoundry.sh file. */
function stripHeaderHashes(s: string): string {
  return s.replace(/^[# ]+/, '');
}

/** Parse an already-filtered (non-blank, non-comment, `=`-containing) `[export] KEY=VALUE`
 *  line from a `~/env/*.sh` file: strips a leading `export ` and surrounding quotes from the
 *  value, and lowercases the key. Shared by config.ts's section-aware aifoundry.sh parser and
 *  websearch.ts's brave.sh key lookup. */
export function parseKeyValue(line: string): [key: string, value: string] {
  const [k, ...rest] = line.replace(/^export\s+/, '').split('=');
  const value = rest.join('=').trim().replace(/^["']|["']$/g, '');
  return [k.trim().toLowerCase(), value];
}

/** A classified, non-skippable line from a `~/env/*.sh` file: either a `# comment` section
 *  header, or a parsed `key=value` pair. Blank lines and non-`=` lines are dropped. A header
 *  carries `freshParagraph`: whether it opened a new paragraph (start of file, or right after a
 *  blank line) — one of two signals config.ts's loadBlocks uses to decide whether a `#` line is
 *  a genuine new section or just an inline comment inside the current one. */
export type EnvLine =
  | { kind: 'header'; label: string; freshParagraph: boolean }
  | { kind: 'pair'; key: string; value: string };

/** Scan a `~/env/*.sh` file's text into headers and key=value pairs, sharing the
 *  split/trim/skip-blank/skip-non-`=` scan that config.ts's section-aware aifoundry.sh parser
 *  and websearch.ts's single-key brave.sh lookup both otherwise duplicate. Every `#` line is
 *  still emitted as a header (unconditionally, as before) — it's up to the caller to decide,
 *  using `freshParagraph` plus its own notion of section completeness, whether a given header
 *  actually starts a new block. */
export function parseEnvLines(text: string): EnvLine[] {
  const out: EnvLine[] = [];
  let precededByBlank = true;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s) {
      precededByBlank = true;
      continue;
    }
    if (s.startsWith('#')) {
      out.push({ kind: 'header', label: stripHeaderHashes(s), freshParagraph: precededByBlank });
      precededByBlank = false;
      continue;
    }
    precededByBlank = false;
    if (!s.includes('=')) continue;
    const [key, value] = parseKeyValue(s);
    out.push({ kind: 'pair', key, value });
  }
  return out;
}
