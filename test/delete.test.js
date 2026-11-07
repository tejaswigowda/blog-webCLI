// Deleting a post: planned as the post going back to a draft (which already takes it out of every list, the feed, the sitemap and search
// and removes its page and redirects) plus the removal of its source file, so what is left is exactly what a build of the remaining
// posts gives. Small blogs, a big blog built incrementally, a hand-kept order, and the refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSite } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, planChange } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';
import { EX, readDirFiles } from './helpers.js';

const dec = new TextDecoder();
const text = (v) => (typeof v === 'string' ? v : dec.decode(v));
const code = (c) => (e) => e instanceof Refusal && e.code === c;
const connect = async (repos) => {
  const server = fakeGitHub(repos);
  await server.ready;
  return { server, gh: new GitHub(createNet(server.fetch), { token: 'github_pat_test' }) };
};
const sources = (files) => Object.entries(files).filter(([p]) => /^posts\/[^/]+\.md$/.test(p)).map(([p, t]) => ({ path: p, text: text(t) }));

// every file the build writes is what the repository now holds, and nothing it generated is left over
function assertBuilt(files, what) {
  const r = buildSite({ blog: text(files['blog.json']), posts: [...sources(files), ...Object.entries(files).filter(([p]) => /^pages\/[^/]+\.md$/.test(p)).map(([p, t]) => ({ path: p, text: text(t) }))], lock: JSON.parse(text(files['assets.lock.json'] || '{}')) });
  assert.deepEqual(r.errors, [], what);
  const wrong = Object.keys(r.files).filter((f) => text(files[f] ?? '') !== text(r.files[f]) && f !== 'licences.json');
  assert.deepEqual(wrong, [], `${what}: files that differ from a build of the remaining posts`);
  const stale = Object.keys(files).filter((f) => /^(tags|archive|authors|page)\//.test(f) && !(f in r.files));
  assert.deepEqual(stale, [], `${what}: generated files a build would not write`);
}

test('delete: a post goes, with its page, its place in every list and its redirects; the rest is what a build of the others gives', async () => {
  const base = await readDirFiles(path.join(EX, 'blog'));
  const files = { ...base, 'posts/old.md': `---\nslug: old\ntitle: Old\ndate: 2026-02-02\ntags: [video]\naliases: [2019/old-post]\nstatus: published\n---\n\nOld words.\n` };
  const built = buildSite({ blog: text(files['blog.json']), posts: sources(files), lock: JSON.parse(text(files['assets.lock.json'])) });
  for (const [p, t] of Object.entries(built.files)) files[p] = t;
  const { server, gh } = await connect({ 'example/blog': files, 'example/images': { 'README.md': 'i' } });
  assert.ok('old/index.html' in server.files('example/blog') && '2019/old-post/index.html' in server.files('example/blog'));

  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'old', kind: 'post', remove: true });
  assert.equal(plan.removed, true);
  const deleted = plan.changes.filter((c) => c.action === 'delete').map((c) => c.path);
  for (const p of ['posts/old.md', 'old/index.html', '2019/old-post/index.html']) assert.ok(deleted.includes(p), `${p} is deleted`);
  assert.equal(plan.changes.filter((c) => c.path === 'posts/old.md').length, 1, 'the source is listed once, as a deletion');
  const receipt = await executePlan(gh, plan);
  assert.equal(receipt.commits.length, 1, 'one commit');

  const after = server.files('example/blog');
  for (const p of ['posts/old.md', 'old/index.html', '2019/old-post/index.html']) assert.ok(!(p in after), `${p} is gone`);
  assert.ok(!text(after['index/posts.json']).includes('"old"'), 'not in the index');
  assert.ok(!text(after['feed.xml']).includes('Old words') && !text(after['sitemap.xml']).includes('/old/'), 'not in the feed or the sitemap');
  assertBuilt(after, 'after deleting');
  assert.match(text(after['static-hls-in-git/index.html']), /<html/, 'the other posts are untouched');

  // deleting it again, or something that was never there, is a refusal, not an empty commit
  await assert.rejects(planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'old', kind: 'post', remove: true }), code('missing-source'));
  await assert.rejects(planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'never-was', kind: 'post', remove: true }), code('missing-source'));
});

test('delete: a draft has no generated page, and deleting it removes only the source', async () => {
  const files = await readDirFiles(path.join(EX, 'blog'));
  const { server, gh } = await connect({ 'example/blog': files, 'example/images': { 'README.md': 'i' } });
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'unfinished-thoughts', kind: 'post', remove: true });
  assert.deepEqual(plan.changes.map((c) => `${c.action} ${c.path}`), ['delete posts/unfinished-thoughts.md']);
  await executePlan(gh, plan);
  assert.ok(!('posts/unfinished-thoughts.md' in server.files('example/blog')));
  assertBuilt(server.files('example/blog'), 'after deleting a draft');
});

test('delete: a standalone page goes the same way', async () => {
  const files = await readDirFiles(path.join(EX, 'blog'));
  files['pages/about.md'] = '---\nslug: about\ntitle: About\nstatus: published\nmenu: 1\n---\n\nAbout us.\n';
  const { server, gh } = await connect({ 'example/blog': files, 'example/images': { 'README.md': 'i' } });
  const add = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', kind: 'page', text: files['pages/about.md'] });
  await executePlan(gh, add);
  assert.ok('about/index.html' in server.files('example/blog'));
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', kind: 'page', remove: true });
  await executePlan(gh, plan);
  const after = server.files('example/blog');
  assert.ok(!('pages/about.md' in after) && !('about/index.html' in after));
  assertBuilt(after, 'after deleting a page');
});

test('delete: a hand-kept order loses the slug too, so the build does not refuse the missing file', async () => {
  const files = await readDirFiles(path.join(EX, 'blog'));
  const blog = JSON.parse(text(files['blog.json']));
  blog.order = { by: 'manual', list: 'order.json' };
  files['blog.json'] = JSON.stringify(blog, null, 2) + '\n';
  files['order.json'] = JSON.stringify({ order: ['markdown-is-the-format', 'static-hls-in-git', 'unfinished-thoughts'] }, null, 2) + '\n';
  const built = buildSite({ blog: files['blog.json'], posts: sources(files), lock: JSON.parse(text(files['assets.lock.json'])), orderList: files['order.json'] });
  assert.deepEqual(built.errors, []);
  for (const [p, t] of Object.entries(built.files)) files[p] = t;
  const { server, gh } = await connect({ 'example/blog': files, 'example/images': { 'README.md': 'i' } });
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'static-hls-in-git', kind: 'post', remove: true });
  assert.ok(plan.changes.some((c) => c.path === 'order.json' && c.action === 'update'));
  await executePlan(gh, plan);
  const after = server.files('example/blog');
  assert.deepEqual(JSON.parse(text(after['order.json'])).order, ['markdown-is-the-format', 'unfinished-thoughts']);
  assert.ok(!('static-hls-in-git/index.html' in after));
  const again = buildSite({ blog: text(after['blog.json']), posts: sources(after), lock: JSON.parse(text(after['assets.lock.json'])), orderList: text(after['order.json']) });
  assert.deepEqual(again.errors, []);
});

test('delete: on a big blog it is made incrementally and still equals a build of the posts that remain', async () => {
  const blog = { title: 'Big', description: 'A big blog', author: 'Ann', domain: 'https://x.test/b', repo: 'example/big', pageSize: 7 };
  const files = { 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}' };
  for (let n = 0; n < 320; n++) {
    const day = String((n % 27) + 1).padStart(2, '0');
    const month = String((n % 12) + 1).padStart(2, '0');
    files[`posts/p${n}.md`] = `---\nslug: p${n}\ntitle: "Post ${n}"\ndate: 20${20 + (n % 6)}-${month}-${day}\ntags: [${['a', 'b', 'c'][n % 3]}]\nstatus: published\n---\n\nWords of post ${n}.\n`;
  }
  const built = buildSite({ blog: files['blog.json'], posts: sources(files), lock: {} });
  assert.deepEqual(built.errors, []);
  for (const [p, t] of Object.entries(built.files)) files[p] = t;
  const { server, gh } = await connect({ 'example/big': files });
  const plan = await planChange(gh, { repo: 'example/big', branch: 'main', slug: 'p100', kind: 'post', remove: true });
  assert.equal(plan.ctx.others, null, 'it was made incrementally, not by reading every post');
  assert.ok(plan.changes.length < 80, `${plan.changes.length} files change, not the whole blog`);
  await executePlan(gh, plan);
  const after = server.files('example/big');
  assert.ok(!('posts/p100.md' in after) && !('p100/index.html' in after));
  assertBuilt(after, 'big blog after deleting');
});
