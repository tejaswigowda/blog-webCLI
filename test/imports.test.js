// Every named import in the product must resolve to a real export. Browser-only modules (the editor,
// the reader) cannot be imported in Node, so this reads them: a module that imports something another
// module no longer exports fails here, not on a user's screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function files(dir) {
  const out = [];
  for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (/\.m?js$/.test(e.name) && !e.name.startsWith('.')) out.push(p);
  }
  return out;
}

const exportsOf = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
};

test('every named import resolves to an export of the module it names', async () => {
  const sources = [...(await files('lib')), ...(await files('app')), ...(await files('blog')), ...(await files('cli'))];
  let checked = 0;
  for (const file of sources) {
    const src = await fs.readFile(path.join(root, file), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.join(path.dirname(file), m[2]);
      const targetSrc = await fs.readFile(path.join(root, target), 'utf8').catch(() => null);
      assert.ok(targetSrc !== null, `${file} imports ${m[2]}, which does not exist`);
      const have = exportsOf(targetSrc);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        assert.ok(have.has(name), `${file} imports { ${name} } from ${m[2]}, which does not export it`);
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `only ${checked} imports were checked`);
});

test('every relative module the pages load exists', async () => {
  for (const [html, base] of [['index.html', '.'], ['blog/index.html', 'blog']]) {
    const src = await fs.readFile(path.join(root, html), 'utf8');
    for (const m of src.matchAll(/(?:src|href)="(?!https?:|#|data:)([^"]+)"/g)) {
      await fs.access(path.join(root, base, m[1])).catch(() => assert.fail(`${html} references ${m[1]}, which does not exist`));
    }
  }
});
