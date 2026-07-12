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

/** Parse an already-filtered (non-blank, non-comment, `=`-containing) `[export] KEY=VALUE`
 *  line from a `~/env/*.sh` file: strips a leading `export ` and surrounding quotes from the
 *  value, and lowercases the key. Shared by config.ts's section-aware aifoundry.sh parser and
 *  websearch.ts's brave.sh key lookup. */
export function parseKeyValue(line: string): [key: string, value: string] {
  const [k, ...rest] = line.replace(/^export\s+/, '').split('=');
  const value = rest.join('=').trim().replace(/^["']|["']$/g, '');
  return [k.trim().toLowerCase(), value];
}
