import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, validateBlog } from '../lib/blog.js';
import { DEFAULT_ORDER, collate, neighbours, parseOrderList, resolveOrder, sequenceOf, validateOrder } from '../lib/order.js';
import { postBody } from '../lib/contracts.js';
import { READER_SORTS, readerSort } from '../lib/sort.js';
import { loadIndexFull } from '../app/read.js';
import { CannotRebuild, loadSite, renderFromSite } from '../lib/live-render.js';
import { checkMissing } from '../lib/live.js';
import { parseMeta, splitFile } from '../lib/frontmatter.js';
import { corpus } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enc = new TextEncoder();
const BLOG = (extra = {}) => ({ title: 'Course', description: 'd', author: 'A', domain: 'https://example.github.io/course', ...extra });
const post = (slug, { date = '2026-01-01', status = 'published', title = slug.replace(/-/g, ' '), extra = '' } = {}) => ({
  path: `posts/${slug}.md`,
  text: `---\nslug: ${slug}\ntitle: ${title}\ndate: ${date}\nstatus: ${status}\n${extra}---\n\nBody of ${slug}.\n`,
});
const build = (blog, posts, orderList) => buildSite({ blog: JSON.stringify(blog), posts, lock: {}, orderList: orderList === undefined ? null : JSON.stringify({ order: orderList }) });
const must = (r) => {
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r;
};
const codes = (r) => r.errors.map((e) => e.code);
const slugsOf = (r) => JSON.parse(r.files['index/posts.json']).sequence;
const pagesOf = (r) => Object.entries(r.files).filter(([f]) => /^[a-z0-9-]+\/index\.html$/.test(f));
const shuffled = (list, seed) => {
  const a = [...list];
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------- O1: the default is date descending, and nothing changes without `order` ----------
test('O1: with no order the sequence is newest first, ties by slug, exactly as before', () => {
  const posts = [post('b', { date: '2026-03-01' }), post('a', { date: '2026-03-01' }), post('c', { date: '2026-05-01' }), post('d', { date: '2026-01-01' })];
  const r = must(build(BLOG(), posts));
  assert.deepEqual(slugsOf(r), ['c', 'a', 'b', 'd']);
  assert.deepEqual(JSON.parse(r.files['index/posts.json']).posts.map((e) => e.slug), ['c', 'a', 'b', 'd'], 'the posts are listed in the sequence');
  assert.deepEqual(JSON.parse(r.files['index/posts.json']).order, { by: 'date', dir: 'desc' }, 'the index records the order that produced it');
  assert.deepEqual(DEFAULT_ORDER, { by: 'date', dir: 'desc' });
  assert.deepEqual(resolveOrder(validateBlog(BLOG())), { by: 'date', dir: 'desc' });
  // saying so explicitly is the same blog
  assert.equal(must(build(BLOG({ order: { by: 'date', dir: 'desc' } }), posts)).files['index.html'], r.files['index.html']);
  assert.match(r.files['feed.xml'], /<entry>\s*<id>https:\/\/example\.github\.io\/course\/c\/<\/id>/, 'the feed starts with the newest');
});

test('O1: the example blog still builds to the same index order', async () => {
  const idx = JSON.parse(await fs.readFile(path.join(root, 'examples', 'blog', 'index', 'posts.json'), 'utf8'));
  assert.deepEqual(idx.sequence, idx.posts.map((e) => e.slug));
  const dates = idx.posts.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('order: every other mode, by date asc, by title, by a frontmatter field', () => {
  const posts = [post('x', { date: '2026-02-01', title: 'banana' }), post('y', { date: '2026-01-01', title: 'Apple' }), post('z', { date: '2026-03-01', title: 'cherry' })];
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'date', dir: 'asc' } }), posts))), ['y', 'x', 'z']);
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'title' } }), posts))), ['y', 'x', 'z'], 'titles A-Z, case ignored');
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'title', dir: 'desc' } }), posts))), ['z', 'x', 'y']);
  const ep = [post('x', { extra: 'episode: 2\n' }), post('y', { extra: 'episode: 10\n' }), post('z', { extra: 'episode: 1\n' })];
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'frontmatter:episode' } }), ep))), ['z', 'x', 'y'], 'numbers sort as numbers: 10 after 2');
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'frontmatter:episode', dir: 'desc' } }), ep))), ['y', 'x', 'z']);
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'frontmatter:level' } }), [post('pa', { extra: 'level: beta\n' }), post('qa', { extra: 'level: alpha\n' })]))), ['qa', 'pa'], 'all text: as text');
});

test('order: blog.json "order" is validated, and the tiebreak cannot be configured', () => {
  for (const [o, why] of [
    [{ by: 'popularity' }, /by/],
    [{ by: 'date', dir: 'sideways' }, /dir/],
    [{ by: 'manual', dir: 'asc' }, /no direction/],
    [{ by: 'manual', list: '../x.json' }, /list/],
    [{ by: 'manual', list: 'dir/order.json' }, /list/],
    [{ by: 'manual', unlisted: 'drop' }, /append-by-date/],
    [{ by: 'date', list: 'order.json' }, /manual/],
    [{ by: 'frontmatter:' }, /by/],
    [{ by: 'frontmatter:has space' }, /by/],
    [{ by: 'date', tiebreak: 'date' }, /tiebreak.*slug/],
    [{ by: 'date', extra: 1 }, /not a field/],
    ['date', /object/],
  ]) assert.throws(() => validateOrder(o), (e) => e.code === 'bad-blog-json' && why.test(e.detail), JSON.stringify(o));
  assert.throws(() => validateBlog(BLOG({ order: { by: 'nope' } })), (e) => e.code === 'bad-blog-json');
  for (const ok of [{ by: 'date' }, { by: 'title', dir: 'asc' }, { by: 'manual' }, { by: 'manual', list: 'lessons.json', unlisted: 'append-by-date' }, { by: 'frontmatter:episode', dir: 'desc' }]) assert.doesNotThrow(() => validateOrder(ok));
  assert.deepEqual(resolveOrder({ order: { by: 'manual' } }), { by: 'manual', list: 'order.json', unlisted: 'append-by-date' });
});

// ---------- O2: manual order lives in a list, never in the posts ----------
test('O2: a manual order is one list; no post carries a position, and reordering touches no post', () => {
  const posts = ['intro', 'shapes', 'vsepr', 'review'].map((s) => post(s));
  const a = must(build(BLOG({ order: { by: 'manual' } }), posts, ['intro', 'shapes', 'vsepr', 'review']));
  const b = must(build(BLOG({ order: { by: 'manual' } }), posts, ['intro', 'vsepr', 'shapes', 'review']));
  assert.deepEqual(slugsOf(a), ['intro', 'shapes', 'vsepr', 'review']);
  assert.deepEqual(slugsOf(b), ['intro', 'vsepr', 'shapes', 'review']);
  // inserting one slug in the middle of the list is a one-line change; the posts are the same bytes either way
  assert.ok(!Object.keys(a.files).some((f) => f.startsWith('posts/')) && !('order.json' in a.files), 'the generator writes neither posts nor the list: both are authored');
  for (const p of posts) assert.ok(!/^(position|order|index|weight|rank)\s*:/m.test(p.text), p.path);
  // and the real corpus carries no position either
  return corpus().then((all) => {
    for (const { name, text } of all) {
      const meta = parseMeta(splitFile(text, name).front, name);
      for (const k of ['position', 'order', 'weight', 'rank']) assert.ok(!(k in meta), `${name} has "${k}"`);
    }
  });
});

test('O2: a list parses to slugs; a bad one is refused with its reason', () => {
  assert.deepEqual(parseOrderList('{"order":["a","b-c"]}'), ['a', 'b-c']);
  assert.deepEqual(parseOrderList('{"order":[]}'), []);
  for (const bad of ['[]', '{"order":"a"}', '{"order":["A"]}', '{"order":[1]}', 'not json', '{"posts":[]}']) assert.throws(() => parseOrderList(bad), (e) => e.code === 'bad-order-list', bad);
  assert.throws(() => parseOrderList(null), (e) => e.code === 'bad-order-list' && /Create it/.test(e.detail));
  // a manual blog with no list file at all is refused, not quietly date-ordered
  assert.deepEqual(codes(build(BLOG({ order: { by: 'manual' } }), [post('a')], undefined)), ['bad-order-list']);
});

// ---------- O3: determinism ----------
test('O3: the slug breaks every tie, in every mode, and regenerating is byte-identical however the posts arrive', () => {
  const posts = [post('m', { date: '2026-02-02' }), post('b', { date: '2026-02-02' }), post('k', { date: '2026-02-02', extra: 'episode: 5\n' }), post('f', { date: '2026-02-02', extra: 'episode: 5\n' }), post('a', { date: '2026-01-01' }), post('z', { date: '2026-03-03' })];
  const withEpisode = posts.map((p) => (p.text.includes('episode') ? p : { ...p, text: p.text.replace('---\n\nBody', 'episode: 5\n---\n\nBody') }));
  const modes = [
    [BLOG(), posts, undefined],
    [BLOG({ order: { by: 'date', dir: 'asc' } }), posts, undefined],
    [BLOG({ order: { by: 'title' } }), posts.map((p) => ({ ...p, text: p.text.replace(/^title: .*$/m, 'title: Same') })), undefined],
    [BLOG({ order: { by: 'frontmatter:episode' } }), withEpisode, undefined],
    [BLOG({ order: { by: 'manual' } }), posts, ['k', 'f']],
  ];
  for (const [blog, input, list] of modes) {
    const first = must(build(blog, input, list));
    for (let seed = 1; seed <= 12; seed++) {
      const again = must(build(blog, shuffled(input, seed), list));
      assert.deepEqual(again.files, first.files, `${JSON.stringify(blog.order || 'default')} differs when the posts arrive in another order (seed ${seed})`);
    }
    assert.deepEqual(must(build(blog, input, list)).files, first.files, 'twice in a row');
  }
  // ties: ascending slug even when the direction is descending
  assert.deepEqual(slugsOf(must(build(BLOG(), posts))).slice(1, 5), ['b', 'f', 'k', 'm'], 'same date: b, f, k, m');
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'date', dir: 'asc' } }), posts))).slice(1, 5), ['b', 'f', 'k', 'm']);
  assert.deepEqual(slugsOf(must(build(BLOG({ order: { by: 'frontmatter:episode' } }), withEpisode))), ['a', 'b', 'f', 'k', 'm', 'z'], 'one episode for all: pure slug order');
});

test('O3: collation does not depend on locale: case, accents and ties come out the same everywhere', () => {
  assert.equal(collate('apple', 'Banana'), -1);
  assert.equal(collate('Éclair', 'eclair'), 1, 'accented sorts after plain (code units), not by a locale rule');
  assert.equal(collate('same', 'same'), 0);
  assert.notEqual(collate('Same', 'same'), 0, 'case only breaks a tie, deterministically');
  assert.deepEqual(['b', 'B', 'a', 'A'].sort(collate), ['A', 'a', 'B', 'b']);
});

// ---------- O4: prev / next ----------
test('O4: previous and next follow the order over the published posts; a draft in the list is skipped, never linked', () => {
  const posts = [post('one'), post('two', { status: 'draft' }), post('three'), post('four')];
  const r = must(build(BLOG({ order: { by: 'manual' } }), posts, ['one', 'two', 'three', 'four']));
  assert.deepEqual(slugsOf(r), ['one', 'three', 'four'], 'the sequence is the list filtered to what is published');
  const page = (s) => r.files[`${s}/index.html`];
  // the first has no prev, the last no next: absent, not dead or disabled
  assert.ok(!/rel="prev"/.test(page('one')) && !/disabled|aria-disabled/.test(page('one')));
  assert.match(page('one'), /<link rel="next" href="\.\.\/three\/">/);
  assert.match(page('one'), /<nav class="post-nav" aria-label="Post navigation"><a class="next" rel="next" href="\.\.\/three\/">three →<\/a><\/nav>/);
  assert.match(page('three'), /<link rel="prev" href="\.\.\/one\/">/);
  assert.match(page('three'), /<link rel="next" href="\.\.\/four\/">/);
  assert.match(page('three'), /<a class="prev" rel="prev" href="\.\.\/one\/">← one<\/a><a class="next" rel="next" href="\.\.\/four\/">four →<\/a>/);
  assert.ok(!/rel="next"/.test(page('four')));
  assert.match(page('four'), /<link rel="prev" href="\.\.\/three\/">/);
  // nothing links the draft, and it has no page
  assert.ok(!('two/index.html' in r.files));
  for (const [f, html] of Object.entries(r.files)) if (f.endsWith('.html')) assert.ok(!/href="[^"]*\/two\/"/.test(html), `${f} links the draft`);
  // a single post has nothing to navigate
  const solo = must(build(BLOG(), [post('only')]));
  assert.ok(!/post-nav|rel="prev"|rel="next"/.test(solo.files['only/index.html'].replace(/<style>[\s\S]*?<\/style>/, '')));
});

test('O4: the default order navigates too, and the links are the head hints as well as the visible controls', () => {
  const r = must(build(BLOG(), [post('old', { date: '2026-01-01' }), post('mid', { date: '2026-02-01' }), post('new', { date: '2026-03-01' })]));
  assert.deepEqual(slugsOf(r), ['new', 'mid', 'old']);
  assert.match(r.files['mid/index.html'], /<link rel="prev" href="\.\.\/new\/">/);
  assert.match(r.files['mid/index.html'], /<link rel="next" href="\.\.\/old\/">/);
});

test('O4: the classic markup contract gets WordPress\'s own post navigation', () => {
  const html = postBody('wordpress-classic', { blog: BLOG(), meta: { slug: 's', title: 'S', date: '2026-01-01', tags: [] }, bodyHtml: '<p>x</p>', home: '../', feed: '../feed.xml', nav: { prev: { title: 'Before', href: '../before/' }, next: null } }).html;
  assert.match(html, /<nav class="navigation post-navigation"[^>]*><h2 class="screen-reader-text">Post navigation<\/h2><div class="nav-links"><div class="nav-previous"><a href="\.\.\/before\/" rel="prev">/);
  assert.ok(!/nav-next/.test(html), 'no next: absent');
  assert.ok(!/post-navigation/.test(postBody('wordpress-classic', { blog: BLOG(), meta: { slug: 's', title: 'S', date: '2026-01-01', tags: [] }, bodyHtml: '', home: '', feed: '', nav: { prev: null, next: null } }).html));
});

test('neighbours: the ends are null, an unknown slug is null, and titles ride along', () => {
  const titles = new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]);
  const href = (s) => `../${s}/`;
  assert.deepEqual(neighbours(['a', 'b', 'c'], 'a', titles, href), { prev: null, next: { slug: 'b', title: 'B', href: '../b/' } });
  assert.deepEqual(neighbours(['a', 'b', 'c'], 'c', titles, href), { prev: { slug: 'b', title: 'B', href: '../b/' }, next: null });
  assert.equal(neighbours(['a'], 'zzz', titles, href), null);
});

// ---------- O5: the index carries the sequence; the client consumes it ----------
const fakeRepoReader = (files) => ({ readText: async (_r, p) => files[p] ?? null, listDir: async () => [] });

test('O5: the index records the resolved sequence and the order that produced it', () => {
  const r = must(build(BLOG({ order: { by: 'manual' } }), [post('a'), post('b', { status: 'draft' }), post('c')], ['c', 'b', 'a']));
  const idx = JSON.parse(r.files['index/posts.json']);
  assert.equal(idx.version, 2);
  assert.deepEqual(idx.sequence, ['c', 'a']);
  assert.deepEqual(idx.order, { by: 'manual', list: 'order.json', unlisted: 'append-by-date' });
  assert.deepEqual(idx.posts.map((e) => e.slug), idx.sequence);
});

test('O5: the app reads the recorded sequence and never sorts: an index whose sequence is not by date is shown as recorded', async () => {
  const index = { version: 2, order: { by: 'manual' }, sequence: ['old', 'new', 'mid'], posts: ['new', 'mid', 'old'].map((slug, i) => ({ slug, title: slug, date: `2026-0${3 - i}-01` })) };
  const got = await loadIndexFull(fakeRepoReader({ 'index/posts.json': JSON.stringify(index) }), 'me/blog');
  assert.deepEqual(got.posts.map((e) => e.slug), ['old', 'new', 'mid']);
  assert.deepEqual(got.sequence, ['old', 'new', 'mid']);
  // an older index with no sequence is taken in the order the file gives
  const v1 = { version: 1, posts: index.posts };
  assert.deepEqual((await loadIndexFull(fakeRepoReader({ 'index/posts.json': JSON.stringify(v1) }), 'me/blog')).posts.map((e) => e.slug), ['new', 'mid', 'old']);
  // nothing the client uses to read order contains a sort of its own
  for (const f of ['app/read.js', 'lib/live-render.js', 'lib/live.js', 'blog/reader.js']) {
    const src = (await fs.readFile(path.join(root, f), 'utf8')).replace(/\/\/.*$/gm, '');
    assert.ok(!/\.sort\s*\(|\.toSorted\s*\(|localeCompare/.test(src), `${f} sorts`);
  }
});

test('O5: a page rebuilt in the browser takes its neighbours from the recorded sequence, not from the dates', async () => {
  const blog = BLOG({ repo: 'example/course', order: { by: 'manual' }, content: { base: 'https://content.test/{owner}/{repo}/{ref}/{path}' } });
  const posts = [post('a', { date: '2026-01-01' }), post('b', { date: '2026-03-01' }), post('c', { date: '2026-02-01' })];
  const r = must(build(blog, posts, ['b', 'a', 'c']));
  assert.deepEqual(slugsOf(r), ['b', 'a', 'c']);
  const map = new Map(Object.entries(r.files));
  map.set('blog.json', JSON.stringify(blog));
  map.set('assets.lock.json', '{}');
  const get = async (p) => (map.has(p) ? enc.encode(map.get(p)) : null);
  const site = await loadSite(get);
  for (const p of posts) {
    const slug = p.path.replace(/^posts\/|\.md$/g, '');
    assert.equal(renderFromSite(site, { slug, text: p.text }).html, r.files[`${slug}/index.html`], `${slug}: rebuilt = built, neighbours included`);
  }
  assert.match(r.files['a/index.html'], /rel="prev" href="\.\.\/b\/"/, 'a follows b although it is older');
  // a post the live index does not know cannot be rebuilt identically: it is refused, not given guessed neighbours
  assert.throws(() => renderFromSite(site, { slug: 'zzz', text: post('zzz').text }), (e) => e instanceof CannotRebuild && /not-in-index/.test(e.message));
  // and the 404 path draws a new post with the neighbours the index gives it
  const after = must(build(blog, [...posts, post('d', { date: '2026-04-01' })], ['b', 'a', 'c', 'd']));
  const live = new Map(Object.entries(after.files));
  live.set('blog.json', JSON.stringify(blog));
  live.set('assets.lock.json', '{}');
  live.set('posts/d.md', post('d', { date: '2026-04-01' }).text);
  const out = await checkMissing({ pathname: '/course/d/', root: '/course', get: async (p) => (live.has(p) ? enc.encode(live.get(p)) : null) });
  assert.equal(out.state, 'rebuilt');
  assert.match(out.html, /<link rel="prev" href="\.\.\/c\/">/);
});

// ---------- O6: a reader sort is a view ----------
test('O6: a reader sort reorders the list and nothing else: not the sequence, not previous/next, not an address', () => {
  const posts = [post('a', { date: '2026-01-01', title: 'Zebra' }), post('b', { date: '2026-03-01', title: 'Apple' }), post('c', { date: '2026-02-01', title: 'Mango' })];
  const r = must(build(BLOG({ order: { by: 'manual' } }), posts, ['c', 'a', 'b']));
  const idx = JSON.parse(r.files['index/posts.json']);
  const before = JSON.stringify(idx.posts);
  const pageBefore = r.files['a/index.html'];
  assert.deepEqual(READER_SORTS.map(([k]) => k), ['order', 'newest', 'oldest', 'title']);
  assert.deepEqual(readerSort(idx.posts, 'order').map((e) => e.slug), ['c', 'a', 'b'], 'the blog\'s order is where a reader starts');
  assert.deepEqual(readerSort(idx.posts, 'newest').map((e) => e.slug), ['b', 'c', 'a']);
  assert.deepEqual(readerSort(idx.posts, 'oldest').map((e) => e.slug), ['a', 'c', 'b']);
  assert.deepEqual(readerSort(idx.posts, 'title').map((e) => e.slug), ['b', 'c', 'a']);
  assert.equal(JSON.stringify(idx.posts), before, 'the input is not touched');
  assert.equal(readerSort(idx.posts, 'bogus'), idx.posts, 'an unknown sort is no sort');
  // previous/next is a function of the sequence, which the sort never sees
  assert.equal(r.files['a/index.html'], pageBefore);
  assert.match(pageBefore, /rel="prev" href="\.\.\/c\/"/);
  assert.match(pageBefore, /rel="next" href="\.\.\/b\/"/);
  // the static index names the unsorted index as canonical, so a sorted address can never be a duplicate page
  assert.match(r.files['index.html'], /<link rel="canonical" href="https:\/\/example\.github\.io\/course\/">/);
  // same-date ties follow the slug in a reader sort too
  assert.deepEqual(readerSort([{ slug: 'y', date: '2026-01-01', title: 't' }, { slug: 'x', date: '2026-01-01', title: 't' }], 'newest').map((e) => e.slug), ['x', 'y']);
});

// ---------- O7: refusals ----------
test('O7: a slug in the list with no post, or twice, is refused; a draft in the list is fine', () => {
  const blog = BLOG({ order: { by: 'manual' } });
  const posts = [post('a'), post('b', { status: 'draft' })];
  assert.deepEqual(codes(build(blog, posts, ['a', 'ghost'])), ['unknown-slug-in-order']);
  assert.match(build(blog, posts, ['a', 'ghost']).errors[0].detail, /"ghost" is in order\.json but there is no posts\/ghost\.md/);
  assert.deepEqual(codes(build(blog, posts, ['a', 'a'])), ['duplicate-slug-in-order']);
  assert.deepEqual(codes(build(blog, posts, ['a', 'ghost', 'a'])).sort(), ['duplicate-slug-in-order', 'unknown-slug-in-order']);
  assert.deepEqual(must(build(blog, posts, ['b', 'a'])).errors, [], 'sequencing unpublished material is the normal case');
  assert.deepEqual(slugsOf(must(build(blog, posts, ['b', 'a']))), ['a']);
  const r = build(blog, posts, ['a', 'ghost']);
  assert.deepEqual(r.files, {}, 'a refused build writes nothing');
});

// ---------- O8: mixed types ----------
test('O8: a field that is some numbers and some text is refused, not coerced; a missing or list field is refused', () => {
  const by = BLOG({ order: { by: 'frontmatter:episode' } });
  const mixed = [post('a', { extra: 'episode: 2\n' }), post('b', { extra: 'episode: 10\n' }), post('c', { extra: 'episode: pilot\n' })];
  const r = build(by, mixed);
  assert.deepEqual(codes(r), ['mixed-order-field-types']);
  assert.match(r.errors[0].detail, /"episode" is a number in .*"a" \(2\).* and text in "c" \(pilot\)/);
  assert.deepEqual(r.files, {});
  // missing: one refusal per post, naming it
  const missing = build(by, [post('a', { extra: 'episode: 1\n' }), post('b'), post('c')]);
  assert.deepEqual(codes(missing), ['missing-order-field', 'missing-order-field']);
  assert.deepEqual(missing.errors.map((e) => e.where).sort(), ['posts/b.md', 'posts/c.md']);
  // a draft without the field does not matter: only published posts are ordered
  assert.deepEqual(must(build(by, [post('a', { extra: 'episode: 1\n' }), post('d', { status: 'draft' })])).errors, []);
  assert.deepEqual(codes(build(by, [post('a', { extra: 'episode: [1, 2]\n' })])), ['bad-order-field']);
  // numbers that look alike are numbers: negatives and decimals
  assert.deepEqual(slugsOf(must(build(by, [post('neg', { extra: 'episode: -1\n' }), post('half', { extra: 'episode: 0.5\n' }), post('three', { extra: 'episode: 3\n' })]))), ['neg', 'half', 'three']);
});

// ---------- O9: unlisted posts are appended and reported ----------
test('O9: a published post that is in no list is appended by date and reported, never dropped', () => {
  const blog = BLOG({ order: { by: 'manual' } });
  const posts = [post('lesson-1'), post('lesson-2'), post('extra-b', { date: '2026-06-01' }), post('extra-a', { date: '2026-05-01' }), post('later', { date: '2026-05-01' }), post('hidden', { status: 'draft' })];
  const r = must(build(blog, posts, ['lesson-1', 'lesson-2']));
  assert.deepEqual(slugsOf(r), ['lesson-1', 'lesson-2', 'extra-a', 'later', 'extra-b'], 'appended oldest first, ties by slug');
  assert.deepEqual(r.unlisted, ['extra-a', 'later', 'extra-b']);
  assert.equal(r.warnings.filter((w) => /^order:/.test(w)).length, 1);
  assert.match(r.warnings.find((w) => /^order:/.test(w)), /3 published post\(s\) are not in order\.json and were appended by date: extra-a, later, extra-b/);
  for (const s of ['extra-a', 'later', 'extra-b']) assert.ok(r.files[`${s}/index.html`], `${s} still has its page`);
  assert.ok(!r.unlisted.includes('hidden'), 'a draft that is in no list is not news');
  // nothing to report when everything is listed
  const clean = must(build(blog, posts.slice(0, 2), ['lesson-1', 'lesson-2']));
  assert.deepEqual(clean.unlisted, []);
  assert.ok(!clean.warnings.some((w) => /^order:/.test(w)));
});

// ---------- G / O10: the feed ----------
test('O10: the feed follows the sequence in document order, is dated by the newest post, and the README says what it cannot do', async () => {
  const blog = BLOG({ order: { by: 'manual' } });
  const r = must(build(blog, [post('first', { date: '2026-01-01' }), post('second', { date: '2026-09-09' }), post('third', { date: '2026-02-02' })], ['first', 'second', 'third']));
  const ids = [...r.files['feed.xml'].matchAll(/<entry>\s*<id>[^<]*\/([a-z0-9-]+)\/<\/id>/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['first', 'second', 'third'], 'document order is the sequence');
  assert.match(r.files['feed.xml'], /<updated>2026-09-09T00:00:00Z<\/updated>\n  <link rel="alternate"/, 'the feed is as new as its newest post, not its first');
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const from = readme.indexOf('#### `order`');
  const section = readme.slice(from, readme.indexOf('\n#### ', from + 10));
  assert.match(section, /feed/i);
  assert.match(section, /re-sort/i);
  assert.match(section, /pubDate|published date/i);
  assert.match(section, /`date` in sequence|set `date` in sequence|dates in sequence/i, 'and the one honest workaround');
});

test('the sequence function: manual with an empty list is all appended; frontmatter ties by slug', () => {
  const posts = [{ slug: 'b', path: 'posts/b.md', meta: { date: '2026-01-02', title: 'b' } }, { slug: 'a', path: 'posts/a.md', meta: { date: '2026-01-01', title: 'a' } }];
  const r = sequenceOf({ order: { by: 'manual', list: 'order.json' }, posts, files: new Set(['a', 'b']), list: [] });
  assert.deepEqual(r.slugs, ['a', 'b']);
  assert.deepEqual(r.appended, ['a', 'b']);
});
