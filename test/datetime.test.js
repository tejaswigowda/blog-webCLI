// A post's date may carry the time it was written (2026-11-07T14:30). The posts of one day are then in the order they were written
// (newest first on a date-ordered blog), where before they tied and fell back to the slug. The time is for ordering: pages show the
// day, the sitemap has the day, the feed has the moment. A date with no time is what it always was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, parsePost } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';
import { formatDate } from '../lib/datefmt.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, planChange } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';

const post = (slug, date, extra = '') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: Post ${slug}\ndate: ${date}\nstatus: published\n${extra}---\n\nWords of ${slug}.\n` });
const BLOG = { title: 'T', description: 'd', author: 'A', domain: 'https://example.test/b', repo: 'me/b' };
const build = (posts, blog = BLOG) => {
  const r = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(r.errors, []);
  return r;
};
const order = (r) => JSON.parse(r.files['index/posts.json']).sequence;

test('date with a time: accepted when real, refused when not', () => {
  for (const ok of ['2026-11-07', '2026-11-07T00:00', '2026-11-07T14:30', '2026-11-07T23:59', '2024-02-29T12:00']) assert.equal(parsePost(post('a', ok)).meta.date, ok, ok);
  for (const bad of ['2026-11-07T24:00', '2026-11-07T14:60', '2026-11-07T1:30', '2026-11-07T14:30:15', '2026-11-07 14:30', '2026-02-30T10:00', '2026-11-07T14:30Z', '2026-11-7T14:30']) {
    assert.throws(() => parsePost(post('a', bad)), (e) => e instanceof Refusal && e.code === 'bad-frontmatter' && /YYYY-MM-DDTHH:MM/.test(e.detail), bad);
  }
});

test('date with a time: posts of one day are newest first, a post with no time is the oldest of its day, and the order is deterministic', () => {
  const posts = [
    post('written-first', '2026-11-07T09:15'), post('written-third', '2026-11-07T17:45'), post('written-second', '2026-11-07T12:00'),
    post('only-a-day', '2026-11-07'), post('yesterday', '2026-11-06T23:59'), post('same-minute-b', '2026-11-08T08:00'), post('same-minute-a', '2026-11-08T08:00'),
  ];
  const r = build(posts);
  assert.deepEqual(order(r), ['same-minute-a', 'same-minute-b', 'written-third', 'written-second', 'written-first', 'only-a-day', 'yesterday']);
  assert.deepEqual(order(build([...posts].reverse())), order(r), 'whatever order the files come in');
  const titles = [...r.files['index.html'].matchAll(/<h2><a href="[^"]*">Post ([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(titles, order(r), 'the front page lists them in that order');
});

test('date with a time: pages show the day, the feed has the moment, the sitemap the day', () => {
  const r = build([post('timed', '2026-11-07T14:30'), post('plain', '2026-11-05')]);
  const page = r.files['timed/index.html'];
  assert.ok(page.includes('<time datetime="2026-11-07T14:30">November 7, 2026</time>'), 'the label is the day');
  assert.ok(!/14:30<\/time>/.test(page) && !page.includes('2:30'), 'no time of day is shown');
  assert.ok(r.files['index.html'].includes('November 7, 2026'));
  assert.match(r.files['feed.xml'], /<published>2026-11-07T14:30:00Z<\/published>/);
  assert.match(r.files['feed.xml'], /<published>2026-11-05T00:00:00Z<\/published>/);
  assert.match(r.files['feed.xml'], /<updated>2026-11-07T14:30:00Z<\/updated>/);
  assert.match(r.files['sitemap.xml'], /<loc>https:\/\/example\.test\/b\/timed\/<\/loc>\s*<lastmod>2026-11-07<\/lastmod>/);
  assert.ok(!/lastmod>2026-11-07T/.test(r.files['sitemap.xml']), 'a sitemap date is a day');
  assert.equal(formatDate('2026-11-07T14:30', 'MMM D, YYYY'), 'Nov 7, 2026');
  assert.equal(formatDate('2026-11-07T14:30', 'YYYY-MM-DD'), '2026-11-07');
});

test('date with a time: the archive groups by year, tag pages and search keep the same order, and a day-only blog is byte-for-byte what it was', () => {
  const posts = [post('a', '2025-12-31T23:00', 'tags: [x]\n'), post('b', '2026-01-01T00:30', 'tags: [x]\n'), post('c', '2026-01-01T08:00', 'tags: [x]\n')];
  const r = build(posts, { ...BLOG, search: true });
  assert.match(r.files['archive/index.html'], /<h2 id="y2026">2026<\/h2>[\s\S]*<h2 id="y2025">2025<\/h2>/);
  assert.deepEqual([...r.files['tags/x/index.html'].matchAll(/<h2><a href="[^"]*">Post ([^<]+)<\/a>/g)].map((m) => m[1]), ['c', 'b', 'a']);
  const dayOnly = [post('a', '2026-01-01'), post('b', '2026-01-02')];
  const plain = build(dayOnly);
  assert.match(plain.files['feed.xml'], /<published>2026-01-02T00:00:00Z<\/published>/);
  assert.match(plain.files['sitemap.xml'], /<lastmod>2026-01-02<\/lastmod>/);
});

test('date with a time: publishing a timed post to a big blog is the same as a full build', async () => {
  const blog = { ...BLOG, pageSize: 7 };
  const base = Array.from({ length: 320 }, (_, n) => post(`p${n}`, `2026-0${(n % 9) + 1}-${String((n % 27) + 1).padStart(2, '0')}`, `tags: [${['a', 'b'][n % 2]}]\n`));
  const built = build(base, blog);
  const files = { 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}', ...Object.fromEntries(base.map((p) => [p.path, p.text])), ...built.files };
  const server = fakeGitHub({ 'me/b': files });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const day = base[40].text.match(/date: (\S+)/)[1];
  for (const [slug, date] of [['new-late', `${day}T22:10`], ['new-early', `${day}T01:05`]]) {
    const text = post(slug, date, 'tags: [a]\n').text;
    const plan = await planChange(gh, { repo: 'me/b', branch: 'main', slug, text, create: true, kind: 'post' });
    assert.equal(plan.ctx.others, null, 'made incrementally');
    await executePlan(gh, plan);
  }
  const now = server.files('me/b');
  const want = build([...base, post('new-late', `${day}T22:10`, 'tags: [a]\n'), post('new-early', `${day}T01:05`, 'tags: [a]\n')], blog);
  const wrong = Object.keys(want.files).filter((f) => f !== 'licences.json' && now[f] !== want.files[f]);
  assert.deepEqual(wrong, [], 'every file is what a full build makes');
  const seq = order(want);
  assert.ok(seq.indexOf('new-late') < seq.indexOf('new-early'), 'the later of one day first');
});
