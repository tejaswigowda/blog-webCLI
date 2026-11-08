// Related posts (gates N9–N11): a total order, the same block from the generator, the live renderer and the reader, and an
// incremental publish that rewrites exactly the pages whose block changes, and says how many.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_SHARD_OVER, buildSite, parsePost } from '../lib/blog.js';
import { affectedBy, relatedCount, relatedFor, relatedHtml } from '../lib/related.js';
import { prepareIncremental } from '../lib/incremental.js';
import { loadSite, renderFromSite } from '../lib/live-render.js';
import { previewHtml } from '../lib/preview.js';
import { validateBlog } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';

const enc = new TextEncoder();
const TAGS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const make = (n, o = {}) => {
  const f = { slug: `p${n}`, title: `Post number ${n}`, date: `20${String(20 + (n % 6)).padStart(2, '0')}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`, tags: [TAGS[n % 5], TAGS[(n + 2) % 5]], status: 'published', ...o };
  return { path: `posts/${f.slug}.md`, text: `---\nslug: ${f.slug}\ntitle: ${JSON.stringify(f.title)}\ndate: ${f.date}\ntags: [${f.tags.join(', ')}]\nstatus: ${f.status}\n---\n\nWords of post ${n}.\n` };
};
const BLOG = (extra = {}) => ({ title: 'Big', description: 'A big blog', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', related: { count: 3 }, ...extra });
const full = (blog, posts) => {
  const r = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(r.errors, [], r.errors.map((e) => `${e.code}: ${e.detail}`).join('\n'));
  return r;
};
const block = (html) => /<aside class="related-posts">[\s\S]*?<\/aside>/.exec(html)?.[0] || '';
const slugsIn = (html) => [...block(html).matchAll(/href="\.\.\/([^/"]+)\/"/g)].map((m) => m[1]);

test('blog.json: related is {count: 1..10}, absent means off', () => {
  assert.equal(relatedCount({}), 0);
  assert.equal(relatedCount({ related: { count: 4 } }), 4);
  for (const bad of [3, { count: 0 }, { count: 11 }, { count: 1.5 }, { count: '3' }, { count: 2, more: 1 }, []]) {
    assert.throws(() => validateBlog({ title: 't', description: 'd', author: 'a', domain: 'https://x.test', related: bad }), (e) => e instanceof Refusal && e.code === 'bad-blog-json', JSON.stringify(bad));
  }
});

test('N9: the rank is shared tags, then place in the sequence, then slug: a total order', () => {
  const entries = [
    { slug: 'me', title: 'Me', tags: ['a', 'b', 'c'] },
    { slug: 'z-one', title: 'Z', tags: ['a'] },
    { slug: 'a-one', title: 'A', tags: ['a'] },
    { slug: 'two', title: 'Two', tags: ['a', 'b'] },
    { slug: 'three', title: 'Three', tags: ['a', 'b', 'c', 'd'] },
    { slug: 'none', title: 'None', tags: ['x'] },
    { slug: 'untagged', title: 'U', tags: [] },
  ];
  const sequence = ['untagged', 'z-one', 'me', 'a-one', 'none', 'two', 'three'];
  assert.deepEqual(relatedFor(entries, sequence, 'me', 10).map((r) => r.slug), ['three', 'two', 'z-one', 'a-one'], 'tags in common, then the sequence (z-one comes first in it), never itself or a post with no tag in common');
  assert.deepEqual(relatedFor(entries, [], 'me', 10).map((r) => r.slug), ['three', 'two', 'a-one', 'z-one'], 'with no sequence, slug ascending breaks the tie');
  assert.deepEqual(relatedFor(entries, sequence, 'me', 2).map((r) => r.slug), ['three', 'two'], 'at most count');
  assert.deepEqual(relatedFor(entries, sequence, 'untagged', 3), []);
  assert.deepEqual(relatedFor(entries, sequence, 'me', 0), []);
  assert.deepEqual(relatedFor([...entries].reverse(), sequence, 'me', 10), relatedFor(entries, sequence, 'me', 10), 'the input order does not matter');
  assert.equal(relatedHtml([]), '');
  assert.match(relatedHtml([{ slug: 's', title: '<b>&' }]), /href="\.\.\/s\/">&lt;b&gt;&amp;<\/a>/, 'escaped');
});

test('N9: regenerating in any input order is byte-identical; drafts and scheduled posts are never candidates; off means no block', () => {
  const posts = Array.from({ length: 40 }, (_, n) => make(n));
  const extra = [make(100, { status: 'draft', tags: ['alpha', 'gamma'] }), { path: 'posts/p101.md', text: '---\nslug: p101\ntitle: Sched\ndate: 2026-01-01\ntags: [alpha, gamma]\nstatus: scheduled\npublish_at: 2027-01-01T09:00\n---\n\nx\n' }];
  const a = full(BLOG(), [...posts, ...extra]);
  const b = full(BLOG(), [...posts, ...extra].reverse());
  assert.deepEqual(a.files, b.files);
  for (const p of posts) {
    const html = a.files[`${parsePost(p).slug}/index.html`];
    assert.ok(slugsIn(html).length <= 3);
    assert.ok(!/p100|p101|Sched/.test(block(html)), 'no draft or scheduled post in a block');
    assert.ok(!slugsIn(html).includes(parsePost(p).slug), 'never itself');
  }
  assert.ok(slugsIn(a.files['p0/index.html']).length === 3);
  const off = full(BLOG({ related: undefined }), posts);
  assert.ok(!Object.values(off.files).some((h) => h.includes('related-posts')), 'absent: nothing changes');
});

test('N10: the generator, the live renderer and the /blog/ reader produce the same related block from the index', async () => {
  const blog = BLOG({ content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}' } });
  const posts = Array.from({ length: 30 }, (_, n) => make(n));
  const built = full(blog, posts);
  const files = { ...built.files, 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}' };
  const site = await loadSite(async (p) => (p in files ? enc.encode(files[p]) : null));
  for (const p of posts.slice(0, 12)) {
    const slug = parsePost(p).slug;
    const live = renderFromSite(site, { slug, text: p.text });
    assert.equal(live.html, built.files[`${slug}/index.html`], `${slug}: live`);
    assert.ok(block(live.html).includes('related-posts'));
    const reader = previewHtml(site, `${slug}/index.html`, { text: p.text });
    assert.equal(reader.html, built.files[`${slug}/index.html`], `${slug}: reader`);
  }
});

test('N11: affectedBy is exactly the posts whose block differs, and an incremental publish rewrites exactly those', async () => {
  const blog = BLOG({ assets: undefined });
  const N = SEARCH_SHARD_OVER + 20;
  const posts = Array.from({ length: N }, (_, n) => make(n));
  const before = full(blog, posts);
  const getter = (files) => async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(blog)) : p === 'assets.lock.json' ? enc.encode('{}') : files[p] !== undefined ? enc.encode(files[p]) : null);
  const cases = {
    'a new post': make(N, { date: '2030-01-01', tags: ['alpha'] }),
    'a title': make(50, { title: 'Zebra title' }),
    'a tag removed': make(52, { tags: ['alpha'] }),
    'a draft again': make(55, { status: 'draft' }),
    'a tag the blog does not use': make(57, { tags: ['unique-tag'] }),
  };
  for (const [what, change] of Object.entries(cases)) {
    const afterPosts = posts.some((p) => p.path === change.path) ? posts.map((p) => (p.path === change.path ? change : p)) : [...posts, change];
    const after = full(blog, afterPosts);
    const site = await loadSite(getter(before.files), { anyBlog: true });
    const prep = prepareIncremental({ site, change, lock: {}, slugs: new Set(afterPosts.map((p) => parsePost(p).slug)), existing: new Set(Object.keys(before.files)), minPosts: 0 });
    assert.ok(!prep.reason, `${what}: ${prep.reason}`);
    const byPath = new Map(afterPosts.map((p) => [p.path, p.text]));
    const res = prep.run({ texts: new Map(prep.need.slugs.map((s) => [s, byPath.get(`posts/${s}.md`)])), files: new Map(prep.need.files.map((f) => [f, before.files[f]])) });
    const state = { ...before.files };
    for (const f of res.remove) delete state[f];
    Object.assign(state, res.files);
    const wrong = [...new Set([...Object.keys(state), ...Object.keys(after.files)])].filter((f) => state[f] !== after.files[f]);
    assert.deepEqual(wrong, [], `${what}: the incremental result is a full build's`);
    const slug = parsePost(change).slug;
    const changedBlocks = Object.keys(after.files).filter((f) => /^p\d+\/index\.html$/.test(f) && f !== `${slug}/index.html` && before.files[f] !== undefined && block(before.files[f]) !== block(after.files[f])).length;
    assert.equal(prep.related, changedBlocks, `${what}: the count the pre-flight states is the pages whose block changed`);
  }
});

test('the old and new entries give the same affected set as comparing every post', () => {
  const tags = (n) => [TAGS[n % 5], TAGS[(n + 2) % 5]];
  const mk = (n, o = {}) => ({ slug: `p${n}`, title: `T${n}`, tags: tags(n), ...o });
  const oldEntries = Array.from({ length: 60 }, (_, n) => mk(n));
  const oldSeq = oldEntries.map((e) => e.slug);
  const newEntries = oldEntries.map((e) => (e.slug === 'p7' ? mk(7, { tags: ['alpha'], title: 'Renamed' }) : e));
  const brute = oldEntries.filter((e) => e.slug !== 'p7').map((e) => e.slug).filter((s) => JSON.stringify(relatedFor(oldEntries, oldSeq, s, 3)) !== JSON.stringify(relatedFor(newEntries, oldSeq, s, 3))).sort();
  assert.deepEqual(affectedBy({ oldEntries, oldSequence: oldSeq, newEntries, newSequence: oldSeq, slug: 'p7', count: 3 }), brute);
  assert.deepEqual(affectedBy({ oldEntries, oldSequence: oldSeq, newEntries, newSequence: oldSeq, slug: 'p7', count: 0 }), []);
});
