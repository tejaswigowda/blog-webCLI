// vendor/hls is hls-webCLI's encoder, copied and never edited (GPL-3.0, like the app).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'vendor', 'hls');

async function walk(d, out = []) {
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(path.relative(dir, p).split(path.sep).join('/'));
  }
  return out;
}

test('vendored: every file is exactly what was copied, and nothing else is in the folder', async () => {
  const sources = JSON.parse(await fs.readFile(path.join(dir, 'SOURCES.json'), 'utf8'));
  assert.match(sources.commit, /^[0-9a-f]{40}$/);
  assert.equal(sources.origin, 'https://github.com/tejaswigowda/hls-webCLI');
  const have = (await walk(dir)).filter((f) => f !== 'SOURCES.json' && f !== 'VENDORED.md').sort();
  assert.deepEqual(have, Object.keys(sources.files).sort(), 'the folder holds exactly the recorded files');
  for (const [file, sha] of Object.entries(sources.files)) {
    const got = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, file))).digest('hex');
    assert.equal(got, sha, `${file} was edited; re-vendor it instead (see VENDORED.md)`);
  }
});

test('vendored: the licence travels with it, and the app that includes it says the same', async () => {
  const lic = await fs.readFile(path.join(dir, 'LICENSE'), 'utf8');
  assert.match(lic, /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.equal(await fs.readFile(path.join(root, 'LICENSE'), 'utf8'), lic, 'the app carries the same licence text');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'GPL-3.0-only');
  const sources = JSON.parse(await fs.readFile(path.join(dir, 'SOURCES.json'), 'utf8'));
  assert.equal(sources.licence, 'GPL-3.0-only');
});

test('vendored: it is reachable only from the editor, never from the token-free reader', async () => {
  for (const f of ['blog/reader.js', 'app/reader-core.js', 'app/read.js']) {
    assert.ok(!/vendor\/hls|encode\.js|release\.js/.test(await fs.readFile(path.join(root, f), 'utf8')), `${f} must not import the encoder`);
  }
});
