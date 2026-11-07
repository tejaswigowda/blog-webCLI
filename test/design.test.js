// What a designed front page needs and nothing more: a top bar, link icons, post covers on cards, and a `home` page that is
// the front of the index. Each is data in blog.json or a page; a blog without them generates what it always did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, validateBlog } from '../lib/blog.js';
import { loadSite } from '../lib/live-render.js';
import { fileFor, previewHtml, sourceOf } from '../lib/preview.js';
import { blogAssetRefs } from '../lib/customize.js';
import { blogToForm, formToBlog } from '../lib/settings.js';

const enc = new TextEncoder();
const SHA = 'a'.repeat(40);
const front = (o) => Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}\n`).join('');
const post = (slug, o = {}) => ({ path: `posts/${slug}.md`, text: `---\n${front({ slug, title: `Post ${slug}`, date: '2026-01-01', status: 'published', ...o })}---\n\nWords about ${slug}.\n` });
const page = (slug, body, o = {}) => ({ path: `pages/${slug}.md`, text: `---\n${front({ slug, title: `Page ${slug}`, status: 'published', ...o })}---\n\n${body}\n` });
const blogJson = (extra = {}) => ({
  title: 'Deals', description: 'Live better', author: 'Ada', domain: 'https://example.test/blog', repo: 'me/blog',
  assets: { base: 'https://cdn.example/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/images' } },
  ...extra,
});
const LOCK = { 'images/fb.png': SHA, 'images/3tv.png': SHA, 'images/a.png': SHA };
const customize = {
  topbar: { text: "Arizona's #1 source", links: [{ label: 'Facebook', url: 'https://facebook.com/x', icon: 'asset:images/fb.png' }, { label: 'As seen on', url: 'https://azfamily.com', icon: 'asset:images/3tv.png' }] },
  footer: { text: '© Alicia', links: [{ label: 'Facebook', url: 'https://facebook.com/x', icon: 'asset:images/fb.png' }] },
  list: { layout: 'cards', dates: false, tags: false },
};
const POSTS = [post('alpha', { cover: 'asset:images/a.png', date: '2026-03-01' }), post('beta', { date: '2026-02-01' }), page('home', '## Arizona Deals\n\nReal savings, every day.\n\n[Join](https://example.com/join)', { noindex: 'true' }), page('home-after', 'Under the list.'), page('about', 'About us.', { menu: 1 })];

const build = (blog, posts = POSTS, lock = LOCK) => buildSite({ blog, posts, lock });

test('design: links may carry an icon, pinned like any asset; a missing pin is refused, as for the logo', () => {
  const blog = blogJson({ customize });
  assert.deepEqual(blogAssetRefs(blog).sort(), ['asset:images/3tv.png', 'asset:images/fb.png', 'asset:images/fb.png']);
  const r = build(blog);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const index = r.files['index.html'];
  const icon = (n) => `<img class="icon" src="https://cdn.example/me/images@${SHA}/${n}" alt="">`;
  assert.ok(index.includes(`<a href="https://facebook.com/x" rel="noopener noreferrer" class="">`) === false);
  assert.ok(index.includes(`${icon('fb.png')}<span>Facebook</span>`), 'the words stay, for those who cannot see the picture');
  assert.ok(index.includes('<div class="topbar"><div class="topbar-in">') && index.includes(`<span class="topbar-text">Arizona&#39;s #1 source</span>`));
  assert.ok(index.indexOf('class="topbar"') < index.indexOf('<div class="wrap">'), 'above the header');
  assert.ok(r.files['alpha/index.html'].includes('class="topbar"'), 'on posts too');
  assert.ok(index.includes('<footer class="site">') && index.includes(`${icon('fb.png')}<span>Facebook</span></a></footer>`));
  assert.deepEqual(build(blog, POSTS, {}).errors.map((e) => e.code), ['unresolved-asset']);
  assert.throws(() => validateBlog(JSON.stringify(blogJson({ customize: { topbar: { links: [{ label: 'x', url: 'https://a.b', icon: 'https://evil/x.png' }] } } }))), (e) => e.code === 'bad-blog-json');
  assert.throws(() => validateBlog(JSON.stringify(blogJson({ customize: { topbar: { text: 'x'.repeat(121) } } }))), (e) => e.code === 'bad-blog-json');
  assert.throws(() => validateBlog(JSON.stringify(blogJson({ customize: { topbar: { colour: 'red' } } }))), (e) => e.code === 'bad-blog-json');
});

test('design: without them a blog generates what it always did', () => {
  const plain = build(blogJson(), [post('alpha'), post('beta')]);
  const index = plain.files['index.html'];
  assert.ok(!index.includes('topbar') && !index.includes('class="icon"') && !index.includes('class="thumb"') && !index.includes('class="home"'));
  assert.ok(index.includes('<h1>Deals</h1>'));
  assert.equal(JSON.parse(plain.files['index/posts.json']).home, undefined);
});

test('design: cards show the post\'s cover when it has one, and a card without one is a card without a picture', () => {
  const r = build(blogJson({ customize }));
  const index = r.files['index.html'];
  assert.ok(index.includes(`<a class="thumb" href="alpha/" tabindex="-1" aria-hidden="true"><img src="https://cdn.example/me/images@${SHA}/a.png" alt="" loading="lazy"></a>`));
  assert.equal((index.match(/class="thumb"/g) || []).length, 1);
  // not in a plain list
  const list = build(blogJson({ customize: { ...customize, list: { layout: 'list' } } })).files['index.html'];
  assert.ok(!list.includes('class="thumb"'));
});

test('design: tag and author pages show the same cover thumbnails as the index, in the build and in the reader\'s preview', async () => {
  const posts = [post('alpha', { cover: 'asset:images/a.png', tags: ['deals'], author: 'Ann', date: '2026-03-01' }), post('beta', { tags: ['deals'], author: 'Bob', date: '2026-02-01' })];
  const blog = blogJson({ customize });
  const r = build(blog, posts);
  const thumb = `<a class="thumb" href="../../alpha/" tabindex="-1" aria-hidden="true"><img src="https://cdn.example/me/images@${SHA}/a.png" alt="" loading="lazy"></a>`;
  assert.ok(r.files['tags/deals/index.html'].includes(thumb), 'the tag page has the thumbnail');
  assert.equal((r.files['tags/deals/index.html'].match(/class="thumb"/g) || []).length, 1, 'and only for the post that has a cover');
  const ann = Object.keys(r.files).find((f) => /^authors\/ann\/index\.html$/.test(f));
  assert.ok(ann && r.files[ann].includes(thumb), 'the author page has it too');
  const files = new Map(Object.entries(r.files));
  files.set('blog.json', JSON.stringify(blog));
  files.set('assets.lock.json', JSON.stringify(LOCK));
  for (const p of posts) files.set(p.path, p.text);
  const site = await loadSite(async (p) => (files.has(p) ? enc.encode(files.get(p)) : null), { anyBlog: true });
  const { html } = previewHtml(site, 'tags/deals/index.html');
  assert.equal(html, r.files['tags/deals/index.html'], 'the preview is the deployed page');
});

test('design: the page with the slug "home" is the front of the index, in place of the title, on the first page only', () => {
  const r = build(blogJson({ customize: { list: { layout: 'cards' } }, pagination: { size: 1 } }));
  const index = r.files['index.html'];
  assert.ok(index.includes('<section class="home">\n<h2>Arizona Deals</h2>'));
  assert.ok(!index.includes('<h1>Deals</h1>'), 'it replaces the title and description');
  assert.ok(!r.files['page/2/index.html'].includes('class="home"'), 'later pages are lists');
  assert.equal(JSON.parse(r.files['index/posts.json']).home.startsWith('<h2>Arizona Deals</h2>'), true);
  assert.ok(r.files['home/index.html'], 'and it is still a page of its own');
  // `home-after` is the same, under the list
  assert.ok(index.indexOf('<section class="home-after">\n<p>Under the list.</p>') > index.indexOf('<ul class="posts'), 'under the posts');
  assert.ok(index.indexOf('class="home-after"') < index.indexOf('<footer class="site">'));
  assert.ok(!r.files['page/2/index.html'].includes('home-after'));
  assert.equal(JSON.parse(r.files['index/posts.json']).homeAfter, '<p>Under the list.</p>');
});

test('design: the reader\'s preview of every page is still the deployed page, with all of it on', async () => {
  const blog = blogJson({ customize, pagination: { size: 1 }, content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}' } });
  const r = build(blog);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const files = { ...r.files, 'blog.json': JSON.stringify(blog), 'assets.lock.json': JSON.stringify(LOCK) };
  const site = await loadSite(async (p) => (files[p] === undefined ? null : enc.encode(files[p])), { anyBlog: true });
  const texts = new Map(POSTS.map((i) => [i.path, i.text]));
  const htmls = Object.keys(r.files).filter((f) => f.endsWith('.html') && f !== '404.html');
  assert.ok(htmls.includes('page/2/index.html') && htmls.includes('home/index.html'));
  for (const file of htmls) {
    const src = sourceOf(site, file);
    assert.equal(previewHtml(site, file, { text: src ? texts.get(src) : null }).html, r.files[file], file);
  }
  assert.equal(previewHtml(site, fileFor('/')).html, r.files['index.html']);
});

test('design: Settings carries the top bar and icons on links', () => {
  const blog = blogJson({ customize });
  const form = blogToForm(blog);
  assert.equal(form.topbarText, "Arizona's #1 source");
  assert.equal(form.topbarLinks, 'Facebook | https://facebook.com/x | asset:images/fb.png\nAs seen on | https://azfamily.com | asset:images/3tv.png');
  assert.equal(form.footerLinks, 'Facebook | https://facebook.com/x | asset:images/fb.png');
  const back = formToBlog(blogJson(), { ...blogToForm(blogJson()), topbarText: 'Hi', topbarLinks: 'A | https://a.b | asset:images/fb.png\nB | mailto:me@x.y', headerLinks: 'Groceries | https://example.test/blog/tags/groceries/' });
  assert.deepEqual(back.customize.topbar, { text: 'Hi', links: [{ label: 'A', url: 'https://a.b', icon: 'asset:images/fb.png' }, { label: 'B', url: 'mailto:me@x.y' }] });
  assert.deepEqual(back.customize.header.links, [{ label: 'Groceries', url: 'https://example.test/blog/tags/groceries/' }]);
  assert.equal(formToBlog(back, { ...blogToForm(back), topbarText: '', topbarLinks: '' }).customize.topbar, undefined, 'cleared, it is not written');
});

test('design: a blog that relies on the default images folder (no "assets" in blog.json) pins and draws its icons and pages\' pictures', async () => {
  const { assets, ...bare } = blogJson({ customize: { topbar: { links: [{ label: 'Facebook', url: 'https://facebook.com/x', icon: 'asset:images/fb.png' }] }, header: { logo: 'asset:images/logo.png' } } });
  void assets;
  const lock = { 'images/fb.png': SHA, 'images/logo.png': SHA, 'images/hero.png': SHA };
  const r = buildSite({ blog: bare, posts: [page('home', '![](asset:images/hero.png)'), post('alpha')], lock });
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const index = r.files['index.html'];
  assert.ok(index.includes(`https://cdn.jsdelivr.net/gh/me/blog@${SHA}/images/fb.png`), 'the icon, from the blog\'s own images folder');
  assert.ok(index.includes(`https://cdn.jsdelivr.net/gh/me/blog@${SHA}/images/hero.png`) && index.includes(`/images/logo.png`));
  // and the reader's preview, which reads the same blog.json, makes the same page
  const files = { ...r.files, 'blog.json': JSON.stringify(bare), 'assets.lock.json': JSON.stringify(lock) };
  const site = await loadSite(async (p) => (files[p] === undefined ? null : enc.encode(files[p])), { anyBlog: true });
  assert.equal(previewHtml(site, 'index.html').html, index);
});
