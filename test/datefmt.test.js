// Dates read as "November 5, 2026" (moment.js, one module for the generator, the live renderer and the reader), in a
// format the blog's owner chooses; the machine-readable date stays ISO, and the text never depends on the clock or the zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, validateBlog } from '../lib/blog.js';
import { DEFAULT_DATE_FORMAT, dateLabel, formatDate, validateDateFormat } from '../lib/datefmt.js';
import { blogToForm, formToBlog } from '../lib/settings.js';
import { loadSite, renderFromSite } from '../lib/live-render.js';
import { indexList, postBody } from '../lib/contracts.js';

const blogJson = (extra = {}) => ({ title: 'T', description: 'D', author: 'Ada', domain: 'https://example.test', ...extra });
const post = (slug, date, extra = '') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: Post ${slug}\ndate: ${date}\nstatus: published\n${extra}---\n\nWords about ${slug}.\n` });
const POSTS = [post('alpha', '2026-03-01', 'tags: [a]\n'), post('beta', '2025-12-25')];
const build = (blog) => {
  const r = buildSite({ blog: blogJson(blog), posts: POSTS, lock: {} });
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r;
};

test('dates: formatted by moment.js as a fixed calendar day, never as the clock or a zone would have it', () => {
  assert.equal(DEFAULT_DATE_FORMAT, 'MMMM D, YYYY');
  assert.equal(formatDate('2026-11-05'), 'November 5, 2026');
  assert.equal(formatDate('2026-01-01', 'MMM D, YYYY'), 'Jan 1, 2026');
  assert.equal(formatDate('2026-12-31', 'dddd, MMMM Do'), 'Thursday, December 31st');
  assert.equal(formatDate('2026-03-01', 'D MMMM YYYY'), '1 March 2026');
  assert.equal(formatDate('2026-03-01', '[Posted] LL'), 'Posted March 1, 2026');
  assert.equal(formatDate('2026-03-01', 'YYYY-MM-DD'), '2026-03-01');
  assert.equal(formatDate('2024-02-29'), 'February 29, 2024');
  // not a calendar day: shown as written, never "Invalid date"
  for (const bad of ['', 'soon', '2026-13-45', '2026-2-3', '2026-02-30']) assert.equal(formatDate(bad), bad);
  const zone = process.env.TZ;
  for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
    process.env.TZ = tz;
    assert.equal(formatDate('2026-11-05'), 'November 5, 2026', tz);
  }
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  assert.equal(dateLabel({}, '2026-11-05'), 'November 5, 2026');
  assert.equal(dateLabel({ dateFormat: 'MMM D' }, '2026-11-05'), 'Nov 5');
});

test('dates: dateFormat in blog.json is validated, and a format that makes no date is refused', () => {
  for (const f of ['MMMM D, YYYY', 'D MMM YY', 'YYYY-MM-DD', '[on] dddd']) assert.doesNotThrow(() => validateDateFormat(f), f);
  for (const f of ['', '   ', 'x'.repeat(41), 5, null, {}, []]) assert.throws(() => validateDateFormat(f), (e) => e.code === 'bad-blog-json', String(f));
  assert.doesNotThrow(() => validateBlog(JSON.stringify(blogJson({ dateFormat: 'MMM D, YYYY' }))));
  assert.throws(() => validateBlog(JSON.stringify(blogJson({ dateFormat: 7 }))), (e) => e.code === 'bad-blog-json');
});

test('dates: every page of both markup contracts shows the formatted date and keeps ISO in datetime', () => {
  for (const [name, extra] of [['default', {}], ['custom', { dateFormat: 'D MMM YYYY' }], ['iso', { dateFormat: 'YYYY-MM-DD' }]]) {
    const r = build(extra);
    const shown = (iso) => formatDate(iso, extra.dateFormat || DEFAULT_DATE_FORMAT);
    const alpha = r.files['alpha/index.html'];
    assert.ok(alpha.includes(`<time datetime="2026-03-01">${shown('2026-03-01')}</time>`), `${name}: post page`);
    assert.ok(r.files['index.html'].includes(`<time datetime="2025-12-25">${shown('2025-12-25')}</time>`), `${name}: index`);
    assert.ok(r.files['archive/index.html'].includes(`<time datetime="2026-03-01">${shown('2026-03-01')}</time>`), `${name}: archive`);
    assert.ok(r.files['tags/a/index.html'].includes(`<time datetime="2026-03-01">${shown('2026-03-01')}</time>`), `${name}: a tag page`);
    // machine readers are never given the display text
    assert.match(alpha, /<meta property="article:published_time" content="2026-03-01">/);
    assert.match(r.files['feed.xml'], /<published>2026-03-01T00:00:00Z<\/published>/);
    assert.match(r.files['sitemap.xml'], /<lastmod>2026-03-01<\/lastmod>/);
    assert.match(alpha, /"datePublished":"2026-03-01"/);
  }
  // the WordPress-classic contract formats them the same way
  const entry = { slug: 'alpha', title: 'A', date: '2026-03-01', tags: [], excerpt: '' };
  const blog = blogJson({ dateFormat: 'MMM D, YYYY' });
  assert.ok(indexList('wordpress-classic', { blog, entries: [entry], hrefFor: (s) => s }).includes('<time class="entry-date published" datetime="2026-03-01">Mar 1, 2026</time>'));
  const meta = { slug: 'alpha', title: 'A', date: '2026-03-01', tags: [] };
  assert.ok(postBody('wordpress-classic', { blog, meta, bodyHtml: '<p>x</p>', home: '', feed: '' }).html.includes('datetime="2026-03-01">Mar 1, 2026</time>'));
  const text = JSON.parse(build({}).files['index/posts.json']).posts.map((e) => e.date);
  assert.deepEqual(text.sort(), ['2025-12-25', '2026-03-01'], 'the index records the ISO date');
});

test('dates: the live renderer makes the same page as the build, in the blog\'s own format', async () => {
  const r = build({ repo: 'example/blog', dateFormat: 'dddd, MMMM Do YYYY', content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}' } });
  const enc = new TextEncoder();
  const files = { ...r.files, 'blog.json': JSON.stringify(blogJson({ repo: 'example/blog', dateFormat: 'dddd, MMMM Do YYYY', content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}' } })) };
  const site = await loadSite(async (p) => (files[p] === undefined ? null : enc.encode(files[p])));
  const out = renderFromSite(site, { slug: 'alpha', text: POSTS[0].text });
  assert.equal(out.html, r.files['alpha/index.html'], 'byte for byte');
  assert.ok(out.html.includes('Sunday, March 1st 2026'));
});

test('dates: Settings shows the format, writes it only when it is not the default, and refuses nonsense', () => {
  const base = blogJson();
  assert.equal(blogToForm(base).dateFormat, 'MMMM D, YYYY');
  const set = formToBlog(base, { ...blogToForm(base), dateFormat: 'MMM D, YYYY' });
  assert.equal(set.dateFormat, 'MMM D, YYYY');
  assert.equal(formToBlog(set, { ...blogToForm(set), dateFormat: 'MMMM D, YYYY' }).dateFormat, undefined, 'the default is not written');
  assert.equal(formToBlog(set, { ...blogToForm(set), dateFormat: '' }).dateFormat, undefined);
  assert.equal(formToBlog(base, { ...blogToForm(base), dateFormat: 'YYYY-MM-DD' }).dateFormat, 'YYYY-MM-DD', 'the plain date is a choice');
  assert.throws(() => validateBlog(JSON.stringify(formToBlog(base, { ...blogToForm(base), dateFormat: 'x'.repeat(50) }))), (e) => e.code === 'bad-blog-json');
});
