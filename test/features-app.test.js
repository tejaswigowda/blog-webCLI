// The editor's side of the site features: settings round-trip, publishing and unpublishing a standalone page,
// and what is left behind when a feature is switched off (it is removed, never stranded). Plus the CLI doing the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, listPageFiles, loadBlog, loadPost, planChange, planSettings } from '../app/site.js';
import { buildSite, validateBlog } from '../lib/blog.js';
import { attrsToText, blogToForm, formToBlog, parseAttrs } from '../lib/settings.js';
import { fakeGitHub } from './fake-github.js';

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(root, 'examples', 'blog');
async function walk(dir, base = dir) {
  const out = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await walk(p, base));
    else out[path.relative(base, p)] = await fs.readFile(p);
  }
  return out;
}
async function world() {
  const server = fakeGitHub({ 'example/blog': await walk(EXAMPLE), 'example/images': { 'README.md': 'images' }, 'example/audio': { 'README.md': 'audio' }, 'example/renders': { 'hls-demo/render.json': '{}' } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, gh: new GitHub(net, { token: 'github_pat_test' }) };
}
const ABOUT = (extra = '', status = 'published') => `---\nslug: about\ntitle: About\nstatus: ${status}\n${extra}---\n\nWho writes this.\n`;
const sorted = (plan) => plan.changes.map((c) => `${c.delete ? '-' : '+'}${c.path}`).sort();

test('settings form: the new sections round-trip, write only what is set, and blank removes them', async () => {
  const base = JSON.parse(await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8'));
  const form = blogToForm(base);
  assert.equal(form.search, false);
  assert.equal(form.pageSize, '');
  assert.equal(form.seoSitemap, true);
  const on = formToBlog(base, {
    ...form,
    search: true,
    pageSize: '10',
    seoTwitter: '@ada',
    seoSitemap: false,
    commentsSrc: 'https://comments.test/c.js',
    commentsAttrs: 'data-repo=me/blog\ncrossorigin=anonymous',
    analyticsSrc: 'https://stats.test/a.js',
    analyticsAttrs: 'data-domain=example.test',
    subAction: 'https://news.test/s',
    subField: 'em',
    subHidden: 'list=a=b',
  });
  assert.deepEqual(on.pagination, { size: 10 });
  assert.equal(on.search, true);
  assert.deepEqual(on.seo, { twitter: '@ada', sitemap: false });
  assert.deepEqual(on.comments, { src: 'https://comments.test/c.js', attrs: { 'data-repo': 'me/blog', crossorigin: 'anonymous' } });
  assert.deepEqual(on.subscribe, { action: 'https://news.test/s', field: 'em', hidden: { list: 'a=b' } }, 'only the first = separates');
  assert.doesNotThrow(() => validateBlog(on));
  // back through the form: the same blog
  assert.deepEqual(formToBlog(on, blogToForm(on)), on);
  // blank removes
  const off = formToBlog(on, { ...blogToForm(on), search: false, pageSize: '', seoTwitter: '', seoSitemap: true, commentsSrc: '', analyticsSrc: '', subAction: '' });
  for (const k of ['search', 'pagination', 'seo', 'comments', 'analytics', 'subscribe']) assert.ok(!(k in off), k);
  assert.deepEqual(parseAttrs(' a = 1 \n\nb=c=d', 'x'), { a: '1', b: 'c=d' });
  assert.equal(attrsToText({ a: '1', b: '2' }), 'a=1\nb=2');
  assert.throws(() => parseAttrs('nonsense', 'Attributes'), (e) => e.code === 'bad-blog-json' && /Attributes line 1/.test(e.detail));
  assert.throws(() => validateBlog(formToBlog(base, { ...form, pageSize: '0' })), (e) => e.code === 'bad-blog-json');
  assert.throws(() => validateBlog(formToBlog(base, { ...form, pageSize: 'ten' })), (e) => e.code === 'bad-blog-json');
});

test('settings: turning search on writes its files, turning it off removes every one of them', async () => {
  const { server, gh } = await world();
  const ctx = await loadBlog(gh, 'example/blog');
  const form = blogToForm(ctx.blog);
  const on = await planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...form, search: true } });
  const added = sorted(on).filter((p) => p.startsWith('+'));
  for (const f of ['+search.json', '+search/index.html', '+webcli-search.js']) assert.ok(added.includes(f), f);
  await executePlan(gh, on);
  assert.ok('webcli-search.js' in server.files('example/blog'));
  const off = await planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...form, search: false } });
  const removed = sorted(off).filter((p) => p.startsWith('-'));
  assert.deepEqual(removed, ['-search.json', '-search/index.html', '-webcli-search.js']);
  await executePlan(gh, off);
  const left = server.files('example/blog');
  assert.ok(!('search.json' in left) && !('search/index.html' in left) && !('webcli-search.js' in left));
  // and what is left is exactly what a fresh build writes
  const regen = buildSite({ blog: left['blog.json'], lock: JSON.parse(left['assets.lock.json']), posts: Object.entries(left).filter(([p]) => p.startsWith('posts/')).map(([p, text]) => ({ path: p, text })) });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(left[p], c, p);
});

test('settings: pagination written and withdrawn; the pages of a list that got shorter are deleted', async () => {
  const { server, gh } = await world();
  const form = blogToForm((await loadBlog(gh, 'example/blog')).blog);
  const on = await planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...form, pageSize: '1' } });
  assert.ok(sorted(on).includes('+page/2/index.html'));
  await executePlan(gh, on);
  assert.ok('page/2/index.html' in server.files('example/blog'));
  const off = await planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...form, pageSize: '' } });
  assert.ok(sorted(off).includes('-page/2/index.html'));
  await executePlan(gh, off);
  assert.ok(!('page/2/index.html' in server.files('example/blog')));
});

test('a page: published to pages/<slug>.md and <slug>/, shares the post address space, and unpublishing removes its page', async () => {
  const { server, gh } = await world();
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', text: ABOUT('menu: 1\n'), kind: 'page', create: true });
  assert.equal(plan.path, 'pages/about.md');
  const paths = sorted(plan);
  for (const f of ['+pages/about.md', '+about/index.html', '+sitemap.xml']) assert.ok(paths.includes(f), f);
  assert.ok(plan.changes.some((c) => c.path === 'index.html'), 'a menu page changes every page\'s header');
  await executePlan(gh, plan);
  const after = server.files('example/blog');
  assert.match(after['about/index.html'], /<h1>About<\/h1>/);
  assert.match(after['static-hls-in-git/index.html'], /<a href="\.\.\/about\/">About<\/a>/);
  assert.ok(JSON.parse(after['index/posts.json']).pages.some((p) => p.slug === 'about'));
  assert.deepEqual(await listPageFiles(gh, 'example/blog'), ['about.md']);
  const loaded = await loadPost(gh, 'example/blog', 'about', undefined, await loadBlog(gh, 'example/blog'), { kind: 'page' });
  assert.equal(loaded.post.kind, 'page');
  // the CI check would regenerate exactly this
  const files = Object.entries(after);
  const regen = buildSite({ blog: after['blog.json'], lock: JSON.parse(after['assets.lock.json']), posts: files.filter(([p]) => /^(posts|comments|pages)\//.test(p)).map(([p, text]) => ({ path: p, text })) });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(after[p], c, p);

  // a post may not take the slug of a page, nor a page that of a post
  await assert.rejects(planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', text: `---\nslug: about\ntitle: A post\ndate: 2026-11-08\nstatus: published\n---\n\nHi.\n`, create: true }), (e) => e.code === 'slug-collision');
  await assert.rejects(planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'static-hls-in-git', text: ABOUT().replace('slug: about', 'slug: static-hls-in-git'), kind: 'page', create: true }), (e) => e.code === 'slug-collision');

  // back to a draft: the page is gone, the menu loses it
  const draft = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', text: ABOUT('menu: 1\n', 'draft'), kind: 'page' });
  assert.ok(sorted(draft).includes('-about/index.html'));
  await executePlan(gh, draft);
  const gone = server.files('example/blog');
  assert.ok(!('about/index.html' in gone) && !/\.\.\/about\//.test(gone['static-hls-in-git/index.html']));
  assert.ok(gone['pages/about.md'].includes('status: draft'), 'the source stays');
});

test('a correction to a page is a pull request that leaves the default branch alone', async () => {
  const { server, gh } = await world();
  await executePlan(gh, await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', text: ABOUT(), kind: 'page', create: true }));
  const before = server.state['example/blog'].branches.main;
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'about', text: ABOUT().replace('Who writes this.', 'Who writes this blog.'), kind: 'page', mode: 'pr' });
  assert.equal(plan.path, 'pages/about.md');
  const receipt = await executePlan(gh, plan, { pullBody: '' });
  assert.equal(server.state['example/blog'].branches.main, before);
  assert.match(receipt.commits[0].branch, /^correction\/about-/);
  assert.match(server.state['example/blog'].pulls[0].body || '', /pages\/about\.md/, 'the pull request names the file it changes');
  assert.ok(server.files('example/blog', receipt.commits[0].branch)['pages/about.md'].includes('Who writes this blog.'));
  assert.match(buildSite({ blog: JSON.stringify({ title: 'T', description: 'd', author: 'a', domain: 'https://x.test', repo: 'me/blog' }), posts: [{ path: 'pages/about.md', text: ABOUT() }], lock: {} }).files['about/index.html'], /#repo=me\/blog&amp;correctpage=about/, 'the page links to the correction path the app understands');
});

test('the CLI builds pages/, removes what a switched-off feature left, and check finds a stale file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'features-'));
  for (const [rel, bytes] of Object.entries(await walk(EXAMPLE))) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), bytes);
  }
  const cli = (...args) => run('node', [path.join(root, 'cli', 'blog.js'), ...args, dir]).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  await fs.mkdir(path.join(dir, 'pages'));
  await fs.writeFile(path.join(dir, 'pages', 'about.md'), ABOUT('menu: 1\n'));
  const blog = JSON.parse(await fs.readFile(path.join(dir, 'blog.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'blog.json'), JSON.stringify({ ...blog, search: true, pagination: { size: 1 } }, null, 2));
  assert.equal((await cli('build')).code, 0);
  for (const f of ['about/index.html', 'search/index.html', 'search.json', 'webcli-search.js', 'page/2/index.html', 'tags/video/index.html', 'sitemap.xml']) await fs.access(path.join(dir, f));
  assert.equal((await cli('check')).code, 0);

  await fs.writeFile(path.join(dir, 'blog.json'), JSON.stringify(blog, null, 2));
  const stale = await cli('check');
  assert.equal(stale.code, 1);
  for (const f of ['stale    search/index.html', 'stale    page/2/index.html', 'stale    search.json', 'stale    webcli-search.js']) assert.ok(stale.stderr.includes(f), f);
  assert.equal((await cli('build')).code, 0);
  for (const f of ['search', 'page', 'search.json', 'webcli-search.js']) await assert.rejects(fs.access(path.join(dir, f)), f);
  await fs.access(path.join(dir, 'about/index.html'));
  assert.equal((await cli('check')).code, 0);

  // removing a tag from the only post that had it removes that tag's page, and the folder with it
  const post = await fs.readFile(path.join(dir, 'posts', 'markdown-is-the-format.md'), 'utf8');
  assert.ok(await fs.access(path.join(dir, 'tags', 'writing', 'index.html')).then(() => true, () => false));
  await fs.writeFile(path.join(dir, 'posts', 'markdown-is-the-format.md'), post.replace(/^tags:.*\n/m, ''));
  assert.equal((await cli('build')).code, 0);
  await assert.rejects(fs.access(path.join(dir, 'tags', 'writing')));
  await fs.rm(dir, { recursive: true });
});
