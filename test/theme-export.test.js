import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME_FILE_FORMAT, applyThemeFile, exportTheme, parseThemeFile } from '../lib/theme-export.js';

const PIN = { repo: 'o/r/essay', ref: 'v1.6.0', sha256: 'a'.repeat(64), name: 'Essay', version: '1.0.0', licence: 'MIT', contract: 'blog-webcli-v1' };
const BLOG = { title: 'T', description: 'd', author: 'A', domain: 'https://x.test', stylesheet: 'linked', theme: PIN,
  customize: { colors: { accent: '#159e63' }, font: 'sans', css: '.a{color:red}', list: { layout: 'cards' }, header: { logo: 'asset:images/logo.png', links: [{ label: 'X', url: 'https://x.test', icon: 'asset:images/x.png' }] }, footer: { text: 'hi' } } };

test('export: the pin, the whole customize block, the stylesheet mode; the pictures of the source blog are left out', () => {
  const f = exportTheme(BLOG, { from: 'o/blog', now: new Date('2026-11-08T12:00:00Z') });
  assert.equal(f.format, THEME_FILE_FORMAT);
  assert.equal(f.exported, '2026-11-08');
  assert.deepEqual(f.theme, PIN);
  assert.equal(f.stylesheet, 'linked');
  assert.equal(f.customize.css, '.a{color:red}');
  assert.equal(f.customize.header.logo, undefined);
  assert.deepEqual(f.customize.header.links, [{ label: 'X', url: 'https://x.test' }]);
  assert.equal(f.customize.footer.text, 'hi');
  assert.equal(exportTheme({ title: 'T' }).theme, null);
  assert.equal(exportTheme({ title: 'T', theme: 'default' }).theme, 'default');
  assert.equal(exportTheme({ title: 'T' }).customize, null);
});

test('parse: a round trip, and every refusal says what is wrong', () => {
  const f = parseThemeFile(JSON.stringify(exportTheme(BLOG)));
  assert.deepEqual(f.theme, PIN);
  assert.equal(f.stylesheet, 'linked');
  assert.equal(f.customize.font, 'sans');
  const bad = (o, re) => assert.throws(() => parseThemeFile(typeof o === 'string' ? o : JSON.stringify(o)), re);
  bad('not json', /not JSON/);
  bad({ format: 'x' }, /not a blog-webcli-theme file/);
  bad({ format: THEME_FILE_FORMAT, version: 2 }, /version 2/);
  bad({ format: THEME_FILE_FORMAT, version: 1, extra: 1 }, /"extra" is not a field/);
  bad({ format: THEME_FILE_FORMAT, version: 1, theme: { ...PIN, ref: 'main' } }, /not a release tag/);
  bad({ format: THEME_FILE_FORMAT, version: 1, theme: { ...PIN, sha256: 'xyz' } }, /64 hex/);
  bad({ format: THEME_FILE_FORMAT, version: 1, theme: { ...PIN, evil: 1 } }, /theme\.evil/);
  bad({ format: THEME_FILE_FORMAT, version: 1, theme: null, customize: { css: '@import url(x.css);' } }, /css/);
  bad({ format: THEME_FILE_FORMAT, version: 1, theme: null, customize: { font: 'comic' } }, /font/);
  bad({ format: THEME_FILE_FORMAT, version: 1, theme: null, stylesheet: 'inline' }, /linked/);
  bad('x'.repeat(200_001), /over 200 KB/);
  // pictures smuggled in the file are dropped, not trusted
  const smuggled = parseThemeFile(JSON.stringify({ format: THEME_FILE_FORMAT, version: 1, theme: null, customize: { header: { logo: 'asset:images/evil.png' } } }));
  assert.equal(smuggled.customize, null);
});

test('apply: the file\'s look and pin replace the blog\'s, and the blog keeps its own logo and everything else', () => {
  const file = parseThemeFile(JSON.stringify(exportTheme({ ...BLOG, customize: { colors: { accent: '#000000' }, css: '.b{margin:0}' } })));
  const target = { title: 'Other', description: 'x', author: 'B', domain: 'https://y.test', customize: { font: 'serif', header: { logo: 'asset:images/mine.png' } } };
  const out = applyThemeFile(target, file, file.theme);
  assert.deepEqual(out.theme, PIN);
  assert.equal(out.stylesheet, 'linked');
  assert.deepEqual(out.customize, { colors: { accent: '#000000' }, css: '.b{margin:0}', header: { logo: 'asset:images/mine.png' } });
  assert.equal(out.title, 'Other');
  assert.deepEqual(target.customize.font, 'serif', 'the blog it was applied to is not modified');
  const plain = applyThemeFile({ ...target, theme: PIN }, parseThemeFile(JSON.stringify(exportTheme({ title: 'z' }))), null);
  assert.equal(plain.theme, undefined, 'a file with no theme returns the blog to the default');
});
