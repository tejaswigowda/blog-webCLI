import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { describePlan, executePlan, loadBlog, loadIndex, loadPost, planInit } from '../app/site.js';
import { buildSite, validateBlog } from '../lib/blog.js';
import { DEFAULT_CONTENT_BASE, defaultDomain, defaultTitle, makeBlogJson } from '../lib/init.js';
import { fakeGitHub } from './fake-github.js';

const FIELDS = { title: 'My Notes', description: 'Things I learned', author: 'Ada' };

async function world(files = { 'README.md': 'hello' }) {
  const server = fakeGitHub({ 'me/notes': files, 'me/me.github.io': { 'README.md': 'x' } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, net, anon: new GitHub(net), authed: new GitHub(net, { token: 'github_pat_test' }) };
}

test('defaults: Pages address and title come from the repository reference', () => {
  assert.equal(defaultDomain('me/notes'), 'https://me.github.io/notes');
  assert.equal(defaultDomain('me/notes/blog'), 'https://me.github.io/notes/blog');
  assert.equal(defaultDomain('Me/me.github.io'), 'https://Me.github.io');
  assert.equal(defaultTitle('me/my-notes'), 'My Notes');
  assert.equal(defaultTitle('me/site/field_notes'), 'Field Notes');
});

test('makeBlogJson: minimal by default; sections only for what was asked for; always valid', () => {
  const bare = makeBlogJson('me/notes', FIELDS);
  assert.deepEqual(Object.keys(bare), ['title', 'description', 'author', 'domain', 'repo', 'theme', 'content', 'search']);
  assert.equal(bare.content.base, DEFAULT_CONTENT_BASE, 'a new blog says where its live copy is read from');
  assert.equal(bare.search, true, 'and has search, the one feature that ships a script by default');
  assert.doesNotThrow(() => validateBlog(bare));
  const full = makeBlogJson('me/site/blog', { ...FIELDS, images: 'me/site/images', video: 'me/site' });
  assert.deepEqual(full.assets.repos, { images: 'me/site/images' });
  assert.deepEqual(full.video.repos, { videos: 'me/site' });
  assert.equal(full.repo, 'me/site/blog');
  assert.doesNotThrow(() => validateBlog(full));
});

test('create: blog.json and the generated empty site in one commit; the app then opens it', async () => {
  const { server, net, authed, anon } = await world();
  const plan = await planInit(authed, { repo: 'me/notes', branch: 'main', fields: FIELDS });
  assert.equal(net.ledger.uploaded.bytes, 0, 'planning uploads nothing');
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), ['.nojekyll', '404.html', 'blog.json', 'feed.xml', 'feed/index.html', 'index.html', 'index/posts.json', 'licences.json', 'search.json', 'search/index.html', 'sitemap.xml', 'webcli-live.js', 'webcli-search.js']);
  assert.ok(plan.changes.every((c) => c.action === 'add'));
  assert.match(describePlan(plan)[0], /^13 files, [\d.]+ (B|KB), to github\.com\/me\/notes \(main\)$/);

  const receipt = await executePlan(authed, plan);
  assert.equal(receipt.commits.length, 1);
  assert.equal(server.state['me/notes'].commits[receipt.commits[0].sha].msg, 'Create blog: My Notes');

  const files = server.files('me/notes');
  assert.equal(files['README.md'], 'hello', 'existing files are left alone');
  const blog = JSON.parse(files['blog.json']);
  assert.equal(blog.title, 'My Notes');
  assert.equal(blog.domain, 'https://me.github.io/notes');
  // what CI would regenerate is exactly what was committed (gate B8 holds from the first commit)
  const regen = buildSite({ blog: files['blog.json'], posts: [] });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(files[p], c, p);
  assert.equal(JSON.parse(files['index/posts.json']).posts.length, 0);

  const ctx = await loadBlog(anon, 'me/notes');
  assert.equal(ctx.blog.title, 'My Notes');
  assert.deepEqual(await loadIndex(anon, 'me/notes'), []);
});

test('create: in a folder, nothing is written outside it', async () => {
  const { server, authed } = await world({ 'README.md': 'hello', 'images/a.png': 'PNG' });
  const plan = await planInit(authed, { repo: 'me/notes/blog', branch: 'main', fields: { ...FIELDS, images: 'me/notes/images' } });
  assert.ok(plan.changes.every((c) => c.path.startsWith('blog/')));
  assert.match(describePlan(plan)[0], /\(main\) in blog\/$/);
  await executePlan(authed, plan);
  const files = server.files('me/notes');
  assert.deepEqual(Object.keys(files).filter((p) => !p.startsWith('blog/')).sort(), ['README.md', 'images/a.png']);
  const blog = JSON.parse(files['blog/blog.json']);
  assert.equal(blog.domain, 'https://me.github.io/notes/blog');
  assert.deepEqual(blog.assets.repos, { images: 'me/notes/images' });
});

test('create: posts already in the repository are indexed, not lost', async () => {
  const post = '---\nslug: old-one\ntitle: Old one\ndate: 2025-01-01\nstatus: published\n---\n\nAlready here.\n';
  const draft = post.replace(/old-one/g, 'wip').replace('published', 'draft');
  const { server, authed, anon } = await world({ 'README.md': 'x', 'posts/old-one.md': post, 'posts/wip.md': draft });
  const plan = await planInit(authed, { repo: 'me/notes', branch: 'main', fields: FIELDS });
  await executePlan(authed, plan);
  const files = server.files('me/notes');
  assert.deepEqual(JSON.parse(files['index/posts.json']).posts.map((p) => p.slug), ['old-one']);
  assert.ok(files['old-one/index.html'].includes('Already here.'));
  assert.ok(!('wip/index.html' in files));
  const ctx = await loadBlog(anon, 'me/notes');
  assert.ok((await loadPost(anon, 'me/notes', 'old-one', undefined, ctx)).html.includes('Already here.'));
});

test('create: refusals, all before any write', async () => {
  const { server, net, authed } = await world();
  const refuse = (fields, code) => assert.rejects(planInit(authed, { repo: 'me/notes', branch: 'main', fields }), (e) => e.code === code, JSON.stringify(fields));
  await refuse({ ...FIELDS, title: '' }, 'bad-blog-json');
  await refuse({ ...FIELDS, author: ' ' }, 'bad-blog-json');
  // (the address is not typed: GitHub's own, see test/address.test.js)
  await refuse({ ...FIELDS, images: 'not a repo' }, 'bad-blog-json');
  await refuse({ ...FIELDS, images: 'me/notes' }, 'bad-blog-json'); // the blog's own place
  await assert.rejects(planInit(authed, { repo: 'me/notes/blog', branch: 'main', fields: { ...FIELDS, video: 'me/notes/blog' } }), (e) => e.code === 'bad-blog-json');
  assert.equal(net.ledger.uploaded.bytes, 0);
  assert.deepEqual(Object.keys(server.files('me/notes')), ['README.md']);

  // an existing blog.json is never replaced
  const first = await planInit(authed, { repo: 'me/notes', branch: 'main', fields: FIELDS });
  await executePlan(authed, first);
  await assert.rejects(planInit(authed, { repo: 'me/notes', branch: 'main', fields: { ...FIELDS, title: 'Other' } }), /already has blog\.json/);
  assert.equal(JSON.parse(server.files('me/notes')['blog.json']).title, 'My Notes');
});

test('create: an unresolved asset in an existing post is refused rather than published broken', async () => {
  const post = '---\nslug: pic\ntitle: Pic\ndate: 2025-01-01\nstatus: published\n---\n\n![](asset:images/x.png)\n';
  const { authed } = await world({ 'README.md': 'x', 'posts/pic.md': post });
  await assert.rejects(planInit(authed, { repo: 'me/notes', branch: 'main', fields: FIELDS }), (e) => e.code === 'unresolved-asset');
});
