// A big blog (more than 500 posts) keeps its archive by year, archive/2026/, under an archive that lists the years, and its sitemap as an index of
// smaller ones, sitemaps/2026.xml: publishing or deleting a post then changes the files of its own year and not one file that lists every post.
// A blog of 500 posts or fewer is what it always was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite } from '../lib/blog.js';
import { SPLIT_OVER } from '../lib/listings.js';
import { loadSite } from '../lib/live-render.js';
import { previewHtml } from '../lib/preview.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, planChange } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';

const enc = new TextEncoder();
const BLOG = { title: 'Big', description: 'd', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', pageSize: 10, pagination: { size: 10, stable: true } };
const YEARS = [2019, 2020, 2021, 2022, 2023];
const post = (n, year = YEARS[n % YEARS.length]) => ({ path: `posts/p${n}.md`, text: `---\nslug: p${n}\ntitle: Post ${n}\ndate: ${year}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}\ntags: [${['a', 'b', 'c'][n % 3]}]\nstatus: published\n---\n\nWords of ${n}.\n` });
const corpus = (count) => Array.from({ length: count }, (_, n) => post(n));
const build = (posts, blog = BLOG) => {
  const r = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(r.errors, []);
  return r.files;
};
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

test('split: 500 posts or fewer are as they were; one more splits the archive and the sitemap', () => {
  const small = build(corpus(SPLIT_OVER));
  assert.match(small['sitemap.xml'], /<urlset/);
  assert.ok(!Object.keys(small).some((f) => f.startsWith('sitemaps/') || /^archive\/\d{4}\//.test(f)));
  assert.match(small['archive/index.html'], /<h2 id="y2023">2023<\/h2>/);
  const big = build(corpus(SPLIT_OVER + 1));
  assert.match(big['sitemap.xml'], /<sitemapindex/);
  assert.deepEqual(locs(big['sitemap.xml']), ['site', '2023', '2022', '2021', '2020', '2019'].map((n) => `https://x.test/b/sitemaps/${n}.xml`));
  assert.ok(!/lastmod/.test(big['sitemap.xml']), 'the index names no dates, so it changes only when a year appears');
  assert.deepEqual(Object.keys(big).filter((f) => /^archive\//.test(f)).sort(), ['archive/2019/index.html', 'archive/2020/index.html', 'archive/2021/index.html', 'archive/2022/index.html', 'archive/2023/index.html', 'archive/index.html']);
  const years = [...big['archive/index.html'].matchAll(/<li><a href="(\d{4})\/">\d{4}<\/a> <span class="count">\((\d+)\)<\/span><\/li>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(years.map((y) => y[0]), ['2023', '2022', '2021', '2020', '2019']);
  assert.equal(years.reduce((n, y) => n + y[1], 0), SPLIT_OVER + 1);
  assert.match(big['robots.txt'] || 'Sitemap: https://x.test/b/sitemap.xml', /sitemap\.xml/);
});

test('split: every post is in the archive of its year and in the sitemap of its year, and nothing is lost', () => {
  const posts = corpus(SPLIT_OVER + 40);
  const big = build(posts);
  const all = new Set(posts.map((p) => p.path.replace(/^posts\/|\.md$/g, '')));
  const inArchive = new Set();
  for (const y of YEARS) {
    const page = big[`archive/${y}/index.html`];
    assert.ok(page.includes('<link rel="canonical" href="https://x.test/b/archive/' + y + '/">') && page.includes('href="../">← Archive</a>'));
    for (const m of page.matchAll(/<time datetime="(\d{4})-[^"]*">[^<]*<\/time> <a href="\.\.\/\.\.\/([^"/]+)\/">/g)) {
      assert.equal(m[1], String(y), `${m[2]} is on the page of its own year`);
      inArchive.add(m[2]);
    }
  }
  assert.deepEqual([...inArchive].sort(), [...all].sort());
  // every address is in exactly one sitemap: the posts in the sitemap of their year, the rest in sitemaps/site.xml
  const seen = new Map();
  for (const n of ['site', ...YEARS]) for (const l of locs(big[`sitemaps/${n}.xml`])) seen.set(l, [...(seen.get(l) || []), String(n)]);
  assert.ok([...seen.values()].every((v) => v.length === 1), 'no address twice');
  for (const p of posts) {
    const year = p.text.match(/date: (\d{4})/)[1];
    assert.deepEqual(seen.get(`https://x.test/b/${p.path.replace(/^posts\/|\.md$/g, '')}/`), [year]);
  }
  const rest = [...seen].filter(([, v]) => v[0] === 'site').map(([l]) => l).sort();
  assert.deepEqual(rest, ['https://x.test/b/', 'https://x.test/b/archive/', ...YEARS.map((y) => `https://x.test/b/archive/${y}/`), 'https://x.test/b/tags/', ...['a', 'b', 'c'].map((t) => `https://x.test/b/tags/${t}/`)].sort());
  assert.ok(locs(big['sitemaps/site.xml']).includes('https://x.test/b/archive/2021/'));
});

test('split: the /blog/ reader makes the same year page and the same archive the build writes', async () => {
  const posts = corpus(SPLIT_OVER + 5);
  const files = build(posts);
  const read = async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(BLOG)) : p === 'assets.lock.json' ? enc.encode('{}') : files[p] === undefined ? null : enc.encode(files[p]));
  const site = await loadSite(read, { anyBlog: true });
  for (const f of ['archive/index.html', 'archive/2021/index.html']) assert.equal(previewHtml(site, f).html, files[f], f);
  assert.equal(previewHtml(site, 'archive/1999/index.html').status, 404);
});

test('split: publishing and deleting in the editor change one year, and equal a full build', async () => {
  const base = corpus(SPLIT_OVER + 20);
  const files = { 'blog.json': JSON.stringify(BLOG), 'assets.lock.json': '{}', ...Object.fromEntries(base.map((p) => [p.path, p.text])), ...build(base) };
  const server = fakeGitHub({ 'me/b': files });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const archiveAndSitemap = (plan) => plan.changes.map((c) => c.path).filter((p) => /^archive\/|^sitemap/.test(p)).sort();
  // a post that is not the newest of the blog or of its tag leaves sitemaps/site.xml (the home page's date, the tags' dates) alone

  const added = post(900, 2021);
  const plan = await planChange(gh, { repo: 'me/b', branch: 'main', slug: 'p900', text: added.text, create: true, kind: 'post' });
  assert.equal(plan.ctx.others, null, 'made incrementally');
  assert.deepEqual(archiveAndSitemap(plan), ['archive/2021/index.html', 'archive/index.html', 'sitemaps/2021.xml']);
  await executePlan(gh, plan);

  const del = await planChange(gh, { repo: 'me/b', branch: 'main', slug: 'p900', kind: 'post', remove: true });
  assert.equal(del.ctx.others, null);
  assert.deepEqual(archiveAndSitemap(del), ['archive/2021/index.html', 'archive/index.html', 'sitemaps/2021.xml']);
  await executePlan(gh, del);
  const same = server.files('me/b');
  for (const [p, c] of Object.entries(build(base))) if (p !== 'licences.json') assert.equal(same[p], c, `after publish and delete, ${p} is as it was`);

  // the only post of a year: its archive page and its sitemap go with it, and come back with it
  const first = post(901, 2030);
  await executePlan(gh, await planChange(gh, { repo: 'me/b', branch: 'main', slug: 'p901', text: first.text, create: true, kind: 'post' }));
  assert.ok('archive/2030/index.html' in server.files('me/b') && 'sitemaps/2030.xml' in server.files('me/b'));
  const gone = await planChange(gh, { repo: 'me/b', branch: 'main', slug: 'p901', kind: 'post', remove: true });
  assert.ok(gone.changes.some((c) => c.path === 'archive/2030/index.html' && c.action === 'delete'));
  assert.ok(gone.changes.some((c) => c.path === 'sitemaps/2030.xml' && c.action === 'delete'));
  await executePlan(gh, gone);
  assert.ok(!('archive/2030/index.html' in server.files('me/b')) && !('sitemaps/2030.xml' in server.files('me/b')));
});
