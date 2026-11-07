// R4/R5: the dependency and licence inventory is generated, current, and a build fails when something unlicensed or copyleft
// reaches the runtime. The inventory is documentation; this test is the mechanism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ALLOWED, acceptable, build, collect, isCopyleft, violations } from '../cli/inventory.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('R4: the committed inventory is exactly what the build generates, and the repository passes its own policy', async () => {
  const { text, violations: found } = await build();
  assert.equal(await fs.readFile(path.join(root, 'licences-inventory.json'), 'utf8'), text, 'run `node cli/inventory.js` and commit licences-inventory.json');
  assert.deepEqual(found, []);
  const inv = JSON.parse(text);
  for (const i of inv.items) {
    assert.ok(i.name && i.licence && i.surfaces.length && i.kind, `${i.name}: name, licence, surface`);
    if (i.kind !== 'first-party') assert.ok(i.upstream || i.kind === 'npm', `${i.name} says where it came from`);
  }
  const by = (n) => inv.items.find((i) => i.name === n);
  assert.deepEqual([by('moment').licence, by('moment').surfaces], ['MIT', ['runtime', 'tool']], 'moment.js is in the generated scripts and the app');
  assert.deepEqual([by('quill').licence, by('quill').surfaces], ['BSD-3-Clause', ['tool']], 'quill is the editor only');
  assert.ok(inv.runtimeBuiltFrom.includes('vendor/moment/moment.esm.js') && inv.runtimeBuiltFrom.every((f) => f.startsWith('lib/') || f.startsWith('vendor/moment/')));
});

test('R5: licence expressions are judged, not string-matched', () => {
  for (const ok of ['MIT', 'BSD-3-Clause', 'Apache-2.0', 'MIT OR GPL-3.0-only', '(MIT OR Apache-2.0)', 'MIT AND BSD-2-Clause', 'ISC']) assert.equal(acceptable(ok, RUNTIME_ALLOWED), true, ok);
  for (const bad of ['GPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'MPL-2.0', 'GPL-2.0-only OR GPL-3.0-only', 'MIT AND GPL-3.0-only', 'UNLICENSED', 'SEE LICENSE IN LICENSE.txt', '', undefined, 'Proprietary']) assert.equal(acceptable(bad, RUNTIME_ALLOWED), false, String(bad));
  assert.ok(isCopyleft('AGPL-3.0-only') && isCopyleft('LGPL-2.1') && isCopyleft('MPL-2.0') && !isCopyleft('MIT') && !isCopyleft('BSD-3-Clause'));
});

test('R5: an unlicensed or copyleft dependency that reaches the runtime fails the build, with the reason', async () => {
  const { items, bundled } = await collect();
  assert.deepEqual(violations(items, bundled), []);
  const swap = (name, patch) => items.map((i) => (i.name === name ? { ...i, ...patch } : i));
  // the vendored formatter becomes copyleft, then unlicensed: both reach the runtime
  let v = violations(swap('moment', { licence: 'GPL-3.0-only' }), bundled);
  assert.equal(v.length, 1);
  assert.match(v[0], /moment .*GPL-3\.0-only.*may not reach the runtime.*copyleft/);
  v = violations(swap('moment', { licence: '' }), bundled);
  assert.match(v.join('\n'), /moment .*has no licence/);
  // a new file in a generated script that no inventoried package or vendored directory owns
  v = violations(items, [...bundled, 'vendor/newcomer/x.js']);
  assert.match(v.join('\n'), /vendor\/newcomer\/x\.js is built into a generated page's script and belongs to no inventoried/);
  v = violations(items, [...bundled, 'app/app.js']);
  assert.match(v.join('\n'), /app\/app\.js is built into a generated page's script/, 'tool code may not be in a page\'s script');
  // a tool-only dependency may be copyleft-compatible, but not incompatible
  assert.deepEqual(violations(swap('quill', { licence: 'GPL-3.0-or-later' }), bundled), []);
  assert.match(violations(swap('quill', { licence: 'GPL-2.0-only' }), bundled).join(), /quill .*GPL-2\.0-only.*cannot include/);
  // dev tools are shipped to no one: a licence is required, copyleft is not a problem
  const esbuild = items.find((i) => i.name === 'esbuild');
  assert.deepEqual(violations(swap('esbuild', { licence: 'GPL-3.0-only' }), bundled), []);
  assert.match(violations(swap('esbuild', { licence: '' }), bundled).join(), /esbuild .*has no licence/);
  assert.ok(esbuild.surfaces.includes('dev') && !esbuild.surfaces.includes('runtime'));
});

test('R5: a directory under vendor/ that does not say what it is fails the build', async () => {
  const dir = path.join(root, 'vendor', 'zz-undeclared');
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(path.join(dir, 'x.js'), 'export const x = 1;\n');
    const { violations: found } = await build();
    assert.match(found.join('\n'), /vendor\/zz-undeclared\/ has no SOURCE\.json/);
    assert.match(found.join('\n'), /zz-undeclared .*has no licence/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual((await build()).violations, []);
});

test('R5: a vendored directory whose licence file is missing is treated as unlicensed', async () => {
  const dir = path.join(root, 'vendor', 'zz-nolicence');
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(path.join(dir, 'SOURCE.json'), JSON.stringify({ name: 'zz-nolicence', version: '1', licence: 'MIT', upstream: 'https://example.com', licenceFile: 'LICENSE' }));
    await fs.writeFile(path.join(dir, 'x.js'), 'export const x = 1;\n');
    const { violations: found } = await build();
    assert.match(found.join('\n'), /zz-nolicence 1 has no licence/, 'a declared licence with no licence text beside the code does not count');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
