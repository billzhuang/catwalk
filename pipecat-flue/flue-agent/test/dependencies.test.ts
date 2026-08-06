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

// Matches both a static `import ... from '<pkg>'`/`export ... from '<pkg>'` and a dynamic
// `import('<pkg>')` call — telemetry.ts's initTelemetry() lazily `import()`s its OTel exporter
// packages so a static-only regex would miss them entirely, wrongly flagging @opentelemetry/
// exporter-trace-otlp-http, resources, sdk-trace-node, and semantic-conventions as unused below.
const IMPORT_RE = /(?:^\s*(?:import|export)\b[^;]*\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\))/gm;

function importedPackageNames(): Set<string> {
  const names = new Set<string>();
  for (const file of listTsFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
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

test('every package declared under dependencies is imported somewhere by src/', () => {
  // The mirror image of the test above: a "dependencies" entry that src/ never actually imports
  // is dead weight that silently drifts from what the code needs — e.g. a package only ever used
  // transitively (through another declared dependency), never directly, doesn't belong listed
  // here in its own right.
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const imported = importedPackageNames();

  const unused = [...declared].filter((name) => !imported.has(name));
  assert.deepEqual(unused, []);
});
