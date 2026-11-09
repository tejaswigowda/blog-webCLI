import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEASURED_FIELDS, MEASURE_UA, assertMeasured, customizeFromMeasure, fontKey, lookFromText, robotsAllows } from '../lib/measure.js';
import { FONTS } from '../lib/customize.js';
import { validateThemeManifest } from '../lib/theme-pack.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = { bg: { r: 250, g: 248, b: 240 }, text: { r: 30, g: 30, b: 30 }, link: { r: 20, g: 80, b: 200 }, muted: { r: 110, g: 110, b: 110 }, font: 'Georgia, serif', headingFont: '"Playfair Display", serif', size: 18, width: 640, cards: false };

// ---------- M5: only the enumerable fields, never css ----------

test('M5: a measurement writes only the enumerable customize fields, never css', () => {
  const c = customizeFromMeasure(M);
  for (const k of Object.keys(c)) assert.ok(MEASURED_FIELDS.includes(k), k);
  assert.ok(!('css' in c));
  assert.deepEqual(c.colors, { accent: '#1450c8', text: '#1e1e1e', background: '#faf8f0', muted: '#6e6e6e' });
  // whatever the page measured to, and however odd, the result has no css and no content field
  for (const odd of [{}, { font: 'x', width: 1e9, size: 99, cards: true }, { bg: { r: 0, g: 0, b: 0 }, text: { r: 0, g: 0, b: 0 } }, { font: '"; } body { background: url(https://e.com/x) } /*' }]) {
    const out = customizeFromMeasure(odd);
    assert.deepEqual(Object.keys(out).filter((k) => !MEASURED_FIELDS.includes(k)), []);
    assert.ok(!('css' in out) && !('topbar' in out) && !('header' in out) && !('footer' in out));
  }
});

test('M5: assertMeasured and lookFromText refuse css and every field a measurement cannot write', () => {
  assert.throws(() => assertMeasured({ font: 'sans', css: 'a{b:c}' }), /never carries css/);
  assert.throws(() => assertMeasured({ topbar: { text: 'x' } }), /not one/);
  assert.throws(() => assertMeasured({ header: { links: [] } }), /not one/);
  assert.throws(() => assertMeasured({ font: 'comic' }));
  assert.throws(() => lookFromText('not json'), /not JSON/);
  assert.throws(() => lookFromText(JSON.stringify({ customize: { css: 'a{}' } })), /css/);
  assert.deepEqual(lookFromText(JSON.stringify({ font: 'serif', width: '640px' })), { font: 'serif', width: '640px' });
  assert.deepEqual(lookFromText(JSON.stringify({ customize: { font: 'mono' } })), { font: 'mono' });
});

test('M5: a theme kit is a measurement too: no css in kit.customize', () => {
  const m = { name: 'T', version: '1', licence: 'MIT', class_contract: 'blog-webcli-v1', css: ['style.css'], kit: { customize: { font: 'serif' }, home: 'Hi.' } };
  validateThemeManifest(m);
  assert.throws(() => validateThemeManifest({ ...m, kit: { customize: { font: 'serif', css: 'a{}' } } }), (e) => e.rule === 'kit-css');
});

// ---------- M6: the measuring path does not read stylesheets, fonts or text ----------

test('M6: nothing in the measuring path reads a stylesheet, a font file or the page text', async () => {
  for (const f of ['lib/measure.js', 'cli/measure.mjs']) {
    const src = (await fs.readFile(path.join(root, f), 'utf8')).replace(/\/\/.*$/gm, '');
    for (const bad of ['styleSheets', 'cssRules', 'cssText', 'getMatchedStyles', 'CSS.getStyleSheet', 'font-face', 'woff', 'rel="stylesheet"', 'textContent', 'innerText', 'innerHTML', 'outerHTML', 'writeFile(\'style', 'DOM.getOuterHTML', 'Page.getResourceContent']) assert.ok(!src.includes(bad), `${f} mentions ${bad}`);
  }
  assert.ok(!/from '\.\.\/lib\/(wp-|theme-pack)/.test(await fs.readFile(path.join(root, 'cli/measure.mjs'), 'utf8')), 'the measuring tool does not use the importer');
});

// ---------- M7: typefaces fall into the five stacks ----------

test('M7: a measured typeface is classified into one of the five stacks', () => {
  for (const [family, key] of [['Georgia, serif', 'serif'], ['"Playfair Display", serif', 'serif'], ['Inter, sans-serif', 'sans'], ['"Roboto Slab", serif', 'slab'], ['"Fira Code", monospace', 'mono'], ['"Source Sans Pro", sans-serif', 'humanist'], ['Brandon Grotesque', 'sans'], ['', 'sans']]) {
    assert.equal(fontKey(family), key, family);
    assert.ok(fontKey(family) in FONTS);
  }
  assert.equal(Object.keys(FONTS).length, 5);
  assert.equal(customizeFromMeasure({ ...M, font: 'Brandon Grotesque', headingFont: 'Brandon Grotesque' }).font, 'sans');
});

test('M7: the README and the tool say the typeface will not match', async () => {
  assert.match(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /typeface (will|does) not match/i);
  assert.match(await fs.readFile(path.join(root, 'cli/measure.mjs'), 'utf8'), /will not match/);
});

// ---------- M8, M9: the rule is written down; robots.txt and an identity ----------

test('M8: the measure/extract rule is written in the repository, in the code and in the docs', async () => {
  const docs = await fs.readFile(path.join(root, 'docs/theming-rules.md'), 'utf8');
  for (const w of ['Measuring', 'Extracting', 'directory-only', 'customize', 'css']) assert.ok(docs.includes(w), w);
  assert.match(await fs.readFile(path.join(root, 'lib/measure.js'), 'utf8'), /THE RULE/);
});

test('M9: robots.txt is obeyed (RFC 9309) and the tool identifies itself', async () => {
  assert.match(MEASURE_UA, /blog-webcli-measure\/\d.*github\.com\/tejaswigowda\/blog-webCLI/);
  assert.equal(robotsAllows('', '/'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/page'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private/\n', '/blog/'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private/\n', '/private/x'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /public/', '/public/a'), true); // the longest rule wins
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: blog-webcli-measure\nAllow: /', '/x'), true); // our group over *
  assert.equal(robotsAllows('User-agent: blog-webcli-measure\nDisallow: /', '/x'), false);
  assert.equal(robotsAllows('User-agent: googlebot\nDisallow: /', '/x'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$', '/a.pdf'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow:', '/x'), true); // an empty Disallow allows everything
  const src = await fs.readFile(path.join(root, 'cli/measure.mjs'), 'utf8');
  assert.ok(src.includes('robots.txt') && src.includes('MEASURE_UA') && src.includes('setUserAgentOverride'));
});
