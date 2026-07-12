import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Sets each env var for the duration of `fn`, restoring the prior value (or
 * deleting it, if it wasn't set) afterward. Pass `undefined` for a var that
 * should be deleted for the duration of `fn`.
 */
export function withEnvVars(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Writes `contents` to a fresh temp-dir file named `filename` for the duration of `fn`. */
export function withTempFile(prefix: string, filename: string, contents: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, filename);
  writeFileSync(file, contents);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
