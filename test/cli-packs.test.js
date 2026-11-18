import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

test('CLI: build and check regenerate new and edited content without recorded output', async () => {
  const dir = await blogDir();
  const file = path.join(dir, 'posts', 'new-post.md');
  await fs.writeFile(file, '---\nslug: new-post\ntitle: New post\ndate: 2026-11-15\nstatus: published\ncontents: true\n---\n\n## First\n\n## Second\n\n### Third\n');
  assert.equal((await cli(['build', dir])).code, 0);
  assert.equal((await cli(['check', dir])).code, 0);
  const page = path.join(dir, 'new-post', 'index.html');
  assert.match(await fs.readFile(page, 'utf8'), /class="toc"/);
  await fs.appendFile(file, '\nNew content.\n');
  assert.equal((await cli(['check', dir])).code, 1, 'source edits are detected, not blocked by coverage');
  assert.equal((await cli(['build', dir])).code, 0);
  assert.equal((await cli(['check', dir])).code, 0);
  assert.match(await fs.readFile(page, 'utf8'), /New content\./);
});

test('CLI: retired ext subcommands are not available', async () => {
  const result = await cli(['ext', 'add', 'me/ext@v1.0.0']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage:/);
});

test('CLI: check refuses an inaccessible or HTML pinned image anonymously', async () => {
  const d = await blogDir();
  assert.equal((await cli(['build', d])).code, 0);
  for (const [env, detail] of [[{ TEST_ASSET_STATUS: '404' }, /HTTP 404/], [{ TEST_ASSET_HTML: '1' }, /returned HTML/]]) {
    const result = await cli(['check', d], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, detail);
  }
  assert.match((await cli(['check', d])).stdout, /anonymous asset check passed/);
});

test('CLI: links counts outbound authored anchors, sorted, including pages but not drafts', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-links-'));
  await fs.mkdir(path.join(d, 'posts'));
  await fs.mkdir(path.join(d, 'pages'));
  await fs.writeFile(path.join(d, 'blog.json'), JSON.stringify({ title: 'T', description: 'D', author: 'A', domain: 'https://site.test', affiliates: ['shop.test'] }));
  await fs.writeFile(path.join(d, 'posts', 'a.md'), '---\nslug: a\ntitle: A\ndate: 2026-01-01\nstatus: published\n---\n\n[**Shop** now](https://www.shop.test/a) [internal](https://site.test/x) [other](https://other.test/x)\n');
  await fs.writeFile(path.join(d, 'pages', 'b.md'), '---\nslug: b\ntitle: B\nstatus: published\n---\n\n<p><a href="https://www.shop.test/b">Buy</a></p>\n');
  await fs.writeFile(path.join(d, 'posts', 'draft.md'), '---\nslug: draft\ntitle: Draft\ndate: 2026-01-01\nstatus: draft\n---\n\n[Hidden](https://hidden.test/)\n');
  const result = await cli(['links', d]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^www\.shop\.test\t2\tmarked affiliate\nother\.test\t1\tunmarked\n2 outbound hosts, 1 marked affiliate\n$/);
  const built = await cli(['build', d]);
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stdout, /2 outbound hosts, 1 marked affiliate/);
});
