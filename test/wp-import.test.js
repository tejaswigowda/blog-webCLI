// X5 / X6: WordPress ingestion takes directory themes only, refuses on licence, records what was dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importWordPressTheme } from '../cli/wp-import.js';
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
