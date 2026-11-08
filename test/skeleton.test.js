// A theme's page skeleton: the theme's own page structure (header, navigation, containers, footer as elements and classes, no text)
// with holes for the blog's content. Read as untrusted data: a strict grammar, exactly the placeholders, nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkeleton, checkBodyClass, checkSkeleton } from '../lib/skeleton.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths, validateThemeManifest } from '../lib/theme-pack.js';
import { buildSite } from '../lib/blog.js';
import { indexBody, postBody } from '../lib/contracts.js';
import { harvestSkeleton } from '../cli/wp-skeleton.js';
import { loadSite, renderFromSite } from '../lib/live-render.js';
import { Refusal } from '../lib/errors.js';

const enc = new TextEncoder();
const code = (c) => (e) => e instanceof Refusal && e.code === c;
const GOOD = '<div id="page" class="site grid-container"><header id="masthead" class="site-header"><a class="brand" rel="home" href="{{home}}">{{site-title}}</a><nav class="main-navigation"><ul class="menu">{{menu}}</ul></nav></header><div id="content"><main id="main" class="site-main">{{content}}</main></div><footer class="site-footer"><div class="site-info">{{footer}}</div></footer></div>';

test('the checker accepts a skeleton and refuses everything outside the grammar', () => {
  assert.equal(checkSkeleton(GOOD), GOOD);
  const refused = {
    'a script': GOOD.replace('<header', '<script>x</script><header'),
    'an image': GOOD.replace('<header', '<img src="x"><header'),
    'text': GOOD.replace('<header', 'Hello <header'),
    'an event handler': GOOD.replace('<nav ', '<nav onclick="x" '),
    'a style attribute': GOOD.replace('<nav ', '<nav style="x" '),
    'an outside link': GOOD.replace('href="{{home}}"', 'href="https://evil.test/"'),
    'a javascript link': GOOD.replace('href="{{home}}"', 'href="javascript:x"'),
    'a comment': GOOD.replace('<header', '<!-- x --><header'),
    'a form': GOOD.replace('<header', '<form><header'),
    'an unknown placeholder': GOOD.replace('{{footer}}', '{{secret}}'),
    'no content': GOOD.replace('{{content}}', ''),
    'content twice': GOOD.replace('{{footer}}', '{{content}}'),
    'an unclosed element': GOOD.replace('</footer>', ''),
    'a mismatched element': GOOD.replace('</nav>', '</div>'),
    'a class with a quote': GOOD.replace('class="site-header"', "class='a'b'"),
    'a bad role': GOOD.replace('<nav ', '<nav role="button" '),
    'too many menus': GOOD.replace('{{menu}}', '{{menu}}</ul><ul>{{menu}}</ul><ul>{{menu}}</ul><ul>{{menu}}'),
    'too large': GOOD.replace('{{footer}}', `${'<div class="x"></div>'.repeat(4000)}{{footer}}`),
  };
  for (const [what, html] of Object.entries(refused)) assert.throws(() => checkSkeleton(html), code('bad-theme'), what);
  assert.equal(checkBodyClass('ast-desktop no-sidebar'), 'ast-desktop no-sidebar');
  for (const v of ['a"b', 'x<y', 5, 'a'.repeat(301)]) assert.throws(() => checkBodyClass(v), code('bad-theme'), String(v));
});

test('the manifest may name a skeleton only for a wordpress-classic theme, and it is part of the pinned files', () => {
  const m = { name: 'T', version: '1', licence: 'GPL-2.0-or-later', class_contract: 'wordpress-classic', css: ['style.css'], skeleton: 'skeleton.html', body_class: 'a b' };
  assert.doesNotThrow(() => validateThemeManifest(m));
  assert.throws(() => validateThemeManifest({ ...m, class_contract: 'blog-webcli-v1' }), code('bad-theme'));
  assert.throws(() => validateThemeManifest({ ...m, skeleton: '../x.html' }), code('bad-theme'));
  assert.throws(() => validateThemeManifest({ ...m, body_class: 'bad"class' }), code('bad-theme'));
  assert.deepEqual(themeFilePaths(m), ['skeleton.html', 'style.css', 'theme.json']);
});

function pinned(skeletonHtml, extra = {}) {
  const manifest = { name: 'Sk', version: '1.0', licence: 'GPL-2.0-or-later', class_contract: 'wordpress-classic', css: ['style.css'], skeleton: 'skeleton.html', body_class: 'sk-theme no-sidebar', ...extra };
  const files = { 'theme.json': enc.encode(JSON.stringify(manifest)), 'style.css': enc.encode('.site-header{color:#123}'), 'skeleton.html': enc.encode(skeletonHtml) };
  const pin = pinFor('me/themes/sk', 'v1.0.0', manifest, themeDigest(files, themeFilePaths(manifest)));
  return { pin, theme: loadTheme(pin, files), files };
}
const BLOG = { title: 'Brand {{content}} & <b>', description: 'About', author: 'A', domain: 'https://example.test/b', repo: 'me/b' };
const post = (slug, body) => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: ${slug}\ndate: 2026-01-01\nstatus: published\n---\n\n${body}\n` });

test('a skeleton shapes every page: its structure around the blog\'s content, menu, title and footer, with its body classes', () => {
  const { pin, theme } = pinned(GOOD);
  assert.equal(theme.contractSpec.name, 'wordpress-classic');
  const r = buildSite({ blog: JSON.stringify({ ...BLOG, theme: pin }), posts: [post('one', 'Hello PAYLOAD {{menu}}')], lock: {}, theme });
  assert.deepEqual(r.errors, []);
  for (const f of ['index.html', 'one/index.html']) {
    const html = r.files[f];
    assert.match(html, /<body class="sk-theme no-sidebar [^"]*">/, `${f}: the theme's body classes first`);
    assert.match(html, /<div id="page" class="site grid-container"><header id="masthead" class="site-header"><a class="brand" rel="home" href="[^"]*">Brand \{\{content\}\} &amp; &lt;b&gt;<\/a>/, `${f}: the theme's header, with the blog's title escaped and not treated as a placeholder`);
    assert.match(html, /<ul class="menu"><li class="menu-item">/, `${f}: the blog's menu in the theme's list`);
    assert.match(html, /<footer class="site-footer"><div class="site-info">/);
  }
  assert.match(r.files['one/index.html'], /<main id="main" class="site-main">[\s\S]*Hello PAYLOAD \{\{menu\}\}[\s\S]*<\/main>/, 'the post is the main content, and a placeholder-looking word in it stays text');
  assert.equal(r.files['theme-skeleton.json'].includes('"bodyClass"'), true, 'the skeleton ships with the blog, for the live script and the reader');
  assert.ok(!('theme-skeleton.json' in buildSite({ blog: JSON.stringify(BLOG), posts: [post('one', 'x')], lock: {} }).files), 'no theme, no skeleton file');
});

test('a theme with no skeleton is exactly as before; the pinned digest covers the skeleton', () => {
  const a = pinned(GOOD);
  const b = pinned(GOOD.replace('site-header', 'site-header2'));
  assert.notEqual(a.pin.sha256, b.pin.sha256, 'changing the skeleton changes what a blog pinned');
  const plain = { name: 'P', version: '1', licence: 'GPL-2.0-or-later', class_contract: 'wordpress-classic', css: ['style.css'] };
  const files = { 'theme.json': enc.encode(JSON.stringify(plain)), 'style.css': enc.encode('a{}') };
  const t = loadTheme(pinFor('me/t', 'v1.0.0', plain, themeDigest(files, themeFilePaths(plain))), files);
  assert.equal(t.contractSpec, 'wordpress-classic');
  assert.equal(t.skeleton, null);
  const d = { blog: BLOG, entries: [], hrefFor: () => '#', home: './', feed: './feed.xml', meta: { slug: 's', title: 't', date: '2026-01-01', tags: [] }, bodyHtml: '<p>x</p>' };
  assert.equal(indexBody('wordpress-classic', d).html, indexBody(t.contractSpec, d).html);
  assert.equal(postBody('wordpress-classic', d).html, postBody(t.contractSpec, d).html);
});

test('a skeleton that fails the rules is refused when the theme loads, and when a blog\'s committed copy is read', async () => {
  assert.throws(() => pinned(GOOD.replace('<header', '<script>1</script><header')), code('bad-theme'));
  const { pin, theme } = pinned(GOOD);
  const blog = { ...BLOG, theme: pin, content: { base: 'https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}' } };
  const built = buildSite({ blog: JSON.stringify(blog), posts: [post('one', 'x')], lock: {}, theme });
  const serve = (tamper) => async (p) => {
    const files = { ...built.files, 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}' };
    if (tamper) files['theme-skeleton.json'] = JSON.stringify({ html: GOOD.replace('<header', '<script>1</script><header'), bodyClass: '' });
    return p in files ? enc.encode(files[p]) : null;
  };
  const site = await loadSite(serve(false));
  const live = renderFromSite(site, { slug: 'one', text: post('one', 'x').text });
  assert.equal(live.html, built.files['one/index.html'], 'the live renderer pours into the same skeleton');
  const bad = await loadSite(serve(true));
  assert.throws(() => renderFromSite(bad, { slug: 'one', text: post('one', 'x').text }), (e) => e.reason === 'bad-theme-skeleton');
});

test('harvest: a demo page becomes a skeleton: structure and classes, no text, no outside links, sidebars gone, holes where content goes', () => {
  const demo = `<html><head><title>x</title></head><body class="home blog ast-desktop ast-right-sidebar admin-bar wp-theme-demo transparent-header postid-5">
<script>alert(1)</script>
<a class="skip-link screen-reader-text" href="#content">Skip to content</a>
<div id="page" class="hfeed site" style="color:red" onclick="x()">
<header id="masthead" class="site-header"><div class="site-branding"><a href="https://demo.test/" rel="home" class="custom-logo-link"><img src="logo.png"></a><p class="site-description">Just another site</p></div>
<nav class="main-navigation"><ul id="menu-1" class="menu"><li class="menu-item"><a href="https://demo.test/about">About us</a></li></ul><button class="menu-toggle">Menu</button></nav></header>
<div id="content" class="site-content"><div id="primary" class="content-area"><main id="main" class="site-main"><article class="post"><h2 class="entry-title"><a href="/hello">Hello world</a></h2><p>Demo text</p></article></main></div>
<aside id="secondary" class="widget-area"><section class="widget"><h2>Recent posts</h2></section></aside></div>
<footer id="colophon" class="site-footer"><div class="site-info">Proudly powered by WordPress <a href="https://wordpress.org">WP</a></div></footer></div></body></html>`;
  const sk = harvestSkeleton(demo);
  assert.ok(sk);
  assert.doesNotThrow(() => checkSkeleton(sk.html));
  for (const gone of ['alert', 'Skip to content', 'About us', 'Hello world', 'Demo text', 'Recent posts', 'WordPress', 'demo.test', 'style=', 'onclick', 'logo.png', 'widget-area', 'menu-toggle', 'Just another site']) assert.ok(!sk.html.includes(gone), `${gone} is gone`);
  for (const kept of ['id="page"', 'class="hfeed site"', 'id="masthead"', 'class="custom-logo-link"', 'class="site-branding"', 'class="main-navigation"', 'id="content"', 'id="primary"', '<main id="main" class="site-main">{{content}}</main>', '<ul id="menu-1" class="menu">{{menu}}</ul>', '<div class="site-info">{{footer}}</div>', 'href="{{home}}"']) assert.ok(sk.html.includes(kept), `${kept} is kept`);
  assert.equal(sk.bodyClass, 'ast-desktop wp-theme-demo no-sidebar'.replace('wp-theme-demo ', ''), 'routing, sidebar, admin-bar, transparent-header and post-specific classes are dropped; no-sidebar is added');
  assert.equal(harvestSkeleton('<html><body><div>no main area</div></body></html>'), null);
});

test('applySkeleton leaves a page alone when it is not in the classic structure', () => {
  const built = { bodyClass: 'x', html: '<div>other</div>' };
  assert.equal(applySkeleton({ html: GOOD, bodyClass: 'y' }, built, { blog: BLOG, home: './' }), built);
});
