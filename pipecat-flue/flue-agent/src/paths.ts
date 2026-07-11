import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Expand a leading `~` to the user's home directory — the `~/env/*.sh` runtime-secret
 *  convention shared by config.ts's aifoundry.sh loader and websearch.ts's brave.sh loader.
 *  Pure, unit-testable. Paths that don't start with `~` pass through unchanged. */
export function expandHome(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(2)) : path;
}
