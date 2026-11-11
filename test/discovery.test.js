// Discovery and URL continuity: images carry their size (E13), /feed/ is a page and never the Atom document (E10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite } from '../lib/blog.js';
import { imageSize, sizeEntry } from '../lib/image-size.js';

const PNG = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const BLOG = { title: 'T', description: 'D', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', assets: { repos: { images: 'me/img' }, base: 'https://cdn.test/{owner}/{repo}@{sha}/{path}' } };
const post = (body) => ({ path: 'posts/a.md', text: `---\nslug: a\ntitle: "A"\ndate: 2026-01-01\nauthor: Ann\nstatus: published\n---\n\n${body}\n` });

test('image size: PNG, GIF and WebP are read from the first bytes; anything else is null', () => {
  assert.deepEqual(imageSize(PNG(640, 480)), { width: 640, height: 480 });
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00]);
  assert.deepEqual(imageSize(gif), { width: 288, height: 16 });
  const jpg = new Uint8Array(40);
  jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x00, 0x02, 0x00]);
  assert.deepEqual(imageSize(jpg), { width: 512, height: 256 });
  assert.equal(imageSize(new Uint8Array(40)), null);
  assert.deepEqual(sizeEntry('images', 'a.png', PNG(3, 2)), { 'images/a.png#size': '3x2' });
  assert.deepEqual(sizeEntry('images', 'a.png', new Uint8Array(4)), {});
});

test('E13: an image the lock knows the size of carries width and height; one it does not is as before', () => {
  const lock = { 'images/a.png': 'a'.repeat(40), 'images/a.png#size': '640x480', 'images/b.png': 'b'.repeat(40) };
  const r = buildSite({ blog: BLOG, posts: [post('![pic](asset:images/a.png)\n\n![other](asset:images/b.png)')], lock });
  assert.deepEqual(r.errors, []);
  const page = r.files['a/index.html'];
  assert.match(page, /<img src="[^"]*a\.png" alt="pic" width="640" height="480" loading="lazy">/);
  assert.match(page, /<img src="[^"]*b\.png" alt="other" loading="lazy">/);
});

test('E10: every page has feed autodiscovery; /feed/ is a page that points at the feed, with no Atom document', () => {
  const r = buildSite({ blog: BLOG, posts: [post('hi')], lock: {} });
  assert.match(r.files['a/index.html'], /<link rel="alternate" type="application\/atom\+xml"[^>]*href="\.\.\/feed\.xml"/);
  const f = r.files['feed/index.html'];
  assert.ok(f.startsWith('<!doctype html>') && !f.includes('<feed'));
  assert.match(f, /rel="alternate" type="application\/atom\+xml"[^>]*href="\.\.\/feed\.xml"/);
  assert.match(f, /http-equiv="refresh"/);
  assert.match(f, /now at/);
  assert.ok(r.files['feed.xml'].includes('<feed'));
});

test('E12: seo.noindex puts noindex on every page and writes no sitemap; off by default', () => {
  const on = buildSite({ blog: { ...BLOG, seo: { noindex: true } }, posts: [post('hi')], lock: {} });
  assert.deepEqual(on.errors, []);
  for (const f of ['index.html', 'a/index.html', 'archive/index.html']) assert.match(on.files[f], /<meta name="robots" content="noindex">/, f);
  assert.ok(!on.files['sitemap.xml'] && !on.files['robots.txt']);
  const off = buildSite({ blog: BLOG, posts: [post('hi')], lock: {} });
  assert.ok(!/name="robots"/.test(off.files['a/index.html']) && off.files['sitemap.xml']);
  assert.throws(() => buildSite({ blog: { ...BLOG, seo: { noindex: 'yes' } }, posts: [post('hi')], lock: {} }));
});

test('headings reach level 4; a paragraph style is "{.lead} " or "{.small} " and renders as a class', async () => {
  const { mdToDelta, deltaToMd, mdRoundTrips } = await import('../lib/markdown.js');
  const { deltaToHtml } = await import('../lib/html.js');
  const md = '# One\n\n#### Four\n\n{.lead} An opening line.\n\n{.small} Fine print, **bold** too.\n\nPlain.\n';
  assert.equal(mdRoundTrips(md).ok, true);
  const html = deltaToHtml(mdToDelta(md), { resolve: (r) => r, resolveVideo: (r) => r });
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<h4>Four<\/h4>/);
  assert.match(html, /<p class="lead">An opening line\.<\/p>/);
  assert.match(html, /<p class="small">Fine print, <strong>bold<\/strong> too\.<\/p>/);
  // words that only look like the marker stay words
  const literal = '\\{.lead} not a style\n';
  assert.equal(mdRoundTrips(literal).ok, true);
  assert.ok(!mdToDelta(literal).ops.some((o) => o.attributes && o.attributes.para));
  const { deltaToMarkdownChecked } = await import('../lib/markdown.js');
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'x' }, { insert: '\n', attributes: { para: 'huge' } }] }));
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'x' }, { insert: '\n', attributes: { para: 'lead', header: 2 } }] }));
});

test('settings: the text size is a choice, and the form round-trips it', async () => {
  const { blogToForm, formToBlog } = await import('../lib/settings.js');
  const blog = { ...BLOG, customize: { fontSize: '18px' } };
  assert.equal(blogToForm(blog).fontSize, '18px');
  assert.equal(formToBlog(blog, { ...blogToForm(blog), fontSize: '20px' }).customize.fontSize, '20px');
  assert.equal(formToBlog(blog, { ...blogToForm(blog), fontSize: '' }).customize?.fontSize, undefined);
});

test('picture layouts: ![alt](src){.medium} round-trips, renders as a class, and only the closed set is accepted', async () => {
  const { mdToDelta, mdRoundTrips, deltaToMarkdownChecked } = await import('../lib/markdown.js');
  const { deltaToHtml } = await import('../lib/html.js');
  const { IMAGE_LAYOUTS } = await import('../lib/delta.js');
  for (const l of IMAGE_LAYOUTS) {
    const md = `Words ![a pic](asset:images/x.png){.${l}} more.\n`;
    assert.equal(mdRoundTrips(md).ok, true, l);
    const html = deltaToHtml(mdToDelta(md), { resolve: (r) => `/${r}`, resolveVideo: (r) => r });
    assert.match(html, new RegExp(`<img src="/asset:images/x\\.png" alt="a pic" class="img-${l}" loading="lazy">`), l);
  }
  // no layout, as before; an unknown one is just text after the picture
  assert.match(deltaToHtml(mdToDelta('![a](asset:images/x.png)\n'), { resolve: (r) => `/${r}`, resolveVideo: (r) => r }), /<img src="[^"]*" alt="a" loading="lazy">/);
  assert.ok(!mdToDelta('![a](asset:images/x.png){.huge}\n').ops.some((o) => o.attributes && o.attributes.layout));
  // text that looks like a layout marker is escaped, so it stays text
  assert.equal(mdRoundTrips('![a](asset:images/x.png) \\{.left} text\n').ok, true);
  const img = (attributes) => ({ ops: [{ insert: { image: 'asset:images/x.png' }, attributes }, { insert: '\n' }] });
  assert.throws(() => deltaToMarkdownChecked(img({ layout: 'huge' })));
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'x', attributes: { layout: 'full' } }, { insert: '\n' }] }));
  assert.equal(deltaToMarkdownChecked(img({ layout: 'full', alt: 'p' })).md, '![p](asset:images/x.png){.full}\n');
});

test('E13: "blog-webcli sizes" records the pixel size of pinned pictures from the files, and the next build draws width and height', async () => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sizes-'));
  const cli = (...a) => spawnSync(process.execPath, [path.resolve('cli/blog.js'), ...a], { encoding: 'utf8' });
  const blog = { ...BLOG, assets: { base: 'https://cdn.test/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/b/images' } } };
  await fs.mkdir(path.join(dir, 'posts'));
  await fs.mkdir(path.join(dir, 'images'));
  await fs.writeFile(path.join(dir, 'blog.json'), JSON.stringify(blog));
  await fs.writeFile(path.join(dir, 'posts/a.md'), post('![pic](asset:images/p.png)').text);
  await fs.writeFile(path.join(dir, 'images/p.png'), PNG(640, 480));
  await fs.writeFile(path.join(dir, 'assets.lock.json'), JSON.stringify({ 'images/p.png': 'a'.repeat(40) }));
  const r = cli('sizes', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'assets.lock.json'), 'utf8'))['images/p.png#size'], '640x480');
  assert.equal(cli('build', dir).status, 0);
  assert.match(await fs.readFile(path.join(dir, 'a/index.html'), 'utf8'), /alt="pic" width="640" height="480"/);
  await fs.rm(dir, { recursive: true });
});
