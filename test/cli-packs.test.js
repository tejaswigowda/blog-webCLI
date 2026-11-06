import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSiteWith } from '../lib/build-async.js';
import { loadExtension } from '../lib/extensions.js';
import { EX } from './helpers.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli', 'blog.js');
const PRELOAD = path.join(here, 'fetch-preload.mjs');

const cli = (args, env = {}) => run('node', ['--import', PRELOAD, CLI, ...args], { env: { ...process.env, ...env } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
async function blogDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-packs-'));
  await fs.cp(path.join(EX, 'blog'), d, { recursive: true });
  return d;
}
const readBlog = async (d) => JSON.parse(await fs.readFile(path.join(d, 'blog.json'), 'utf8'));

test('CLI: theme pin fetches as data, records the pin, and build/check regenerate from it', async () => {
  const d = await blogDir();
  const pin = await cli(['theme', 'pin', 'me/theme@v1.0.0', d]);
  assert.equal(pin.code, 0, pin.stderr);
  assert.match(pin.stdout, /pinned theme Plain Paper 1\.0\.0 \(MIT\)/);
  const blog = await readBlog(d);
  assert.equal(blog.theme.ref, 'v1.0.0');
  assert.match(blog.theme.sha256, /^[0-9a-f]{64}$/);
  assert.equal(blog.theme.contract, 'blog-webcli-v1');

  assert.equal((await cli(['check', d])).code, 1, 'pages are stale until built');
  const built = await cli(['build', d]);
  assert.equal(built.code, 0, built.stderr);
  const files = await fs.readdir(d);
  assert.ok(files.includes('theme.css'));
  assert.equal((await cli(['check', d])).code, 0);
  assert.ok((await fs.readFile(path.join(d, 'index.html'), 'utf8')).includes('--wp--preset--color--primary:#8a3b12'));

  // a hand edit to the generated css is caught (gate B8 covers the theme)
  await fs.appendFile(path.join(d, 'theme.css'), 'body{display:none}');
  const bad = await cli(['check', d]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /differs\s+theme\.css/);

  const lic = await cli(['licences', d]);
  assert.match(lic.stdout, /theme\s+Plain Paper\s+1\.0\.0\s+MIT\s+me\/theme@v1\.0\.0/);

  const clear = await cli(['theme', 'clear', d]);
  assert.equal(clear.code, 0);
  assert.equal((await cli(['build', d])).code, 0);
  assert.ok(!(await fs.readdir(d)).includes('theme.css'), 'theme.css is removed with the theme');
  assert.equal((await cli(['check', d])).code, 0);
});

test('CLI: a branch, a missing ref, or an unpinned spec is refused', async () => {
  const d = await blogDir();
  const before = await fs.readFile(path.join(d, 'blog.json'), 'utf8');
  for (const [spec, re] of [['me/theme@main', /refused: unpinned-ref.*branch/s], ['me/theme', /refused: unpinned-ref.*owner\/repo@/s], ['me/theme@v9.9.9', /refused: unpinned-ref.*no tag/s]]) {
    const r = await cli(['theme', 'pin', spec, d]);
    assert.equal(r.code, 1, spec);
    assert.match(r.stderr, re, spec);
  }
  assert.equal(await fs.readFile(path.join(d, 'blog.json'), 'utf8'), before, 'blog.json is untouched by a refusal');
});

test('CLI: it never runs extension code, even when the extension is pinned and its output recorded', async () => {
  const d = await blogDir();
  const marker = path.join(d, 'TRAP-RAN');
  const add = await cli(['ext', 'add', 'me/trap@v1.0.0', d], { TRAP_MARKER: marker });
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /It has not been run/);
  assert.equal((await readBlog(d)).extensions[0].repo, 'me/trap');

  // no recorded output: build refuses and says where extensions run
  const refused = await cli(['build', d], { TRAP_MARKER: marker });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refused: extension-output-missing.*editor/s);

  // Record outputs the way the editor would, but with a runner that returns canned text and does not
  // execute the source. The extension's source is the trap: running it would write the marker file.
  const blog = await readBlog(d);
  const manifest = await fs.readFile(path.join(EX, 'ext-reading-time', 'extension.json'));
  const trapSource = `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TRAP_MARKER || '/tmp/trap-marker', 'RAN');\nexport const hooks = { 'post:html': (h) => h };`;
  const ext = loadExtension(blog.extensions[0], { 'extension.json': new Uint8Array(manifest), 'index.mjs': new TextEncoder().encode(trapSource) });
  const posts = await Promise.all((await fs.readdir(path.join(d, 'posts'))).map(async (f) => ({ path: `posts/${f}`, text: await fs.readFile(path.join(d, 'posts', f), 'utf8') })));
  const result = await buildSiteWith(
    { blog: JSON.stringify(blog), lock: JSON.parse(await fs.readFile(path.join(d, 'assets.lock.json'), 'utf8')), extensions: [ext], posts },
    async ({ input }) => `<p class="reading-time">canned</p>${input}`,
  );
  assert.deepEqual(result.errors, []);
  await fs.writeFile(path.join(d, 'extension-outputs.json'), result.files['extension-outputs.json']);

  const built = await cli(['build', d], { TRAP_MARKER: marker });
  assert.equal(built.code, 0, built.stderr);
  assert.equal((await cli(['check', d], { TRAP_MARKER: marker })).code, 0);
  assert.ok((await fs.readFile(path.join(d, 'static-hls-in-git', 'index.html'), 'utf8')).includes('class="reading-time">canned'));
  await assert.rejects(fs.access(marker), 'the extension\'s code was never executed by the CLI');
  await assert.rejects(fs.access('/tmp/trap-marker'));
});

test('CLI: extension remove cleans up, and a tampered extension-outputs.json is detected', async () => {
  const d = await blogDir();
  await cli(['ext', 'add', 'me/ext@v1.0.0', d]);
  const out = path.join(d, 'extension-outputs.json');
  await fs.writeFile(out, JSON.stringify({ version: 1, outputs: { ['f'.repeat(64)]: { extension: 'x', hook: 'post:html', output: '<script>alert(1)</script>' } } }));
  const r = await cli(['build', d]);
  assert.equal(r.code, 1, 'unrelated recorded outputs do not satisfy a pinned extension');
  assert.match(r.stderr, /extension-output-missing/);
  const rm = await cli(['ext', 'remove', 'me/ext', d]);
  assert.equal(rm.code, 0);
  assert.ok(!('extensions' in (await readBlog(d))));
  assert.equal((await cli(['build', d])).code, 0);
  assert.ok(!(await fs.readdir(d)).includes('extension-outputs.json'), 'the stale file is removed');
});
