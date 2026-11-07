// R11: O3 and O4 demonstrated end to end, through the CLI a publisher runs, on the real example blog: not reasoned about from the
// functions (test/order.test.js proves those). The other gates, O1-O10, are each a named test there; the README table maps them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EX, readDirFiles } from './helpers.js';

const run = promisify(execFile);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(root, 'cli', 'blog.js');

async function copyOfExample() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ordering-'));
  await fs.cp(path.join(EX, 'blog'), dir, { recursive: true });
  return dir;
}
const build = (dir) => run('node', [cli, 'build', dir]);
const tree = async (dir) => Object.fromEntries(Object.entries(await readDirFiles(dir)).map(([p, b]) => [p, Buffer.from(b).toString('base64')]));

test('O3: the example blog regenerated twice, from two checkouts, in two processes, is byte-identical to itself and to what is committed', async () => {
  const [a, b] = [await copyOfExample(), await copyOfExample()];
  try {
    // start from nothing generated, so that nothing is "the same" only because it was already there
    for (const d of [a, b]) for (const f of ['index.html', 'feed.xml', 'sitemap.xml', 'index', 'archive', 'tags', 'markdown-is-the-format', 'static-hls-in-git']) await fs.rm(path.join(d, f), { recursive: true, force: true });
    await build(a);
    await build(b);
    const first = await tree(a);
    assert.deepEqual(await tree(b), first, 'two checkouts');
    await build(a);
    assert.deepEqual(await tree(a), first, 'the same checkout again');
    assert.deepEqual(first, await tree(path.join(EX, 'blog')), 'the committed example is what the generator writes');
    assert.ok(Object.keys(first).length > 15);
  } finally {
    await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
  }
});

test('O4: a draft in the middle of a manual order.json is skipped by previous/next: no page, no link, nothing 404s', async () => {
  const dir = await copyOfExample();
  try {
    const blog = JSON.parse(await fs.readFile(path.join(dir, 'blog.json'), 'utf8'));
    blog.order = { by: 'manual' };
    await fs.writeFile(path.join(dir, 'blog.json'), JSON.stringify(blog, null, 2));
    const draft = 'unfinished-thoughts.md';
    assert.match(await fs.readFile(path.join(dir, 'posts', draft), 'utf8'), /^status: draft$/m, 'the example\'s unfinished post is a draft');
    // the draft sits between the two published posts
    await fs.writeFile(path.join(dir, 'order.json'), JSON.stringify({ order: ['static-hls-in-git', 'unfinished-thoughts', 'markdown-is-the-format'] }));
    await build(dir);
    const first = await fs.readFile(path.join(dir, 'static-hls-in-git', 'index.html'), 'utf8');
    const last = await fs.readFile(path.join(dir, 'markdown-is-the-format', 'index.html'), 'utf8');
    assert.match(first, /<link rel="next" href="\.\.\/markdown-is-the-format\/">/, 'next skips the draft');
    assert.doesNotMatch(first, /rel="prev"/);
    assert.match(last, /<link rel="prev" href="\.\.\/static-hls-in-git\/">/, 'prev skips the draft');
    assert.doesNotMatch(last, /rel="next"/);
    await assert.rejects(fs.stat(path.join(dir, 'unfinished-thoughts')), /ENOENT/, 'a draft has no page to 404 on');
    const seq = JSON.parse(await fs.readFile(path.join(dir, 'index', 'posts.json'), 'utf8')).sequence;
    assert.deepEqual(seq, ['static-hls-in-git', 'markdown-is-the-format']);
    for (const f of ['index.html', 'feed.xml', 'sitemap.xml', 'static-hls-in-git/index.html', 'markdown-is-the-format/index.html']) {
      assert.doesNotMatch(await fs.readFile(path.join(dir, f), 'utf8'), /unfinished-thoughts/, `${f} does not mention the draft`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
