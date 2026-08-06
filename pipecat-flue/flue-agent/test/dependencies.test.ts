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

// Four import shapes this scanner recognizes, as alternatives (each with its own capture group,
// read off by whichever one matched in importedPackageNamesFromText below):
//   1. `import ... from '<pkg>'` / `export ... from '<pkg>'` — the common case.
//   2. `import '<pkg>'` — a side-effect-only import, no `from`.
//   3. `import('<pkg>')` — a dynamic import with a plain string literal. telemetry.ts's
//      initTelemetry() lazily `import()`s its OTel exporter packages this way, so a static-only
//      regex would miss them entirely, wrongly flagging @opentelemetry/exporter-trace-otlp-http,
//      resources, sdk-trace-node, and semantic-conventions as unused below.
//   4. `` import(`<pkg>`) `` — the same, with a template literal instead of a plain string.
//      Excludes one containing `${...}` interpolation: a specifier built at runtime isn't a fixed
//      package name this static scanner could ever resolve, with or without this alternative.
// Not a full parser — deliberately so, for a lightweight scanner over this package's own known,
// small `src/` tree; see stripComments below for how it avoids matching a merely-quoted example
// in a comment.
const IMPORT_RE =
  /(?:^\s*(?:import|export)\b[^;]*\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*`([^`$]+)`\s*\))/gm;

// This codebase's own doc comments routinely quote another file's code shape verbatim (e.g. "X
// lazily `import()`s its OTel exporter packages" right above) — a dynamic-import mention inside a
// comment isn't executable code, so it must not feed the same regex as a real import. Strips block
// comments first (so a multi-line /** ... */ can't leave a partial line-comment stripe behind), then
// line comments — excluding a `//` immediately preceded by `:`, so a same-line `https://...` URL
// literal (common in this repo's tool modules) isn't itself truncated by the line-comment strip.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

/** The regex-matching core of importedPackageNames(), pulled out so it can be exercised directly
 *  against a literal string in a test rather than only indirectly via real files under src/. */
export function importedPackageNamesFromText(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of stripComments(text).matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
    names.add(packageNameFromSpecifier(specifier));
  }
  return names;
}

function importedPackageNames(): Set<string> {
  const names = new Set<string>();
  for (const file of listTsFiles(srcDir)) {
    for (const name of importedPackageNamesFromText(readFileSync(file, 'utf8'))) names.add(name);
  }
  return names;
}

test('importedPackageNamesFromText recognizes every import shape and ignores comment-only mentions', () => {
  const text = `
// mirrors another module's dynamic import('comment-only-fake-pkg') call
/** also not real, and spans a line break:
 *  import('block-comment-fake-pkg')
 */
import { readFileSync } from 'node:fs';
import realNamedThing from 'real-named-pkg';
import 'real-side-effect-pkg';
export { thing } from 'real-reexport-pkg';
const p1 = await import('real-dynamic-pkg');
const p2 = await import(\`real-template-dynamic-pkg\`);
const p3 = await import(\`\${dynamicPrefix}/cant-resolve-this-one\`);
const url = 'https://example.com/not/an/import'; // a same-line comment must not eat this string
`;
  const names = importedPackageNamesFromText(text);
  assert.deepEqual(
    [...names].sort(),
    [
      'real-dynamic-pkg',
      'real-named-pkg',
      'real-reexport-pkg',
      'real-side-effect-pkg',
      'real-template-dynamic-pkg',
    ].sort(),
  );
});

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
