// The /blog/ reader's preview is the deployed page: for every HTML file the build writes, the preview makes the same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite } from '../lib/blog.js';
import { loadSite } from '../lib/live-render.js';
import { fileFor, previewHtml, sourceOf } from '../lib/preview.js';

const enc = new TextEncoder();
const blogJson = (extra = {}) => ({ title: 'Alicia\'s Deals', description: 'Live <b>better</b>', author: 'Ada', domain: 'https://example.test/blog', repo: 'me/blog', ...extra });
const front = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}\n`).join('');
const post = (slug, o = {}) => {
  const { body = `Words about ${slug}. [a link](../other/) and **bold**.`, ...meta } = o;
  return { path: `posts/${slug}.md`, text: `---\n${front({ slug, title: `Post ${slug}`, date: '2026-01-01', status: 'published', ...meta })}---\n\n${body}\n` };
};
const page = (slug, o = {}) => {
  const { body = `About ${slug}.`, ...meta } = o;
  return { path: `pages/${slug}.md`, text: `---\n${front({ slug, title: `Page ${slug}`, status: 'published', ...meta })}---\n\n${body}\n` };
};
const POSTS = [
  post('alpha', { date: '2026-03-01', tags: ['video', 'git'], author: 'Ada' }),
  post('beta', { date: '2026-02-01', tags: ['video'], author: 'Grace' }),
  post('gamma', { date: '2025-12-01', tags: ['notes'] }),
  post('delta', { date: '2025-11-01', tags: ['notes', 'git'] }),
  post('secret', { date: '2026-04-01', tags: ['hidden'], status: 'draft' }),
  page('about', { menu: 1 }),
  page('contact'),
];

async function siteOf(blog, inputs = POSTS) {
  const r = buildSite({ blog, posts: inputs, lock: {} });
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const files = { ...r.files, 'blog.json': JSON.stringify(blog) };
  const site = await loadSite(async (p) => (files[p] === undefined ? null : enc.encode(files[p])), { anyBlog: true });
  const texts = new Map(inputs.map((i) => [i.path, i.text]));
  return { r, site, texts, files };
}

const same = async (blog, label) => {
  const { r, site, texts } = await siteOf(blog);
  const htmls = Object.keys(r.files).filter((f) => f.endsWith('.html') && f !== '404.html' && !f.startsWith('theme'));
  assert.ok(htmls.length > 8, `${label}: a site with pages to compare (${htmls.length})`);
  for (const file of htmls) {
    const src = sourceOf(site, file);
    const out = previewHtml(site, file, { text: src ? texts.get(src) : null });
    assert.equal(out.status, 200, `${label}: ${file}`);
    assert.equal(out.html, r.files[file], `${label}: ${file} is the page the build writes`);
  }
  return { r, site, texts, htmls };
};

test('preview: every page of a rich blog is byte-identical to the deployed one (index, pages, tags, authors, archive, search, posts, standalone pages)', async () => {
  const { htmls } = await same(blogJson({ pagination: { size: 2 }, search: true, content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}' } }), 'paged, live, search');
  for (const want of ['index.html', 'page/2/index.html', 'tags/index.html', 'tags/video/index.html', 'authors/ada/index.html', 'archive/index.html', 'search/index.html', 'alpha/index.html', 'about/index.html']) assert.ok(htmls.includes(want), want);
});

test('preview: the same without pagination, without the live copy, with another date format and another default author', async () => {
  await same(blogJson({ dateFormat: 'D MMM YYYY' }), 'plain');
  await same(blogJson({ pagination: { size: 1 }, dateFormat: 'YYYY-MM-DD', customize: { list: { layout: 'cards', excerpts: false } } }), 'cards, one a page');
});

test('preview: a draft, an unknown address and a post that has no page are the site\'s 404, never a page', async () => {
  const blog = blogJson({ content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}' } });
  const { r, site, texts } = await siteOf(blog);
  const missing = previewHtml(site, fileFor('/no/such/place/'));
  assert.equal(missing.status, 404);
  assert.equal(missing.html, r.files['404.html'], 'the 404 is the one the site serves');
  assert.equal(previewHtml(site, fileFor('/secret/'), { text: texts.get('posts/secret.md') }).status, 404, 'a draft is not on the site');
  assert.equal(sourceOf(site, 'secret/index.html'), null);
  assert.equal(previewHtml(site, fileFor('tags/hidden/')).status, 404, 'a draft\'s tag has no page');
});

test('preview: addresses are the same page however they are written', () => {
  for (const p of ['', '/', 'index.html', '/index.html']) assert.equal(fileFor(p), 'index.html');
  for (const p of ['tags/video', 'tags/video/', '/tags/video/index.html']) assert.equal(fileFor(p), 'tags/video/index.html');
  assert.equal(fileFor('page/2/'), 'page/2/index.html');
});

test('preview: a reader\'s own order of the index changes the list and nothing else', async () => {
  const blog = blogJson({ pagination: { size: 2 } });
  const { site, r } = await siteOf(blog);
  const sorted = [...site.index.posts].sort((a, b) => (a.title < b.title ? -1 : 1)).reverse();
  const out = previewHtml(site, 'index.html', { entries: sorted, size: 0 });
  assert.notEqual(out.html, r.files['index.html']);
  assert.ok(out.html.indexOf('Post gamma') < out.html.indexOf('Post alpha'));
  assert.ok(!out.html.includes('aria-label="Pages"'), 'a sorted list is one list');
  assert.ok(r.files['index.html'].includes('aria-label="Pages"'), 'where the build pages it');
  assert.ok(out.html.includes(r.files['index.html'].match(/<style>[\s\S]*?<\/style>/)[0]), 'with the same style');
});
