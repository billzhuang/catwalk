import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function importedPackageNames(): Set<string> {
  const importRe = /^\s*(?:import|export)\b[^;]*\bfrom\s+['"]([^'"]+)['"]/gm;
  const names = new Set<string>();
  for (const file of listTsFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(importRe)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      names.add(packageNameFromSpecifier(specifier));
    }
  }
  return names;
}

test('every package imported by src/ is declared under package.json dependencies (not just devDependencies)', () => {
  // A production install (`npm install --omit=dev`) only installs "dependencies" — a bare
  // specifier that only resolves through a devDependency's transitive chain (e.g. undici, which
  // was only pulled in by @flue/cli's own miniflare dep) crashes flue-agent at startup the moment
  // the file that imports it loads, since npm won't have installed it at all.
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const imported = importedPackageNames();

  assert.ok(imported.size > 0, 'expected to find at least one bare import under src/');
  const undeclared = [...imported].filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, []);
});
