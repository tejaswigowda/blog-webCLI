// Publishing one post to a big blog builds only what changes, and what it builds is exactly what a full build would: for every kind of
// edit, on a blog with pagination, tags, authors, cards, search shards, a sitemap and old addresses, applying the incremental result to
// the files before gives the files a full build of the new posts gives. The cases it declines are declined, not approximated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_LIMIT, SEARCH_SHARD_OVER, buildSite, parsePost, shardOf } from '../lib/blog.js';
import { INCREMENTAL_MIN_POSTS, prepareIncremental } from '../lib/incremental.js';
import { loadSite } from '../lib/live-render.js';

const enc = new TextEncoder();
const TAGS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const AUTHORS = ['Ann', 'Bob'];
const LOCK = { 'images/a.png': 'a'.repeat(40), 'images/b.png': 'b'.repeat(40) };

function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// a post as a file; `o` overrides any field
const make = (n, o = {}) => {
  const f = { slug: `p${n}`, title: `Post number ${n}`, date: `20${String(20 + (n % 6)).padStart(2, '0')}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`, tags: [TAGS[n % 5], TAGS[(n + 2) % 5]], author: AUTHORS[n % 2], status: 'published', ...o };
  const head = [`slug: ${f.slug}`, `title: ${JSON.stringify(f.title)}`, `date: ${f.date}`, `tags: [${f.tags.join(', ')}]`, `author: ${f.author}`, `status: ${f.status}`];
  if (f.aliases) head.push(`aliases: [${f.aliases.join(', ')}]`);
  if (f.noindex) head.push('noindex: true');
  if (f.canonical) head.push(`canonical: ${f.canonical}`);
  if (f.cover) head.push(`cover: ${f.cover}`);
  const image = n % 3 === 0 ? `\n\n![pic](https://old.test/i${n}.png)` : n % 7 === 0 ? '\n\n![pic](asset:images/a.png)' : '';
  return { path: `posts/${f.slug}.md`, text: `---\n${head.join('\n')}\n---\n\nFirst words of post ${n}.${f.body ? ` ${f.body}` : ''}${image}\n\nSecond paragraph of post ${n}, with more words to search.\n` };
};
const corpus = (count) => Array.from({ length: count }, (_, n) => make(n));
const BLOG = (extra = {}) => ({ title: 'Big', description: 'A big blog', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', pageSize: 7, search: true, customize: { list: { layout: 'cards', dates: true, tags: true } }, assets: { base: 'https://cdn.test/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/images' } }, ...extra });

const full = (blog, posts) => {
  const r = buildSite({ blog, posts, lock: LOCK });
  assert.deepEqual(r.errors, [], r.errors.map((e) => `${e.code}: ${e.detail}`).join('\n'));
  return r;
};
const getter = (blog, files) => async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(blog)) : p === 'assets.lock.json' ? enc.encode(JSON.stringify(LOCK)) : files[p] !== undefined ? enc.encode(files[p]) : null);

// the change as the editor would make it, run incrementally on top of `before`, and compared with a full build of `afterPosts`
async function incremental({ blog, before, beforePosts, change, minPosts = 0 }) {
  const afterPosts = beforePosts.some((p) => p.path === change.path) ? beforePosts.map((p) => (p.path === change.path ? change : p)) : [...beforePosts, change];
  const site = await loadSite(getter(blog, before.files), { anyBlog: true });
  const slugs = new Set(afterPosts.map((p) => parsePost(p).slug));
  const prep = prepareIncremental({ site, change, lock: LOCK, slugs, existing: new Set(Object.keys(before.files)), minPosts });
  if (prep.reason) return { reason: prep.reason, afterPosts };
  const byPath = new Map(afterPosts.map((p) => [p.path, p.text]));
  const texts = new Map(prep.need.slugs.map((s) => [s, byPath.get(`posts/${s}.md`)]));
  const files = new Map(prep.need.files.map((f) => [f, before.files[f]]));
  const res = prep.run({ texts, files });
  const state = { ...before.files };
  for (const f of res.remove) delete state[f];
  Object.assign(state, res.files);
  return { state, res, need: prep.need, afterPosts };
}
const same = (state, want, what) => {
  const wrong = [...new Set([...Object.keys(state), ...Object.keys(want)])].filter((f) => state[f] !== want[f]);
  assert.deepEqual(wrong, [], `${what}: ${wrong.length} files differ from a full build`);
};

const N = SEARCH_SHARD_OVER + 20;

test('incremental: a post edited in the middle of a big blog: its page, its neighbours, the listings, the feed and one search shard; nothing else', async () => {
  const blog = BLOG();
  const posts = corpus(N);
  const before = full(blog, posts);
  const change = make(100, { title: 'A wholly new title for post 100', body: 'Added words.' });
  const r = await incremental({ blog, before, beforePosts: posts, change });
  assert.ok(!r.reason, r.reason);
  same(r.state, full(blog, r.afterPosts).files, 'edit');
  const wrote = Object.keys(r.res.files);
  assert.ok(wrote.includes('p100/index.html') && wrote.includes('index/posts.json') && wrote.includes('feed.xml') && wrote.includes('sitemap.xml'));
  assert.ok(wrote.includes(`search/data-${shardOf('p100')}.json`) && wrote.filter((f) => /^search\/data-/.test(f)).length === 1, 'one shard of the search index');
  const pages = wrote.filter((f) => /^p\d+\/index\.html$/.test(f));
  assert.ok(pages.length <= 3, `the post and at most its two neighbours: ${pages}`);
  assert.ok(r.need.slugs.length <= 3 + FEED_LIMIT, `reads the neighbours and the feed's posts, not ${N}: ${r.need.slugs.length}`);
});

test('incremental: every kind of edit gives exactly the files a full build gives', async () => {
  const blog = BLOG();
  const posts = corpus(N);
  const before = full(blog, posts);
  const cases = {
    'a new newest post': make(N, { date: '2030-01-01' }),
    'a new oldest post': make(N + 1, { date: '2001-01-01' }),
    'a new post in the middle': make(N + 2, { date: '2023-06-15', tags: ['alpha'] }),
    'a title': make(50, { title: 'Zebra title' }),
    'a date, which moves it': make(51, { date: '2031-05-05' }),
    'a tag added': make(52, { tags: ['alpha', 'beta', 'gamma', 'delta'] }),
    'every tag removed from it': make(53, { tags: [] }),
    'an author': make(54, { author: 'Bob' }),
    'a draft again': make(55, { status: 'draft' }),
    'aliases added': make(56, { aliases: ['2020/05/old-56', 'legacy-56.html'] }),
    'noindex': make(57, { noindex: true }),
    'a canonical elsewhere': make(58, { canonical: 'https://elsewhere.test/58/' }),
    'a cover': make(59, { cover: 'asset:images/b.png' }),
    'a post with its first picture linked': make(60, { body: '![x](https://old.test/first.png) text' }),
    'the newest post': make(0, { date: '2035-01-01' }),
    'a post in the feed': posts.find((p) => p.path === 'posts/p3.md') && make(3, { body: 'edited, and in the newest' }),
  };
  let incrementalRuns = 0;
  for (const [what, change] of Object.entries(cases)) {
    const r = await incremental({ blog, before, beforePosts: posts, change });
    if (r.reason) continue; // a decline is checked below
    incrementalRuns++;
    same(r.state, full(blog, r.afterPosts).files, what);
  }
  assert.ok(incrementalRuns >= 14, `${incrementalRuns} of ${Object.keys(cases).length} ran incrementally`);
});

test('incremental: a draft removed from, and a redirect or tag page that goes with its last user, are deleted as a full build would', async () => {
  const blog = BLOG();
  const posts = corpus(N);
  posts[10] = make(10, { tags: ['only-mine'], aliases: ['old/ten'] });
  const before = full(blog, posts);
  assert.ok(before.files['old/ten/index.html'] && before.files['tags/only-mine/index.html']);
  const r = await incremental({ blog, before, beforePosts: posts, change: make(10, { tags: ['alpha'] }) });
  assert.ok(!r.reason, r.reason);
  assert.ok(r.res.remove.includes('old/ten/index.html') && r.res.remove.includes('tags/only-mine/index.html'));
  same(r.state, full(blog, r.afterPosts).files, 'its tag and address went');
  const d = await incremental({ blog, before, beforePosts: posts, change: make(11, { status: 'draft' }) });
  assert.ok(d.res.remove.includes('p11/index.html'), 'the page of a post that became a draft');
  same(d.state, full(blog, d.afterPosts).files, 'a draft');
});

test('incremental: a long random run of edits, applied one on another, ends where a full build of the end state is', async () => {
  const blog = BLOG({ pageSize: 11 });
  let posts = corpus(N);
  let state = full(blog, posts).files;
  const r = rng(42);
  let ran = 0;
  for (let step = 0; step < 24; step++) {
    const n = Math.floor(r() * (N + 10));
    const o = {};
    const kind = Math.floor(r() * 8);
    if (kind === 0) o.title = `Retitled ${step} ${'abc'[step % 3]}`;
    if (kind === 1) o.date = `20${20 + Math.floor(r() * 12)}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`;
    if (kind === 2) o.tags = [TAGS[Math.floor(r() * 5)]];
    if (kind === 3) o.status = r() < 0.5 ? 'draft' : 'published';
    if (kind === 4) o.aliases = [`step/${step}/old-${n}`];
    if (kind === 5) o.noindex = r() < 0.5;
    if (kind === 6) o.body = `Edited at step ${step}.`;
    const change = make(n, o);
    const before = { files: state };
    const res = await incremental({ blog, before, beforePosts: posts, change });
    posts = res.afterPosts;
    if (res.reason) {
      state = full(blog, posts).files; // declined: the caller builds all of it
      continue;
    }
    ran++;
    state = res.state; // carried forward: never rebuilt
  }
  assert.ok(ran >= 15, `${ran} of 24 steps ran incrementally`);
  same(state, full(blog, posts).files, 'after 24 edits');
});

test('incremental: with search off and no pagination, and ordered by title, the same', async () => {
  for (const blog of [BLOG({ search: false, pageSize: undefined }), BLOG({ order: { by: 'title' }, search: false }), BLOG({ search: false, sitemap: false })]) {
    const posts = corpus(120);
    const before = full(blog, posts);
    for (const change of [make(30, { title: 'Moved by title' }), make(121, { title: 'Aaa first' }), make(31, { body: 'edit' })]) {
      const r = await incremental({ blog, before, beforePosts: posts, change });
      assert.ok(!r.reason, `${JSON.stringify(blog.order)} ${r.reason}`);
      same(r.state, full(blog, r.afterPosts).files, `${JSON.stringify(blog.order || 'date')} ${change.path}`);
    }
  }
});

test('incremental: what it cannot be sure of is declined, with the reason, and the full build is the answer', async () => {
  const blog = BLOG();
  const posts = corpus(N);
  const before = full(blog, posts);
  const declines = {
    'a small blog': { r: await incremental({ blog, before, beforePosts: posts, change: make(1), minPosts: INCREMENTAL_MIN_POSTS + 1000 }), re: /small blog/ },
    'a standalone page': { r: await incremental({ blog, before, beforePosts: posts, change: { path: 'pages/about.md', text: '---\nslug: about\ntitle: About\nstatus: published\n---\n\nWords.\n' } }), re: /standalone page/ },
    'a second author appearing': { r: await incremental({ blog: BLOG(), before: full(BLOG(), corpus(N).map((p) => ({ ...p, text: p.text.replace(/author: Bob/, 'author: Ann') }))), beforePosts: corpus(N).map((p) => ({ ...p, text: p.text.replace(/author: Bob/, 'author: Ann') })), change: make(5, { author: 'Bob' }) }), re: /header of every page/ },
    'the first tag': { r: await incremental({ blog: BLOG(), before: full(BLOG(), corpus(N).map((p) => ({ ...p, text: p.text.replace(/tags: \[.*\]/, 'tags: []') }))), beforePosts: corpus(N).map((p) => ({ ...p, text: p.text.replace(/tags: \[.*\]/, 'tags: []') })), change: make(5, { tags: ['new'] }) }), re: /header of every page/ },
    'a hand-kept order': { r: await incremental({ blog: BLOG({ order: { by: 'manual' } }), before, beforePosts: posts, change: make(1) }), re: /hand-kept or field order/ },
    'search not in shards': { r: await incremental({ blog: BLOG(), before: full(BLOG(), corpus(40)), beforePosts: corpus(40), change: make(1) }), re: /search index is not in shards/ },
  };
  for (const [what, { r, re }] of Object.entries(declines)) assert.match(r.reason || '', re, what);
  // an index another version of the generator wrote
  const stale = { ...before.files, 'index/posts.json': before.files['index/posts.json'].replace(/"generatorId": "[^"]+"/, '"generatorId": "blog-webcli@0.0.1"') };
  const r = await incremental({ blog, before: { files: stale }, beforePosts: posts, change: make(1) });
  assert.match(r.reason, /another version|not written by this version/);
  // what a full build refuses, it refuses: an alias on top of another page, a missing pin
  const site = await loadSite(getter(blog, before.files), { anyBlog: true });
  const slugs = new Set(posts.map((p) => parsePost(p).slug));
  assert.throws(() => prepareIncremental({ site, change: make(1, { aliases: ['p2'] }), lock: LOCK, slugs, existing: new Set(), minPosts: 0 }), (e) => e.code === 'alias-collision');
  const prep = prepareIncremental({ site, change: make(1, { cover: 'asset:images/missing.png' }), lock: LOCK, slugs, existing: new Set(), minPosts: 0 });
  assert.throws(() => prep.run({ texts: new Map(prep.need.slugs.map((s) => [s, posts.find((p) => p.path === `posts/${s}.md`).text])), files: new Map(prep.need.files.map((f) => [f, before.files[f]])) }), (e) => e.code === 'unresolved-asset');
});

test('a big blog: the feed holds the newest posts, the search index is in shards that together hold every post, and a small blog is as it was', () => {
  const blog = BLOG();
  const r = full(blog, corpus(N));
  assert.equal((r.files['feed.xml'].match(/<entry>/g) || []).length, FEED_LIMIT);
  const manifest = JSON.parse(r.files['search.json']);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.shards.length, 16);
  const all = manifest.shards.flatMap((f) => JSON.parse(r.files[f]).posts.map((p) => p.slug));
  assert.equal(new Set(all).size, N);
  for (const f of manifest.shards) for (const p of JSON.parse(r.files[f]).posts) assert.equal(`search/data-${shardOf(p.slug)}.json`, f);
  const small = full(blog, corpus(30));
  assert.equal(JSON.parse(small.files['search.json']).version, 1);
  assert.ok(!Object.keys(small.files).some((f) => /^search\/data-/.test(f)));
  assert.equal((small.files['feed.xml'].match(/<entry>/g) || []).length, 30);
});

// ---------- stable pagination ----------
const PAGED = (extra = {}) => BLOG({ pagination: { size: 10, stable: true }, pageSize: undefined, search: false, ...extra });
const listing = (files) => Object.fromEntries(Object.entries(files).filter(([f]) => /^(page|tags\/[^/]+\/page|authors\/[^/]+\/page)\/|^index\.html$/.test(f) || /\/page\/\d+\/index\.html$/.test(f)));
const walkChain = (files, start, dir = '') => {
  // follow "Older posts" from the front page, collecting the slugs of every card, in order
  const slugsOf = (html) => [...html.matchAll(/<h2><a href="(?:\.\.\/)*([^"/]+)\/">/g)].map((m) => m[1]);
  const seen = [];
  let path = start;
  let guard = 0;
  while (path && guard++ < 1000) {
    const html = files[path];
    assert.ok(html, `${path} exists`);
    seen.push(...slugsOf(html));
    const next = /<a rel="next" href="([^"]+)">/.exec(html);
    if (!next) break;
    const dirOf = path.replace(/index\.html$/, '');
    path = new URL(next[1], `http://x/${dirOf}`).pathname.slice(1) + 'index.html';
  }
  return seen;
};

test('stable pagination: pages are numbered from the oldest, a new post changes the front page and nothing else, and every post is on exactly one page', () => {
  const blog = PAGED();
  const posts = corpus(95);
  const a = full(blog, posts).files;
  const pagesA = Object.keys(a).filter((f) => /^page\/\d+\/index\.html$/.test(f)).sort();
  assert.equal(pagesA.length, 8, 'the front page holds 10 to 19, the other 8 hold 10 each');
  assert.match(a['index.html'], /Latest posts/);
  assert.match(a['page/1/index.html'], /Page 1<\/span>/);
  assert.ok(!/page\/\d+\/[^"]*"[^>]*>Page \d+ of/.test(a['page/3/index.html']) && !/ of \d+/.test(/<span class="page-of">[^<]*<\/span>/.exec(a['page/3/index.html'])[0]), 'an older page does not say how many there are');
  // every post once, newest first, by following "Older posts" from the front
  const order = walkChain(a, 'index.html');
  const want = JSON.parse(a['index/posts.json']).sequence;
  assert.deepEqual(order, want);
  // a new newest post: the front page, and nothing in the listing but the front page and the index
  const b = full(blog, [...posts, make(200, { date: '2031-01-01' })]).files;
  const changed = Object.keys(listing(b)).filter((f) => a[f] !== b[f]);
  assert.deepEqual(changed.filter((f) => /^page\//.test(f)), [], 'no older page changes');
  assert.ok(changed.includes('index.html'));
  assert.deepEqual(walkChain(b, 'index.html'), JSON.parse(b['index/posts.json']).sequence);
  // ten more: one older page appears, and the rest are as they were
  let more = posts;
  for (let i = 0; i < 10; i++) more = [...more, make(300 + i, { date: `2032-01-${String(1 + i).padStart(2, '0')}` })];
  const c = full(blog, more).files;
  const pagesC = Object.keys(c).filter((f) => /^page\/\d+\/index\.html$/.test(f)).sort();
  assert.equal(pagesC.length, 9);
  const alteredOlder = pagesA.filter((f) => a[f] !== c[f]);
  assert.ok(alteredOlder.length <= 1, `only the page next to the front can change when a page is added: ${alteredOlder}`);
  assert.deepEqual(walkChain(c, 'index.html'), JSON.parse(c['index/posts.json']).sequence);
  // a backdated post: only the pages from its place toward the front change
  const d = full(blog, [...posts, make(400, { date: '2022-06-06' })]).files;
  assert.ok(a['page/1/index.html'] === d['page/1/index.html'], 'the oldest page is untouched by a post newer than it');
});

test('stable pagination: tags and authors page the same way, and the legacy numbering is unchanged when it is not asked for', () => {
  const stable = full(PAGED(), corpus(120)).files;
  const tagPages = Object.keys(stable).filter((f) => /^tags\/alpha\/page\/\d+\/index\.html$/.test(f));
  assert.ok(tagPages.length >= 2);
  const authorPages = Object.keys(stable).filter((f) => /^authors\/ann\/page\/\d+\/index\.html$/.test(f));
  assert.ok(authorPages.length >= 2);
  for (const dir of ['tags/alpha', 'authors/ann']) {
    const slugs = walkChain(stable, `${dir}/index.html`);
    assert.equal(new Set(slugs).size, slugs.length, `${dir}: no post twice`);
    assert.ok(slugs.length >= 20, `${dir}: ${slugs.length}`);
  }
  const before = full(PAGED(), corpus(120)).files;
  const after = full(PAGED(), [...corpus(120), make(500, { date: '2040-01-01', tags: ['alpha'], author: 'Ann' })]).files;
  const moved = Object.keys(after).filter((f) => /\/page\/\d+\/index\.html$|^page\//.test(f) && before[f] !== after[f]);
  assert.deepEqual(moved, [], 'no older page of the index, a tag or an author changes');
  // the default is what it always was: page 1 is the newest ten, and a new post shifts them
  const legacy = full(BLOG({ pagination: { size: 10 }, pageSize: undefined, search: false }), corpus(95)).files;
  assert.match(legacy['page/2/index.html'], /Page 2 of 10/);
  assert.match(legacy['index.html'], /Page 1 of 10/);
  assert.throws(() => buildSite({ blog: { ...BLOG(), pagination: { size: 10, stable: 'yes' } }, posts: [], lock: LOCK }), (e) => /stable must be true or false/.test(e.detail || e.message));
});

test('stable pagination: an incremental publish equals a full build, and sends a handful of files instead of every page', async () => {
  const blog = PAGED({ search: true });
  const posts = corpus(N);
  const before = full(blog, posts);
  const r = await incremental({ blog, before, beforePosts: posts, change: make(N + 5, { date: '2031-01-01' }) });
  assert.ok(!r.reason, r.reason);
  same(r.state, full(blog, r.afterPosts).files, 'a new newest post');
  const sent = Object.keys(r.res.files).filter((f) => before.files[f] !== r.res.files[f]);
  const pageFiles = sent.filter((f) => /^page\//.test(f) || /\/page\/\d+\//.test(f));
  assert.ok(pageFiles.length <= 1, `at most the new older page, not every page: ${pageFiles}`);
  assert.ok(sent.length < 40, `${sent.length} files differ from what is committed: ${sent.slice(0, 12)}`);
  const middle = await incremental({ blog, before, beforePosts: posts, change: make(100, { title: 'Changed in the middle' }) });
  same(middle.state, full(blog, middle.afterPosts).files, 'an edit in the middle');
});

// ---------- a sharded index ----------
test('a big blog keeps its index in shards listed by a small index/posts.json, and every reader gets the same index back', async () => {
  const { readIndex } = await import('../lib/index-data.js');
  const { INDEX_SHARD_OVER } = await import('../lib/blog.js');
  const r = full(BLOG(), corpus(INDEX_SHARD_OVER + 20));
  const manifest = JSON.parse(r.files['index/posts.json']);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.shards.length, 16);
  assert.ok(!('posts' in manifest) && manifest.sequence.length === INDEX_SHARD_OVER + 20);
  assert.ok(r.files['index/posts.json'].length < 80000, 'the part that changes with every post is small');
  const read = async (p) => (p in r.files ? r.files[p] : null);
  const index = await readIndex(read);
  assert.deepEqual(index.posts.map((e) => e.slug), manifest.sequence, 'in the recorded order');
  assert.equal(index.generatorId, manifest.generatorId);
  assert.deepEqual(index.posts, r.index, 'what the build recorded, entry for entry');
  await assert.rejects(readIndex(async (p) => (p === manifest.shards[3] ? null : read(p))), /is listed by the index and is missing/);
  const site = await loadSite(async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(BLOG())) : p === 'assets.lock.json' ? enc.encode(JSON.stringify(LOCK)) : r.files[p] !== undefined ? enc.encode(r.files[p]) : null), { anyBlog: true });
  assert.equal(site.index.posts.length, INDEX_SHARD_OVER + 20, 'the live renderer and the reader read it too');
  // a small blog is as it was: one version-2 file
  const small = full(BLOG(), corpus(30));
  assert.equal(JSON.parse(small.files['index/posts.json']).version, 2);
  assert.ok(!Object.keys(small.files).some((f) => /^index\/posts-/.test(f)));
  // a publish changes the manifest and one shard
  const posts = corpus(INDEX_SHARD_OVER + 20);
  const change = make(100, { title: 'A different title' });
  const inc = await incremental({ blog: BLOG(), before: r, beforePosts: posts, change });
  const touched = Object.keys(inc.res.files).filter((f) => /^index\/posts/.test(f) && r.files[f] !== inc.res.files[f]);
  assert.deepEqual(touched, ['index/posts-' + shardOf('p100') + '.json'], 'an edit that keeps the order changes one shard');
  const added = await incremental({ blog: BLOG(), before: r, beforePosts: posts, change: make(INDEX_SHARD_OVER + 50, { date: '2031-01-01' }) });
  const two = Object.keys(added.res.files).filter((f) => /^index\/posts/.test(f) && r.files[f] !== added.res.files[f]);
  assert.equal(two.length, 2, `a new post changes the manifest (the order) and one shard: ${two}`);
});
