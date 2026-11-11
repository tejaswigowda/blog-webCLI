// "About this post": what is said of a post from the post, the index and the lock file, and the two summaries of what the app fetches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite } from '../lib/blog.js';
import { mdToDelta } from '../lib/markdown.js';
import { compareLive, postStats, summariseHistory } from '../lib/post-stats.js';

const BLOG = { title: 'My blog', description: 'D', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', related: { count: 2 }, assets: { base: 'https://cdn.test/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/b/images' } } };
const INDEX = {
  posts: [{ slug: 'newer', title: 'Newer', tags: ['a'] }, { slug: 'mine', title: 'Mine', tags: ['a'], comments: 2 }, { slug: 'older', title: 'Older', tags: ['a', 'b'] }, { slug: 'other', title: 'Other', tags: ['z'] }],
  pages: [{ slug: 'about', title: 'About' }],
  sequence: ['newer', 'mine', 'older', 'other'],
};
const MD = '# Big\n\n## Section\n\nSome words here. [in](../older/#x) [page](../about/) [gone](../nope/) [out](https://e.test)\n\n![has alt](asset:images/a.png) ![](asset:images/b.png) ![new](asset:images/c.png)\n\n```\ncode\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
const F = { title: 'A fairly ordinary title', slug: 'mine', date: '2026-11-05', status: 'published', tags: ['a'], description: '', seo_title: '', image: '', canonical: '', noindex: false, cover: 'auto' };
const LOCK = { 'images/a.png': 'a'.repeat(40), 'images/a.png#size': '640x480', 'images/b.png': 'b'.repeat(40) };
const stats = (o = {}) => postStats({ ops: mdToDelta(MD).ops, f: { ...F, ...(o.f || {}) }, blog: { ...BLOG, ...(o.blog || {}) }, index: INDEX, lock: LOCK, staged: new Set(['images/c.png']), ...(o.rest || {}) });

test('length, contents, outline', () => {
  const s = stats();
  assert.ok(s.words > 10 && s.minutes === 1);
  assert.deepEqual(s.counts, { images: 3, videos: 0, tables: 1, htmlBlocks: 0, codeBlocks: 1, links: { internal: 3, external: 1 } });
  assert.deepEqual(s.headings, [{ level: 1, text: 'Big' }, { level: 2, text: 'Section' }]);
  assert.equal(s.extraH1, 1);
  assert.equal(stats({ rest: { ops: mdToDelta('').ops } }).words, 0);
});

test('pictures: alt text, sizes known, one not yet uploaded is not an error but a missing pin is', () => {
  const s = stats();
  assert.equal(s.imagesWithoutAlt, 1);
  assert.deepEqual(s.pictures, { total: 3, sized: 1 });
  assert.deepEqual(s.unpinned, [], 'c.png is staged for upload');
  assert.deepEqual(stats({ rest: { staged: new Set() } }).unpinned, ['asset:images/c.png']);
});

test('links: a post or page that exists is fine, one that does not is named', () => {
  assert.deepEqual(stats().brokenLinks, ['../nope/']);
});

test('search and sharing: title and description lengths, share image, sitemap', () => {
  const s = stats();
  assert.equal(s.seo.title.state, 'ok');
  assert.equal(s.seo.description.auto, true);
  assert.equal(s.seo.shareImage, true, 'cover auto and the post has pictures');
  assert.equal(s.seo.inSitemap, true);
  assert.equal(stats({ f: { seo_title: 'x'.repeat(80) } }).seo.title.state, 'long');
  assert.equal(stats({ f: { description: 'short' } }).seo.description.state, 'short');
  assert.equal(stats({ f: { noindex: true } }).seo.inSitemap, false);
  assert.equal(stats({ f: { status: 'draft' } }).seo.inSitemap, false);
  assert.equal(stats({ f: { canonical: 'https://elsewhere.test/p/' } }).seo.inSitemap, false);
  assert.equal(stats({ f: { cover: '' }, rest: { ops: mdToDelta('Words only.').ops } }).seo.shareImage, false);
  assert.equal(stats({ f: { cover: '' }, rest: { ops: mdToDelta('Words only.').ops }, blog: { cover: 'asset:images/a.png' } }).seo.shareImage, true);
});

test('address follows the permalink; neighbours, related and comments come from the index', () => {
  assert.equal(stats().address.url, 'https://x.test/b/mine/');
  assert.equal(stats({ blog: { permalink: '/{year}/{month}/{slug}/' } }).address.url, 'https://x.test/b/2026/11/mine/');
  assert.deepEqual(stats().address.aliases, []);
  assert.equal(stats({ f: { aliases: ['old/mine'] } }).address.aliases[0], 'old/mine');
  const s = stats();
  assert.equal(s.neighbours.newer.slug, 'newer');
  assert.equal(s.neighbours.older.slug, 'older');
  assert.deepEqual(s.related.map((r) => r.slug), ['newer', 'older']);
  assert.equal(s.comments, 2);
  assert.deepEqual(stats({ f: { tags: ['z'] } }).related.map((r) => r.slug), ['other'], 'related follows the tags as typed, not as saved');
});

test('history summary: count, first and last, who', () => {
  const c = (login, date, message) => ({ author: { login }, commit: { author: { name: login, date }, message } });
  const h = summariseHistory([c('ann', '2026-11-09T10:00:00Z', 'Fix a typo\n\nlonger'), c('bob', '2026-11-05T10:00:00Z', 'Edit'), c('ann', '2026-11-01T10:00:00Z', 'Publish')]);
  assert.equal(h.count, 3);
  assert.equal(h.more, false);
  assert.deepEqual(h.authors, ['ann', 'bob']);
  assert.equal(h.first.date, '2026-11-01T10:00:00Z');
  assert.equal(h.last.message, 'Fix a typo');
  assert.equal(summariseHistory(new Array(100).fill(c('ann', '2026-11-01T10:00:00Z', 'x'))).more, true);
  assert.equal(summariseHistory([]).count, 0);
});

test('live page against the saved source: live, stale, missing, unknown', () => {
  const post = { path: 'posts/hello.md', text: '---\nslug: hello\ntitle: "P"\ndate: 2026-01-01\nauthor: Ann\nstatus: published\n---\n\nWords.\n' };
  const built = buildSite({ blog: { title: 'T', description: 'D', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b' }, posts: [post], lock: {} });
  const html = built.files['hello/index.html'];
  assert.equal(compareLive({ status: 200, html }, post.text).state, 'live');
  assert.ok(compareLive({ status: 200, html }, post.text).bytes > 1000);
  assert.equal(compareLive({ status: 200, html }, post.text.replace('Words.', 'Other.')).state, 'stale');
  assert.equal(compareLive({ status: 404, html: '' }, post.text).state, 'missing');
  assert.equal(compareLive({ status: 200, html: '<html></html>' }, post.text).state, 'unknown');
  assert.equal(compareLive({ status: 500, html: '' }, post.text).state, 'unknown');
});
