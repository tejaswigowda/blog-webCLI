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
