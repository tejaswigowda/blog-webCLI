// R9: the shared renderer is platform-neutral. The generator (Node, the CLI and the editor's publish path) and the page's script
// (a browser) import the same modules, so a module that reaches for a Node built-in, a DOM global or a package outside the runtime
// directory would be two renderers again. esbuild bundles the renderer for the "neutral" platform, which resolves no built-in; and
// every free reference to a Node or DOM global is rewritten to a marker, which is scope-aware (a local named `document` is fine,
// a comment or a string is fine) where a text search would not be.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['lib/blog.js', 'lib/live-render.js', 'lib/preview.js'].map((f) => path.join(root, f));
const RUNTIME_DIRS = ['lib/', 'vendor/moment/'];
const GLOBALS = ['document', 'window', 'self', 'localStorage', 'sessionStorage', 'navigator', 'DOMParser', 'XMLHttpRequest', 'HTMLElement', 'process', 'Buffer', 'require', '__dirname', '__filename', 'global'];

// -> { inputs: [file…], globals: [name…] }; rejects when something cannot be resolved on a neutral platform.
export async function inspectRenderer(entries = ENTRIES) {
  const r = await build({
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: path.join(os.tmpdir(), 'neutral-out'),
    format: 'esm',
    platform: 'neutral',
    metafile: true,
    logLevel: 'silent',
    absWorkingDir: root,
    define: Object.fromEntries(GLOBALS.map((n) => [n, `__PLATFORM_${n}__`])),
  });
  const out = r.outputFiles.map((f) => f.text).join('\n');
  return { inputs: Object.keys(r.metafile.inputs).sort(), globals: [...new Set(out.match(/__PLATFORM_\w+__/g) || [])].map((m) => m.slice(11, -2)) };
}

test('R9: the renderer imports no Node built-in and no package, and reaches for no Node or DOM global', async () => {
  const { inputs, globals } = await inspectRenderer();
  assert.ok(inputs.length > 20, `${inputs.length} modules are reachable from the generator and the live renderer`);
  assert.deepEqual(globals, [], 'a platform-specific global in the shared renderer');
});

test('R9: every module the renderer reaches is in the runtime directories, which are the only ones a generated page ships', async () => {
  const { inputs } = await inspectRenderer();
  const outside = inputs.filter((f) => !RUNTIME_DIRS.some((d) => f.startsWith(d)));
  assert.deepEqual(outside, [], 'the renderer imports from outside the runtime directories');
});

test('R9: a Node-only import in the shared renderer fails the build', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neutral-'));
  try {
    for (const [name, text] of [
      ['fs.mjs', "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n"],
      ['bare.mjs', "import { createHash } from 'crypto';\nexport const x = createHash;\n"],
      ['pkg.mjs', "import x from 'left-pad';\nexport default x;\n"],
    ]) {
      const f = path.join(dir, name);
      await fs.writeFile(f, `${text}export * from ${JSON.stringify(path.join(root, 'lib', 'blog.js'))};\n`);
      await assert.rejects(inspectRenderer([f]), undefined, name);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R9: a DOM or Node global in the shared renderer is found, and a local of the same name, a comment or a string is not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neutral-'));
  try {
    const bad = path.join(dir, 'bad.mjs');
    await fs.writeFile(bad, 'export const a = () => document.title;\nexport const b = () => process.env.X;\nexport const c = (s) => Buffer.from(s);\nexport const d = () => window.location;\n');
    assert.deepEqual((await inspectRenderer([bad])).globals.sort(), ['Buffer', 'document', 'process', 'window']);
    const fine = path.join(dir, 'fine.mjs');
    await fs.writeFile(fine, "// document, window, process and Buffer are mentioned here\nexport const a = (document) => document.title;\nexport const b = 'process.env and window';\nexport const c = { process: 1 }.process;\nexport const d = globalThis.location;\n");
    assert.deepEqual((await inspectRenderer([fine])).globals, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R9: the browser-only entry points are the only modules that touch the DOM, and nothing the generator imports imports them', async () => {
  const { inputs } = await inspectRenderer();
  for (const f of ['lib/live-entry.js', 'lib/search-entry.js', 'lib/search-client.js']) assert.ok(!inputs.includes(f), `${f} is DOM-facing and is not part of the shared renderer`);
});
