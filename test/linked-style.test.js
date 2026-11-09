// "stylesheet": "linked": every page links one style.css instead of carrying the CSS, so a change of colours, fonts or custom CSS
// changes one file, not every page of the blog. The default is what it always was (the CSS inline in each page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, validateBlog } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';
import { loadSite } from '../lib/live-render.js';
import { previewHtml } from '../lib/preview.js';
import { blogToForm, formToBlog } from '../lib/settings.js';
import { makeBlogJson } from '../lib/init.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, planSettings } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';

const enc = new TextEncoder();
const BLOG = { title: 'Deals', description: 'Live better', author: 'Ada', domain: 'https://example.test/blog', repo: 'me/blog', search: true, pagination: { size: 3 } };
const posts = Array.from({ length: 8 }, (_, n) => ({ path: `posts/p${n}.md`, text: `---\nslug: p${n}\ntitle: Post ${n}\ndate: 2026-01-0${n + 1}\ntags: [${n % 2 ? 'odd' : 'even'}]\nstatus: published\n---\n\nWords of ${n}.\n` }));
const build = (blog) => {
  const r = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(r.errors, []);
  return r.files;
};
const withCss = (css, extra = {}) => ({ ...BLOG, ...extra, customize: { css, colors: { accent: '#d1124f' } } });

test('linked stylesheet: pages link style.css and carry no <style>; the file is the CSS', () => {
  const files = build(withCss('.x{color:red}', { stylesheet: 'linked' }));
  const css = files['style.css'];
  assert.ok(css.includes('.x{color:red}') && css.includes('#d1124f'), 'the file holds the theme and the custom CSS');
  const pages = Object.keys(files).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 10);
  for (const f of pages) {
    const html = files[f];
    if (/url=/.test(html) && /http-equiv="refresh"/.test(html)) continue; // a redirect page has no styles
    assert.ok(!html.includes('<style>'), `${f} carries no stylesheet`);
    const href = (/<link rel="stylesheet" href="([^"]+)">/.exec(html) || [])[1];
    assert.ok(href, `${f} links the stylesheet`);
    const depth = f.replace(/index\.html$/, '').split('/').filter(Boolean).length;
    if (f !== '404.html') assert.equal(href, depth ? `${'../'.repeat(depth)}style.css` : './style.css', f);
  }
});

test('linked stylesheet: the default is unchanged, and "inline" says so', () => {
  const plain = build(withCss('.x{color:red}'));
  assert.ok(!('style.css' in plain));
  assert.ok(plain['index.html'].includes('<style>') && !plain['index.html'].includes('rel="stylesheet"'));
  assert.deepEqual(build(withCss('.x{color:red}', { stylesheet: 'inline' })), plain);
});

test('linked stylesheet: changing the CSS changes one file; inline, it changes every page', () => {
  const a = build(withCss('.x{color:red}', { stylesheet: 'linked' }));
  const b = build(withCss('.x{color:blue}.y{margin:0}', { stylesheet: 'linked' }));
  assert.deepEqual(Object.keys(a).filter((f) => a[f] !== b[f]), ['style.css']);
  const c = build(withCss('.x{color:red}'));
  const d = build(withCss('.x{color:blue}.y{margin:0}'));
  const changed = Object.keys(c).filter((f) => c[f] !== d[f]).filter((f) => f.endsWith('.html'));
  assert.ok(changed.length > 10, `${changed.length} pages change when the CSS is inline`);
});

test('linked stylesheet: a post is the same page whichever way it is built, and the preview and the live page have the CSS', async () => {
  const blog = withCss('.x{color:red}', { stylesheet: 'linked' });
  const files = build(blog);
  const read = async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(blog)) : p === 'assets.lock.json' ? enc.encode('{}') : files[p] === undefined ? null : enc.encode(files[p]));
  const site = await loadSite(read, { anyBlog: true });
  const missing = previewHtml(site, 'no-such-post/index.html');
  assert.equal(missing.status, 404);
  assert.ok(missing.html.includes('<link rel="stylesheet" href="/blog/style.css">'), 'the 404 page is served at any depth: the link is from the root of the site');
  for (const file of ['index.html', 'page/2/index.html', 'tags/odd/index.html', 'p3/index.html']) {
    const out = previewHtml(site, file, { text: file === 'p3/index.html' ? posts[3].text : null });
    assert.equal(out.html, files[file], `${file} is the page the build writes`);
    assert.equal(out.css, files['style.css'].replace(/\n$/, ''), `${file}: the reader gets the CSS to apply`);
  }
});

test('linked stylesheet: only "inline" or "linked"; the Settings form and a new blog carry it', () => {
  assert.throws(() => validateBlog({ ...BLOG, stylesheet: 'external' }), (e) => e instanceof Refusal && e.code === 'bad-blog-json' && /inline.*linked/.test(e.detail));
  const form = blogToForm(validateBlog({ ...BLOG, stylesheet: 'linked' }));
  assert.equal(form.linkStyle, true);
  assert.equal(formToBlog({ ...BLOG, stylesheet: 'linked' }, { ...form, linkStyle: false }).stylesheet, undefined, 'unticked: back to the default, not written');
  assert.equal(formToBlog(BLOG, { ...blogToForm(validateBlog(BLOG)), linkStyle: true }).stylesheet, 'linked');
  assert.equal(makeBlogJson('me/blog', { linkStyle: true, pageSize: 20 }).stylesheet, 'linked');
  assert.equal(makeBlogJson('me/blog', {}).stylesheet, undefined);
});

test('linked stylesheet: in the editor, turning it on rewrites the pages once; after that a change of CSS sends one file', async () => {
  const blog = withCss('.x{color:red}');
  const files = { 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}', ...Object.fromEntries(posts.map((p) => [p.path, p.text])), ...build(blog) };
  const server = fakeGitHub({ 'me/blog': files });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const save = async (change) => {
    const text = (await gh.readText('me/blog', 'blog.json', 'main'));
    const form = change(blogToForm(validateBlog(text)));
    const plan = await planSettings(gh, { repo: 'me/blog', branch: 'main', form });
    if (plan.changes.length) await executePlan(gh, plan);
    return plan;
  };
  const on = await save((f) => ({ ...f, linkStyle: true }));
  assert.ok(on.changes.length > 10, `${on.changes.length} files change once, when it is turned on`);
  assert.ok(on.changes.some((c) => c.path === 'style.css' && c.action === 'add'));
  const edit = await save((f) => ({ ...f, css: '.x{color:blue}.y{margin:0}' }));
  assert.deepEqual(edit.changes.map((c) => c.path).sort(), ['blog.json', 'style.css'], 'a change of CSS is the setting and the stylesheet, and no page');
  const colours = await save((f) => ({ ...f, color_accent: '#112233' }));
  assert.deepEqual(colours.changes.map((c) => c.path).sort(), ['blog.json', 'style.css'], 'so is a change of colour');
  const off = await save((f) => ({ ...f, linkStyle: false }));
  assert.ok(off.changes.some((c) => c.path === 'style.css' && c.action === 'delete'), 'turned off, the file goes and the pages carry the CSS again');
  assert.ok(!('style.css' in server.files('me/blog')));
});

test('linked stylesheet: a CSS-only change is made without reading a post, writes only blog.json, style.css and theme.css, and equals a full rebuild', async () => {
  const blog = { ...withCss('.x{color:red}'), stylesheet: 'linked' };
  const files = { 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}', ...Object.fromEntries(posts.map((p) => [p.path, p.text])), ...build(blog) };
  const server = fakeGitHub({ 'me/blog': files });
  await server.ready;
  const net = createNet(server.fetch);
  const gh = new GitHub(net, { token: 'github_pat_test' });
  const form = (f) => ({ ...f, color_accent: '#112233', css: '.x{color:blue}' });
  const text = await gh.readText('me/blog', 'blog.json', 'main');
  const before = net.ledger.read.requests;
  const plan = await planSettings(gh, { repo: 'me/blog', branch: 'main', form: form(blogToForm(validateBlog(text))) });
  assert.equal(plan.styleOnly, true);
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), ['blog.json', 'style.css']);
  assert.match(plan.headline[0], /no page is rewritten/);
  assert.ok(net.ledger.read.requests - before < 12, `${net.ledger.read.requests - before} requests: no post was read`);
  await executePlan(gh, plan);
  // what was committed is what a full regeneration of that blog.json would produce
  const next = JSON.parse(await gh.readText('me/blog', 'blog.json', 'main'));
  const rebuilt = build(next);
  assert.equal(server.files('me/blog')['style.css'], rebuilt['style.css']);
  assert.equal(server.files('me/blog')['index.html'], rebuilt['index.html']);
  // anything but CSS (a title, the footer, the list layout) is not a style-only change
  const other = await planSettings(gh, { repo: 'me/blog', branch: 'main', form: { ...blogToForm(validateBlog(await gh.readText('me/blog', 'blog.json', 'main'))), title: 'A new title' } });
  assert.ok(!other.styleOnly && other.changes.length > 3, 'a title is on every page');
});
