// X5 / X6: WordPress ingestion takes directory themes only, refuses on licence, records what was dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importWordPressTheme, parseDemo } from '../cli/wp-import.js';
import { writeZip } from '../cli/zip.js';

const style = (extra = '', license = 'GNU General Public License v2 or later') => `/*
Theme Name: Demo
Theme URI: https://wordpress.org/themes/demo/
Author: someone
Version: 1.4
License: ${license}
License URI: https://www.gnu.org/licenses/gpl-2.0.html
${extra}
*/
.entry-title { color: #123456; background: url(img/bg.png); }
`;

function fakeWordPress({ slug = 'demo', css = style(), readme = '', files = {}, info = {} } = {}) {
  const zip = writeZip({
    [`${slug}/style.css`]: css,
    [`${slug}/index.php`]: '<?php',
    [`${slug}/functions.php`]: '<?php',
    [`${slug}/js/nav.js`]: '1',
    [`${slug}/img/bg.png`]: 'png',
    [`${slug}/theme.json`]: JSON.stringify({ settings: { color: { palette: [{ slug: 'primary', color: '#8a3b12' }, { slug: 'evil', color: 'url(http://x/y)' }] } } }),
    ...(readme ? { [`${slug}/readme.txt`]: readme } : {}),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${slug}/${k}`, v])),
  });
  const meta = { slug, name: 'Demo', version: '1.4', author: { user_nicename: 'someone' }, homepage: `https://wordpress.org/themes/${slug}/`, download_link: `https://downloads.wordpress.org/theme/${slug}.1.4.zip`, ...info };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('https://api.wordpress.org/')) return { ok: true, json: async () => meta };
    if (String(url) === meta.download_link) return { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    return { ok: false, status: 404 };
  };
  return { fetchImpl, seen };
}

const out = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wp-')), 'theme');
const run = (wp, dir) => importWordPressTheme('demo', dir, { fetchImpl: wp.fetchImpl, log: () => {} });
const refused = (code) => (e) => e.name === 'Refusal' && e.message.startsWith(code);

test('X6: a directory theme is ingested; source, licence, attribution and what was dropped are recorded', async () => {
  const dir = await out();
  await run(fakeWordPress(), dir);
  const m = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
  assert.equal(m.licence, 'GPL-2.0-or-later');
  assert.equal(m.class_contract, 'wordpress-classic');
  assert.equal(m.source, 'https://wordpress.org/themes/demo/');
  assert.match(m.attribution, /someone/);
  assert.deepEqual(m.assets, ['img/bg.png']);
  assert.deepEqual(m.dropped.php, ['functions.php', 'index.php']);
  assert.deepEqual(m.dropped.js, ['js/nav.js']);
  assert.deepEqual(m.tokens.colors, { primary: '#8a3b12' });
  assert.deepEqual(m.dropped.tokens, ['colors.evil']);
  assert.ok((await fs.stat(path.join(dir, 'LICENSE'))).size > 0);
  await assert.rejects(fs.stat(path.join(dir, 'index.php')));
});

test("X6: a theme's other front-end stylesheets are taken, with their assets; editor, rtl, plugin and bad files are not, and each is named", async () => {
  const dir = await out();
  await run(fakeWordPress({ files: {
    'assets/css/main.css': '.site-header{background:url(../img/hero.png);color:#111}',
    'assets/css/main.min.css': '.site-header{color:#111}',
    'assets/css/main-rtl.css': '.site-header{direction:rtl}',
    'assets/css/editor-style.css': '.editor{color:red}',
    'assets/css/woocommerce.css': '.woocommerce{color:red}',
    'assets/css/slider.css': '@import url(x.css);',
    'assets/css/ie.css': '.ie{color:red}',
    'assets/css/widgets.css': '.widget{background:url(https://evil.test/x.png)}',
    'assets/img/hero.png': 'png',
    'inc/admin/panel.css': '.panel{color:red}',
  } }), dir);
  const m = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
  assert.deepEqual(m.css, ['assets/css/main.min.css', 'style.css'], 'the minified copy of main.css, then style.css last');
  assert.deepEqual(m.assets, ['img/bg.png'], 'only what the taken files use');
  assert.ok(m.dropped.css.some((x) => x.startsWith('assets/css/slider.css (') && x.length > 30), 'a file that fails the rules is named with the reason');
  assert.ok(m.dropped.css.some((x) => x.startsWith('assets/css/widgets.css (') && /outside the theme/.test(x)));
  for (const left of ['assets/css/main-rtl.css', 'assets/css/editor-style.css', 'assets/css/woocommerce.css', 'assets/css/ie.css', 'inc/admin/panel.css', 'assets/css/main.css']) assert.ok(m.dropped.css.includes(left), `${left} is listed as dropped`);
  assert.ok((await fs.stat(path.join(dir, 'assets/css/main.min.css'))).size > 0);
  await assert.rejects(fs.stat(path.join(dir, 'assets/css/slider.css')));
});

const DEMO_HTML = `<html><head>
<link rel='stylesheet' id='demo-main' href='https://wp-themes.com/wp-content/themes/demo/assets/main.css?ver=1.4' media='all' />
<link rel='stylesheet' href='https://wp-themes.com/wp-content/themes/demo/style.css?ver=1.4'>
<link rel='stylesheet' href='https://wp-themes.com/wp-content/themes/demo/assets/late.css'>
<link rel='stylesheet' href='https://fonts.googleapis.com/css?family=Inter'>
<link rel='stylesheet' href='https://wp-themes.com/wp-content/plugins/other/x.css'>
<style id='demo-theme-css-inline-css'>:root{--demo-accent:#123456;--demo-font:Inter,sans-serif}.x{background:url(https://wp-themes.com/wp-content/themes/demo/img/bg.png)}@font-face{font-family:F;src:url(https://fonts.gstatic.com/f.woff2)}.y{background:url(https://elsewhere.test/u.png);color:#111}</style>
<style id='wp-block-library-inline-css'>.wp-block{color:red}</style>
<style id='global-styles-inline-css'>body{--wp--preset--color--primary:#8a3b12}</style>
<style id='core-block-supports-inline-css'>.wp-container-1{display:flex}</style>
</head></html>`;

test('X6: the demo page gives the stylesheets the theme enqueues, in order, and the CSS its PHP generates', () => {
  const d = parseDemo(DEMO_HTML, 'demo');
  assert.deepEqual(d.links, ['assets/main.css', 'style.css', 'assets/late.css'], "only this theme's own stylesheets, in page order");
  assert.deepEqual(d.inline.map((x) => x.id), ['demo-theme-css', 'global-styles'], "the theme's inline CSS and the global styles; not core block CSS");
});

test('X6: with the demo page, the theme takes its real stylesheets and generated CSS, and what points outside is removed', async () => {
  const wp = fakeWordPress({ files: { 'assets/main.css': '.a{color:#111}', 'assets/late.css': '.b{color:#222}', 'assets/unused.css': '.c{color:#333}', 'img/bg.png': 'png' } });
  const plain = wp.fetchImpl;
  wp.fetchImpl = async (url) => (String(url) === 'https://wp-themes.com/demo/' ? { ok: true, text: async () => DEMO_HTML } : plain(url));
  const dir = await out();
  await run(wp, dir);
  const m = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
  assert.deepEqual(m.css, ['assets/main.css', 'style.css', 'assets/late.css', 'wp-inline.css'], "the page's order, style.css where it sat, the generated CSS last");
  const inline = await fs.readFile(path.join(dir, 'wp-inline.css'), 'utf8');
  assert.match(inline, /--demo-accent:#123456/);
  assert.match(inline, /--wp--preset--color--primary/);
  assert.ok(!/fonts\.gstatic|elsewhere\.test|wp-themes\.com/.test(inline), 'web fonts and outside images are removed; the theme\'s own files become relative');
  assert.match(inline, /url\(img\/bg\.png\)|url\("img\/bg\.png"\)|url\('img\/bg\.png'\)/);
  assert.ok(m.assets.includes('img/bg.png'));
  assert.ok(!m.css.includes('assets/unused.css'), 'a stylesheet the theme does not enqueue is not taken');
});

test('X6: only wordpress.org directory themes, and only from wordpress.org hosts', async () => {
  for (const info of [{ homepage: 'https://evil.example/themes/demo/' }, { download_link: 'https://evil.example/demo.zip' }, { slug: 'other' }, { error: 'Theme not found' }]) {
    await assert.rejects(run(fakeWordPress({ info }), await out()), refused('not-in-directory'), JSON.stringify(info));
  }
});

test('X5: no declared licence, a non-GPL licence, or split-licensing language is refused', async () => {
  await assert.rejects(run(fakeWordPress({ css: style('', '') }), await out()), refused('no-licence'));
  await assert.rejects(run(fakeWordPress({ css: style('', 'Proprietary') }), await out()), refused('bad-licence'));
  await assert.rejects(run(fakeWordPress({ readme: 'The theme is GPL but the images are licensed separately under a commercial licence.' }), await out()), refused('bad-licence'));
  await assert.rejects(run(fakeWordPress({ css: style('Note: all assets are proprietary') }), await out()), refused('bad-licence'));
});

test('a stylesheet that loads from outside the theme, or from a missing file, is refused; nothing is written', async () => {
  for (const css of [style().replace('img/bg.png', 'https://cdn.example/x.png'), style().replace('img/bg.png', 'img/nope.png')]) {
    const dir = await out();
    await assert.rejects(run(fakeWordPress({ css }), dir), refused('bad-theme'));
    await assert.rejects(fs.stat(dir));
  }
});

test('a non-empty target folder is not overwritten', async () => {
  const dir = await out();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'keep.txt'), 'x');
  await assert.rejects(run(fakeWordPress(), dir), /not empty/);
});
