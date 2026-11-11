// Permalinks (E5-E8): a post can live at its old dated path, and every generated reference to it follows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, validateBlog } from '../lib/blog.js';
import { addrOf, relativeLink } from '../lib/permalink.js';
import { checkMissing, addrFromPath } from '../lib/live.js';
import { Refusal } from '../lib/errors.js';

const BASE = { title: 'T', description: 'D', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', search: true, pagination: { size: 2 }, related: { count: 2 }, comments: { mode: 'mailto', to: 'me@example.com' } };
const post = (slug, date, extra = '') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: "Post ${slug}"\ndate: ${date}\ntags: [a]\nauthor: Ann\nstatus: published\n${extra}---\n\nWords of ${slug}.\n` });
const POSTS = [post('one', '2024-05-17'), post('two', '2024-06-02'), post('three', '2025-01-09'), post('four', '2025-01-10')];
const build = (permalink, posts = POSTS, more = {}) => buildSite({ blog: { ...BASE, ...(permalink ? { permalink } : {}), ...more }, posts, lock: {} });
const code = (c) => (e) => e instanceof Refusal && e.code === c;

test('E5: the pattern is {slug}/{year}/{month}/{day} only; {category} and unknown fields are refused with a reason', () => {
  for (const ok of ['/{slug}/', '/{year}/{month}/{slug}/', '/{year}/{month}/{day}/{slug}/', '/blog/{year}/{slug}/']) assert.ok(validateBlog({ ...BASE, permalink: ok }), ok);
  for (const no of ['/{category}/{slug}/', '/{author}/{slug}/', '{slug}/', '/{slug}', '/{year}/', '/{slug}/{year}/', '/{year}/{year}/{slug}/', '/A/{slug}/', '/../{slug}/']) {
    assert.throws(() => validateBlog({ ...BASE, permalink: no }), code('unsupported-permalink'), no);
  }
  assert.throws(() => validateBlog({ ...BASE, permalink: '/{category}/{slug}/' }), /category/);
  assert.equal(addrOf({ permalink: '/{year}/{month}/{day}/{slug}/' }, { slug: 's', date: '2024-05-07T10:30' }), '2024/05/07/s');
  assert.equal(relativeLink('2024/05/a', '2024/05/b'), '../b/');
  assert.equal(relativeLink('a', 'b'), '../b/');
  assert.equal(relativeLink('2024/05/a', '2025/01/c'), '../../../2025/01/c/');
});

test('the default is untouched: posts at /<slug>/, no path in the index', () => {
  const r = build(null);
  assert.deepEqual(r.errors, []);
  assert.ok(r.files['one/index.html'] && !('path' in JSON.parse(r.files['index/posts.json']).posts[0]));
});

test('E6: every generated reference to a post follows the pattern', () => {
  const r = build('/{year}/{month}/{slug}/');
  assert.deepEqual(r.errors, []);
  const f = r.files;
  assert.ok(f['2024/05/one/index.html'] && f['2025/01/three/index.html'] && !f['one/index.html']);
  const page = f['2024/05/one/index.html'];
  assert.match(page, /<link rel="canonical" href="https:\/\/x\.test\/b\/2024\/05\/one\/">/);
  assert.match(page, /og:url" content="https:\/\/x\.test\/b\/2024\/05\/one\/"/);
  assert.match(page, /href="\.\.\/\.\.\/\.\.\/feed\.xml"/);
  assert.match(page, /<script type="application\/ld\+json">[^<]*2024\/05\/one/);
  // neighbours, from the page's own depth
  const two = f['2024/06/two/index.html'];
  assert.match(two, /href="\.\.\/\.\.\/\.\.\/2024\/05\/one\/"/);
  assert.match(two, /href="\.\.\/\.\.\/\.\.\/2025\/01\/three\/"/);
  // the index, the listings, the archive and tags
  for (const file of ['index.html', 'archive/index.html', 'tags/a/index.html']) assert.match(f[file], /href="(?:\.\.\/)*(?:\.\/)?2025\/01\/four\/"/, file);
  // sitemap, feed, search, the index record
  assert.match(f['sitemap.xml'], /<loc>https:\/\/x\.test\/b\/2025\/01\/four\/<\/loc>/);
  assert.ok(!/<loc>https:\/\/x\.test\/b\/four\//.test(f['sitemap.xml']));
  assert.match(f['feed.xml'], /<link rel="alternate" type="text\/html" href="https:\/\/x\.test\/b\/2024\/05\/one\/"\/>/);
  assert.equal(JSON.parse(f['search.json']).posts.find((p) => p.slug === 'one').path, '2024/05/one');
  assert.equal(JSON.parse(f['index/posts.json']).posts.find((p) => p.slug === 'one').path, '2024/05/one');
  // related posts, from the page's depth
  assert.match(page, /class="related-posts"[\s\S]*href="\.\.\/\.\.\/\.\.\/2025\/01\/four\/"/);
});

test('E6: every relative link and file reference on every generated page resolves to a generated file', () => {
  const r = build('/{year}/{month}/{day}/{slug}/', POSTS, { stylesheet: 'linked' });
  assert.deepEqual(r.errors, []);
  const files = new Set(Object.keys(r.files));
  const exists = (p) => files.has(p) || files.has(`${p.replace(/\/$/, '')}/index.html`) || p === '' || p === '.';
  for (const [file, html] of Object.entries(r.files)) {
    if (!file.endsWith('.html')) continue;
    const dir = file.replace(/[^/]*$/, '');
    for (const m of html.matchAll(/(?:href|src)="((?:\.\.?\/)[^"#?]*)"/g)) {
      const parts = (dir + m[1]).split('/');
      const out = [];
      for (const s of parts) {
        if (s === '..') out.pop();
        else if (s !== '.') out.push(s);
      }
      assert.ok(exists(out.join('/')), `${file}: ${m[1]}`);
    }
  }
});

test('collisions: a dated address may not sit below a page, another post, or a reserved name', () => {
  const page = { path: 'pages/2024.md', text: '---\nslug: 2024\ntitle: "Y"\nstatus: published\n---\n\nx\n' };
  assert.ok(build('/{year}/{month}/{slug}/', [...POSTS, page]).errors.some((e) => e.code === 'slug-collision'));
  assert.ok(build('/archive/{slug}/').errors.some((e) => e.code === 'slug-collision'));
  const twin = [post('one', '2024-05-17'), { path: 'posts/uno.md', text: post('uno', '2024-05-17').text }];
  assert.deepEqual(build('/{year}/{month}/{slug}/', twin).errors, []);
});

test('E8: a migration on /{slug}/ writes no alias stubs, and the URLs are the slugs', () => {
  const r = build(null);
  const index = JSON.parse(r.files['index/posts.json']);
  assert.equal(index.redirects, undefined);
  assert.deepEqual(index.posts.map((p) => p.slug).sort(), ['four', 'one', 'three', 'two']);
});

test('aliases: an alias may not be a post\'s address or sit below one; one at the old flat address is fine', () => {
  const ok = build('/{year}/{month}/{slug}/', [post('one', '2024-05-17', 'aliases: [old/one]\n'), ...POSTS.slice(1)]);
  assert.deepEqual(ok.errors, []);
  assert.match(ok.files['old/one/index.html'], /url=\.\.\/\.\.\/2024\/05\/one\//);
  assert.match(ok.files['old/one/index.html'], /canonical" href="https:\/\/x\.test\/b\/2024\/05\/one\/"/);
  const clash = build('/{year}/{month}/{slug}/', [post('one', '2024-05-17', 'aliases: [2024/06/two]\n'), ...POSTS.slice(1)]);
  assert.ok(clash.errors.some((e) => e.code === 'alias-collision'));
  const own = build('/{year}/{month}/{slug}/', [post('one', '2024-05-17', 'aliases: [2024/05/one]\n'), ...POSTS.slice(1)]);
  assert.ok(own.errors.some((e) => e.code === 'alias-collision'));
});

test('E6: the 404 soft render finds a post by its dated address, not by the last segment alone', async () => {
  assert.equal(addrFromPath('/b/2024/05/one/', '/b'), '2024/05/one');
  assert.equal(addrFromPath('/b/one/', '/b'), 'one');
  assert.equal(addrFromPath('/b/a/b/c/d/e/', '/b'), null);
  const blog = { ...BASE, permalink: '/{year}/{month}/{slug}/' };
  const site = buildSite({ blog, posts: POSTS, lock: {} });
  const enc = new TextEncoder();
  const files = { ...site.files, 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}', 'posts/one.md': POSTS[0].text };
  const get = async (p) => (files[p] === undefined ? null : enc.encode(files[p]));
  const hit = await checkMissing({ pathname: '/b/2024/05/one/', root: '/b', get });
  assert.notEqual(hit.state, 'missing', hit.why);
  assert.equal((await checkMissing({ pathname: '/b/2024/06/one/', root: '/b', get })).state, 'missing');
});

test('E7: a date change that would move a published post is refused, offering the old address as an alias', async () => {
  const { fakeGitHub } = await import('./fake-github.js');
  const { createNet } = await import('../app/net.js');
  const { GitHub } = await import('../app/github.js');
  const { planChange } = await import('../app/site.js');
  const blog = { ...BASE, permalink: '/{year}/{month}/{slug}/', comments: undefined };
  const built = buildSite({ blog, posts: POSTS, lock: {} });
  assert.deepEqual(built.errors, []);
  const files = { 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}', ...Object.fromEntries(POSTS.map((p) => [p.path, p.text])), ...built.files };
  const server = fakeGitHub({ 'me/b': files });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const edit = (text) => planChange(gh, { repo: 'me/b', branch: 'main', slug: 'one', text });
  const original = POSTS[0].text;
  // the same date, other words: the page is rewritten at its dated address
  const plan = await edit(original.replace('Words of one.', 'Other words.'));
  assert.ok(plan.changes.some((c) => c.path === '2024/05/one/index.html'));
  assert.ok(!plan.changes.some((c) => c.path === 'one/index.html'));
  // a new date in the same month keeps the address under {year}/{month}; a new month moves it
  await edit(original.replace('2024-05-17', '2024-05-20'));
  await assert.rejects(edit(original.replace('2024-05-17', '2024-07-01')), (e) => e instanceof Refusal && e.code === 'permalink-move' && /aliases/.test(e.detail) && /2024\/05\/one/.test(e.detail));
  // the author says the move is intended: the old address is an alias, and the stub is written
  const moved = await edit(original.replace('2024-05-17', '2024-07-01').replace('status: published\n', 'status: published\naliases: [2024/05/one]\n'));
  assert.ok(moved.changes.some((c) => c.path === '2024/07/one/index.html'));
  const stub = moved.changes.filter((c) => c.path === '2024/05/one/index.html');
  assert.equal(stub.length, 1, 'the old address is written once, as the stub');
  assert.ok(!stub[0].delete && stub[0].content.includes('http-equiv="refresh"'));
});

test('E9: archive aliases: one stub per tag, author, year and month; a collision with a post or page is refused, naming both', () => {
  const posts = [post('one', '2024-05-17'), post('two', '2024-06-02', 'tags: [b]\n').text ? { path: 'posts/two.md', text: post('two', '2024-06-02').text.replace('tags: [a]', 'tags: [a, b]').replace('author: Ann', 'author: Bob') } : null].filter(Boolean);
  const cfg = { tags: ['tag', 'category'], authors: ['author'], dates: true };
  const r = build(null, posts, { archiveAliases: cfg });
  assert.deepEqual(r.errors, []);
  const stubs = Object.keys(r.files).filter((f) => /^(tag|category|author)\/|^2024\//.test(f));
  assert.deepEqual(stubs.sort(), ['2024/05/index.html', '2024/06/index.html', '2024/index.html', 'author/ann/index.html', 'author/bob/index.html', 'category/a/index.html', 'category/b/index.html', 'tag/a/index.html', 'tag/b/index.html']);
  assert.match(r.files['tag/b/index.html'], /url=\.\.\/\.\.\/tags\/b\//);
  assert.match(r.files['tag/b/index.html'], /canonical" href="https:\/\/x\.test\/b\/tags\/b\/"/);
  assert.match(r.files['tag/b/index.html'], /name="robots" content="noindex"/);
  assert.match(r.files['2024/05/index.html'], /url=\.\.\/\.\.\/archive\//);
  assert.ok(JSON.parse(r.files['index/posts.json']).redirects.some((x) => x.from === 'tag/b' && x.to === 'tags/b'));
  // a post or page at an old archive address: refused, with both named
  const onYear = build(null, [...posts, { path: 'pages/2024.md', text: '---\nslug: 2024\ntitle: "Y"\nstatus: published\n---\n\nx\n' }], { archiveAliases: cfg });
  assert.ok(onYear.errors.some((e) => e.code === 'alias-collision' && /2024\//.test(e.detail) && /pages\/2024\.md/.test(e.detail)));
  const onTag = build(null, [...posts, { path: 'posts/tag.md', text: post('tag', '2024-01-01').text }], { archiveAliases: { tags: ['tag'] } });
  assert.ok(onTag.errors.some((e) => e.code === 'alias-collision' && /below tag\// .test(e.detail) && /posts\/tag\.md/.test(e.detail)), 'below a post, like any alias');
  // under a dated permalink the month folder is where posts live, and a stub there is allowed
  const dated = build('/{year}/{month}/{slug}/', posts, { archiveAliases: { dates: true } });
  assert.deepEqual(dated.errors, []);
  assert.ok(dated.files['2024/05/index.html'] && dated.files['2024/05/one/index.html']);
  for (const no of [{ tags: ['feed'] }, { tags: 'tag' }, { dates: 'yes' }, { other: 1 }, { tags: ['A B'] }]) assert.throws(() => validateBlog({ ...BASE, archiveAliases: no }), (e) => e instanceof Refusal && e.code === 'bad-alias', JSON.stringify(no));
});

test('links between posts: "../<slug>/" means the post or page with that slug, wherever the permalink puts it', () => {
  const link = (slug, date, to) => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: "P ${slug}"\ndate: ${date}\nauthor: Ann\nstatus: published\n---\n\nSee [it](../${to}/#top) and [about](../about/).\n` });
  const about = { path: 'pages/about.md', text: '---\nslug: about\ntitle: "About"\nstatus: published\n---\n\nAbout [one](../one/).\n' };
  const r = build('/{year}/{month}/{slug}/', [link('one', '2024-05-17', 'two'), link('two', '2025-02-03', 'one'), about]);
  assert.deepEqual(r.errors, []);
  assert.match(r.files['2024/05/one/index.html'], /<a href="\.\.\/\.\.\/\.\.\/2025\/02\/two\/#top">it<\/a>/);
  assert.match(r.files['2024/05/one/index.html'], /<a href="\.\.\/\.\.\/\.\.\/about\/">about<\/a>/);
  assert.match(r.files['about/index.html'], /<a href="\.\.\/2024\/05\/one\/">one<\/a>/);
  // the default blog is untouched
  assert.match(build(null, [link('one', '2024-05-17', 'two'), link('two', '2025-02-03', 'one')]).files['one/index.html'], /<a href="\.\.\/two\/#top">it<\/a>/);
});
