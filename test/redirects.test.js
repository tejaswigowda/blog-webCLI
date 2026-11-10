// Old addresses that keep working: `aliases` in a post's frontmatter, a small redirect page at each, recorded in the index, shown
// identically by the /blog/ reader, swept when they are removed, and refused when they would write over anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildSite } from '../lib/blog.js';
import { MAX_ALIASES, normaliseAlias, parseAliases } from '../lib/aliases.js';
import { loadSite } from '../lib/live-render.js';
import { previewHtml } from '../lib/preview.js';
import { Refusal } from '../lib/errors.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, planChange } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';
import { EX, readDirFiles, stripData } from './helpers.js';

const run = promisify(execFile);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const enc = new TextEncoder();
const BLOG = { title: 'T', description: 'D', author: 'A', domain: 'https://example.test/blog', repo: 'me/blog' };
const post = (slug, o = {}) => ({ path: `${o.page ? 'pages' : 'posts'}/${slug}.md`, text: `---\nslug: ${slug}\ntitle: Title of ${slug}\n${o.page ? '' : 'date: 2026-01-01\n'}status: ${o.status || 'published'}\n${o.aliases ? `aliases: ${o.aliases}\n` : ''}---\n\nBody of ${slug}.\n` });
const code = (c) => (e) => e instanceof Refusal && e.code === c;
const build = (posts, blog = BLOG) => buildSite({ blog, posts, lock: {} });
const refused = (posts, c, blog) => {
  const r = build(posts, blog);
  assert.ok(r.errors.some((e) => e.code === c), `${c}: ${r.errors.map((e) => e.code)}`);
  assert.deepEqual(r.files, {}, 'nothing is written');
  return r.errors;
};

test('aliases: a path, normalised; anything that is not a plain path is refused with the reason', () => {
  assert.equal(normaliseAlias('/2020/05/Old-Post/'), '2020/05/Old-Post');
  assert.equal(normaliseAlias('blog/post.html'), 'blog/post.html');
  assert.equal(normaliseAlias('日本/ünï'), '日本/ünï');
  for (const bad of ['', '/', '  ', '?p=123', 'a?b=1', 'a#frag', 'https://old.test/a', 'a b', 'a//b', '../x', 'a/../b', './a', '.hidden', 'a/.git', 'a\\b', 'a/%41', 'a/<b>', 'x'.repeat(101), Array(9).fill('a').join('/'), 5, null, {}]) {
    assert.throws(() => normaliseAlias(bad), code('bad-alias'), JSON.stringify(bad));
  }
  assert.deepEqual(parseAliases({ aliases: ['/a/', 'b/c'] }), ['a', 'b/c']);
  assert.deepEqual(parseAliases({ aliases: 'one/two' }), ['one/two'], 'one address may be written without the brackets');
  assert.deepEqual(parseAliases({}), []);
  assert.throws(() => parseAliases({ aliases: ['a', '/a/'] }), code('bad-alias'));
  assert.throws(() => parseAliases({ aliases: Array.from({ length: MAX_ALIASES + 1 }, (_, i) => `a${i}`) }), code('bad-alias'));
});

test('aliases: a post, a page and a draft: redirects only for what is published', () => {
  const r = build([
    post('one', { aliases: '[2020/05/one, "old/one"]' }), post('about', { page: true, aliases: '[about-us.html]' }),
    post('later', { status: 'draft', aliases: '[2020/06/later]' }),
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.files).filter((f) => f.endsWith('/index.html') && !/^(one|about|tags|archive|feed)\//.test(f)).sort(), ['2020/05/one/index.html', 'about-us.html/index.html', 'old/one/index.html']);
  assert.deepEqual(JSON.parse(r.files['index/posts.json']).redirects, [{ from: '2020/05/one', slug: 'one' }, { from: 'about-us.html', slug: 'about' }, { from: 'old/one', slug: 'one' }]);
  assert.ok(!r.files['2020/06/later/index.html'], 'a draft is invisible, its old address too');
});

test('aliases: the page at an old address is a redirect and nothing else', () => {
  const r = build([post('one', { aliases: '[2020/05/one]' })]);
  const page = r.files['2020/05/one/index.html'];
  assert.equal(page, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="generator" content="blog-webcli">
<title>Title of one · moved</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="https://example.test/blog/one/">
<meta http-equiv="refresh" content="0; url=../../../one/">
<body>
`.replace('<body>\n', '</head>\n<body>\n<p>This page has moved to <a href="../../../one/">Title of one</a>.</p>\n</body>\n</html>\n'));
  assert.doesNotMatch(stripData(page), /<script|\son[a-z]+=|<style|<iframe/i);
  // a depth of one folder, and a title that is markup, are each right
  const odd = build([{ path: 'posts/odd.md', text: '---\nslug: odd\ntitle: "A <b>&\\"odd\\"</b> title"\ndate: 2026-01-01\nstatus: published\naliases: [flat]\n---\n\nx\n' }]);
  assert.match(odd.files['flat/index.html'], /url=\.\.\/odd\//);
  assert.match(odd.files['flat/index.html'], /<title>A &lt;b&gt;&amp;&quot;odd&quot;&lt;\/b&gt; title · moved<\/title>/);
  // not a page of the site: in no feed, sitemap, index, tag list or search
  const all = build([post('one', { aliases: '[2020/05/one]' }), post('two')], { ...BLOG, search: true });
  for (const f of ['feed.xml', 'sitemap.xml', 'search.json', 'index.html', 'archive/index.html']) assert.ok(!all.files[f].includes('2020/05/one'), f);
  assert.ok(all.files['index/posts.json'].includes('2020/05/one'), 'the index records them: the reader and the editor need it');
});

test('aliases: regenerating is byte-identical, in any order of the posts', () => {
  const posts = [post('b', { aliases: '[x/b]' }), post('a', { aliases: '[x/a, y/a]' }), post('c')];
  const first = build(posts);
  for (const order of [[2, 1, 0], [1, 0, 2], [0, 2, 1]]) assert.deepEqual(build(order.map((i) => posts[i])).files, first.files);
});

test('aliases: what would write over the site is refused, naming the file and the reason', () => {
  const colliding = [
    ['a generated folder', 'tags/x'], ['archive', 'archive'], ['a generated file', 'feed.xml'], ['a generated file in any case', 'Sitemap.XML'], ['the pages folder', 'pages/x'],
    ['another post', 'two'], ['below another post', 'two/old'], ['its own address', 'one'], ['the repository\'s images folder', 'images/pic'],
  ];
  for (const [what, alias] of colliding) {
    const errs = refused([post('one', { aliases: `["${alias}"]` }), post('two')], 'alias-collision', alias === 'images/pic' ? { ...BLOG, assets: { base: 'https://c.test/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/blog/images' } } } : BLOG);
    assert.match(errs.find((e) => e.code === 'alias-collision').where, /posts\/one\.md/, what);
  }
  const twice = refused([post('one', { aliases: '[old/x]' }), post('two', { aliases: '[old/x]' })], 'alias-collision');
  assert.match(twice[0].detail, /claimed by both posts\/one\.md and posts\/two\.md/);
  // a draft's slug is reserved too: publishing it later must not collide
  refused([post('one', { aliases: '[later/old]' }), post('later', { status: 'draft' })], 'alias-collision');
  // a draft's alias is not checked until it is published
  assert.deepEqual(build([post('one', { aliases: '[old/x]' }), post('two', { status: 'draft', aliases: '[old/x]' })]).errors, []);
});

test('aliases: a bad alias is a refusal for the file, drafts included, and says what to write', () => {
  for (const bad of ['"?p=12"', '["a b"]', '[https://old.test/x]']) {
    const r = build([post('one', { aliases: bad })]);
    assert.equal(r.errors[0].code, 'bad-alias', bad);
    assert.match(r.errors[0].where, /posts\/one\.md/);
  }
});

test('the /blog/ reader shows an old address as the build writes it, and says where it goes; an unknown one is the 404', async () => {
  const posts = [post('one', { aliases: '[2020/05/one]' }), post('two')];
  const r = build(posts, { ...BLOG, content: undefined });
  const files = new Map(Object.entries(r.files));
  files.set('blog.json', JSON.stringify(BLOG));
  files.set('assets.lock.json', '{}');
  for (const p of posts) files.set(p.path, p.text);
  const site = await loadSite(async (p) => (files.has(p) ? enc.encode(files.get(p)) : null), { anyBlog: true });
  const out = previewHtml(site, '2020/05/one/index.html');
  assert.equal(out.html, r.files['2020/05/one/index.html']);
  assert.deepEqual([out.status, out.redirect], [200, 'one']);
  assert.equal(previewHtml(site, '2020/05/nope/index.html').status, 404);
  assert.equal(previewHtml(site, 'index.html').redirect, undefined);
});

test('the CLI: build writes the redirects; removing an alias removes its page and the folders it leaves empty; check finds a stale one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redirects-'));
  try {
    await fs.cp(path.join(EX, 'blog'), dir, { recursive: true });
    const file = path.join(dir, 'posts', 'markdown-is-the-format.md');
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.replace(/\nstatus:/, '\naliases: [2012/04/markdown, legacy.html]\nstatus:'));
    const cli = (...a) => run('node', [path.join(root, 'cli', 'blog.js'), ...a, dir]).then((r) => r.stdout, (e) => { e.stdout += e.stderr; throw e; });
    await cli('build');
    assert.match(await fs.readFile(path.join(dir, '2012', '04', 'markdown', 'index.html'), 'utf8'), /url=\.\.\/\.\.\/\.\.\/markdown-is-the-format\//);
    assert.ok(await fs.stat(path.join(dir, 'legacy.html', 'index.html')));
    assert.match(await cli('check'), /^ok:/);
    // the alias goes: the build says so and leaves nothing behind, and an unrelated folder of the same shape is not touched
    await fs.mkdir(path.join(dir, 'mine', 'notes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mine', 'notes', 'index.html'), '<p>my own page</p>');
    await fs.writeFile(file, text);
    await assert.rejects(cli('check'), (e) => /stale\s+2012\/04\/markdown\/index\.html/.test(e.stdout) && /stale\s+legacy\.html\/index\.html/.test(e.stdout) && !/mine/.test(e.stdout));
    const out = await cli('build');
    assert.match(out, /removed stale 2012\/04\/markdown\/index\.html/);
    await assert.rejects(fs.stat(path.join(dir, '2012')), /ENOENT/, 'the empty folders go too');
    await assert.rejects(fs.stat(path.join(dir, 'legacy.html')), /ENOENT/);
    assert.ok(await fs.stat(path.join(dir, 'mine', 'notes', 'index.html')), 'a page that is not the generator\'s is never swept');
    assert.match(await cli('check'), /^ok:/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the editor: publishing a post with an alias commits its redirect; dropping the alias deletes it', async () => {
  const files = await readDirFiles(path.join(EX, 'blog'));
  const server = fakeGitHub({ 'example/blog': files, 'example/images': { 'README.md': 'i' } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const text = (aliases) => `---\nslug: fresh\ntitle: Fresh\ndate: 2026-11-07\nstatus: published\n${aliases}---\n\nWords.\n`;
  const first = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'fresh', text: text('aliases: [2019/03/fresh]\n') });
  assert.ok(first.changes.some((c) => c.path === '2019/03/fresh/index.html' && c.action === 'add'));
  await executePlan(gh, first);
  assert.match(server.files('example/blog')['2019/03/fresh/index.html'], /url=\.\.\/\.\.\/\.\.\/fresh\//);
  const again = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'fresh', text: text('aliases: [2019/03/fresh]\n') });
  assert.ok(!again.changes.some((c) => c.path === '2019/03/fresh/index.html'), 'unchanged: not sent again');
  const dropped = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'fresh', text: text('') });
  assert.ok(dropped.changes.some((c) => c.path === '2019/03/fresh/index.html' && c.action === 'delete'), 'the redirect goes with its alias');
  await executePlan(gh, dropped);
  assert.ok(!('2019/03/fresh/index.html' in server.files('example/blog')));
  // an alias that collides is refused before anything is sent
  await assert.rejects(planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'fresh', text: text('aliases: [static-hls-in-git]\n') }), code('alias-collision'));
});
