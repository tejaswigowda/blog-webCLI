import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provenanceFindings, permitsReuse } from '../lib/provenance.js';
import { cssFindings, processThemeCss, validateThemeManifest, wouldRefuse } from '../lib/theme-pack.js';
import { Refusal } from '../lib/errors.js';
import { declarationBlocks, declarationOverlap } from '../lib/overlap.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const enc = (t) => new TextEncoder().encode(t);
const GEN = { name: 'G', version: '1', licence: 'MIT', class_contract: 'wordpress-classic-2', css: ['style.css'], origin: 'generated', reference: 'https://example.com/', relation: 'inspired-by', agent: 'model 1', generated: '2026-11-08' };
const rules = (m) => provenanceFindings(m).map((f) => f.rule);

// ---------- G9: provenance ----------

test('a generated theme records its reference, relation, agent and date; each missing one is named by rule', () => {
  assert.deepEqual(rules(GEN), []);
  validateThemeManifest(GEN);
  for (const [k, rule] of [['reference', 'prov-reference'], ['relation', 'prov-relation'], ['agent', 'prov-agent'], ['generated', 'prov-generated']]) {
    const m = { ...GEN };
    delete m[k];
    assert.deepEqual(rules(m), [rule], k);
    assert.throws(() => validateThemeManifest(m), (e) => e instanceof Refusal && e.rule === rule);
  }
  assert.deepEqual(rules({ ...GEN, reference: 'http://example.com/' }), ['prov-reference']);
  assert.deepEqual(rules({ ...GEN, generated: '2026-02-30' }), ['prov-generated']);
  assert.deepEqual(rules({ ...GEN, origin: 'invented' }), ['prov-origin', 'prov-field-unexpected', 'prov-field-unexpected', 'prov-field-unexpected', 'prov-field-unexpected']);
});

test('the generated-only fields do not appear on an authored or imported theme; a theme from before the field is left alone', () => {
  const { reference, relation, agent, generated, ...authored } = GEN;
  assert.deepEqual(rules({ ...authored, origin: 'authored' }), []);
  assert.deepEqual(rules({ ...authored, origin: 'authored', agent: 'x' }), ['prov-field-unexpected']);
  assert.deepEqual(rules({ ...authored, origin: 'imported' }), ['prov-imported-source']);
  assert.deepEqual(rules({ ...authored, origin: 'imported', source: 'https://wordpress.org/themes/x/' }), []);
  const { origin, ...legacy } = authored;
  assert.deepEqual(rules({ ...legacy, assets: ['a.png'] }), []);
});

// ---------- G10: licences ----------

test('derived-from is refused unless the source declares a licence that permits reuse, and keeps its notice', () => {
  const d = { ...GEN, relation: 'derived-from' };
  assert.deepEqual(rules(d), ['prov-source-licence']);
  assert.deepEqual(rules({ ...d, source_licence: 'CC-BY-NC-4.0', attribution: 'x' }), ['prov-source-licence']);
  assert.deepEqual(rules({ ...d, source_licence: 'proprietary', attribution: 'x' }), ['prov-source-licence']);
  assert.deepEqual(rules({ ...d, source_licence: 'MIT' }), ['prov-attribution']);
  assert.deepEqual(rules({ ...d, source_licence: 'MIT', attribution: '© A, MIT' }), []);
  assert.deepEqual(rules({ ...d, source_licence: 'GPL-2.0-or-later', attribution: 'x' }), ['prov-licence-compat']);
  assert.deepEqual(rules({ ...d, source_licence: 'GPL-2.0-or-later', attribution: 'x', licence: 'GPL-2.0-or-later' }), []);
  assert.deepEqual(rules({ ...GEN, source_licence: 'MIT' }), ['prov-field-unexpected']);
  assert.ok(permitsReuse('MIT OR Apache-2.0') && permitsReuse('MIT AND ISC') && !permitsReuse('MIT AND CC-BY-NC-4.0') && !permitsReuse('LicenseRef-Custom'));
});

test('every asset of an authored or generated theme declares a licence that permits redistribution, or the theme is refused', () => {
  const t = { ...GEN, assets: ['fonts/a.woff2', 'img/b.png'] };
  assert.deepEqual(rules(t), ['asset-no-licence', 'asset-no-licence']);
  assert.deepEqual(rules({ ...t, asset_licences: { 'fonts/a.woff2': 'OFL-1.1' } }), ['asset-no-licence']);
  assert.deepEqual(rules({ ...t, asset_licences: { 'fonts/a.woff2': 'OFL-1.1', 'img/b.png': 'CC0-1.0' } }), []);
  assert.deepEqual(rules({ ...t, asset_licences: { 'fonts/a.woff2': 'OFL-1.1', 'img/b.png': 'LicenseRef-Unsplash' } }), []);
  assert.deepEqual(rules({ ...t, asset_licences: { 'fonts/a.woff2': 'OFL-1.1', 'img/b.png': 'CC-BY-NC-4.0' } }), ['asset-bad-licence']);
  assert.deepEqual(rules({ ...t, asset_licences: { 'fonts/a.woff2': 'OFL-1.1', 'img/b.png': 'proprietary' } }), ['asset-bad-licence']);
  assert.deepEqual(rules({ ...t, asset_licences: { 'fonts/a.woff2': 'OFL-1.1', 'img/b.png': 'MIT', 'ghost.png': 'MIT' } }), ['asset-licence-orphan']);
  assert.throws(() => validateThemeManifest(t), (e) => e.rule === 'asset-no-licence');
});

// ---------- G7: every refusal names its rule ----------

test('wouldRefuse lists every problem with its rule, where and what to do; a clean theme lists none', () => {
  const ok = { 'theme.json': enc(JSON.stringify(GEN)), 'style.css': enc('body{color:#111}') };
  assert.deepEqual(wouldRefuse(ok), []);
  const css = '@import url(x.css); a{background:url(https://e.com/a.png)} b{x:image-set(a)} c{x:expression(1)}';
  const got = wouldRefuse({ ...ok, 'style.css': enc(css) });
  const byRule = new Map(got.map((f) => [f.rule, f]));
  for (const r of ['css-import', 'css-foreign-url', 'css-undeclared-asset', 'css-image-function', 'css-script-hook']) assert.ok(byRule.has(r), r);
  for (const f of got) assert.ok(f.rule && f.where && f.reason && f.fix, JSON.stringify(f));
  assert.deepEqual(wouldRefuse({ 'style.css': enc('') }).map((f) => f.rule), ['manifest-missing']);
  assert.deepEqual(wouldRefuse({ 'theme.json': enc('{') }).map((f) => f.rule), ['manifest-json']);
  assert.deepEqual(wouldRefuse({ 'theme.json': enc(JSON.stringify(GEN)) }).map((f) => f.rule), ['file-missing']);
});

test('the loader refuses on the same rule wouldRefuse lists first, with the same words as before', () => {
  const assets = new Set(['a.png']);
  const pin = { repo: 'o/r', ref: 'v1.0.0' };
  for (const [css, rule, text] of [
    ['@import "x.css";', 'css-import', 'a.css uses @import, which is not allowed'],
    ['a{b:url(https://e.com/x)}', 'css-foreign-url', 'points outside the theme'],
    ['a{b:url(nope.png)}', 'css-undeclared-asset', 'names a file that theme.json does not list'],
    ['a{b:image-set(x)}', 'css-image-function', 'an image or resource function'],
    ['a{b:1} </style>', 'css-style-close', 'contains "</style"'],
  ]) {
    assert.equal(cssFindings(css, { file: 'a.css', assets })[0].rule, rule, css);
    assert.throws(() => processThemeCss(css, { file: 'a.css', assets, pin }), (e) => e instanceof Refusal && e.code === 'bad-theme' && e.rule === rule && e.message.includes(text), css);
  }
  assert.deepEqual(cssFindings('a{b:url(a.png)} c{d:url(data:image/png;base64,AAAA)}', { file: 'a.css', assets }), []);
  assert.deepEqual(new Refusal('bad-theme', 'why', 'a.css', 'css-import').toJSON(), { code: 'bad-theme', rule: 'css-import', where: 'a.css', reason: 'why' });
});

// ---------- G11: overlap is a signal ----------

test('overlap counts shared multi-declaration blocks, ignores short ones, and says it is a signal', () => {
  const ref = '.a{color:red;margin:0;padding:1px}.b{display:flex;gap:1rem;align-items:center}.c{margin:0}@media (min-width:1px){.d{font:12px/1 serif;color:blue;border:0}}';
  assert.equal(declarationBlocks(ref).size, 3); // `.c` has one declaration: too common to count
  const same = declarationOverlap('.x{padding:1px; color:RED; margin:0}.y{gap:1rem;align-items:center;display:flex}.z{font:12px/1 serif;color:blue;border:0}', ref);
  assert.equal(same.shared, 3);
  assert.equal(same.ratio, 1);
  assert.equal(same.warn, true);
  assert.match(same.note, /signal/);
  const other = declarationOverlap('.x{color:green;margin:2px;padding:3px}.y{display:grid;gap:2rem;place-items:center}', ref);
  assert.equal(other.shared, 0);
  assert.equal(other.warn, false);
  assert.match(other.note, /proves nothing/);
  assert.equal(declarationOverlap('', ref).ratio, 0);
});

// ---------- G8: the loop has no way to publish ----------

test('the theme checker and the sweep it uses have no GitHub, token, OAuth or deploy path', async () => {
  for (const f of ['cli/theme-check.mjs', 'cli/sweep-core.mjs']) {
    const src = await fs.readFile(path.join(root, f), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) assert.ok(!/github|oauth|deploy|release|registry|pin\.js|fetch-pack|app\//i.test(i), `${f} imports ${i}`);
    assert.ok(!/process\.env\.[A-Z_]*(TOKEN|SECRET|KEY)/.test(src), `${f} reads a credential`);
    assert.ok(!/api\.github\.com|git push|--method (POST|PUT)/i.test(src), `${f} talks to GitHub`);
  }
});

// ---------- M10: a photograph in a GPL theme is under its own licence, and licences.json says so ----------

import { licenceRecords, licenceComment, licencesJson } from '../lib/licences.js';

test('M10: a kit header picture must declare its own licence, for every origin', () => {
  const kit = { customize: { font: 'serif' }, home: 'Hi.', hero: { image: 'kit/hero.jpg', alt: 'A photograph', credit: { name: 'A', profile: 'https://unsplash.com/@a', source: 'https://unsplash.com/photos/x' } } };
  const imported = { name: 'W', version: '1', licence: 'GPL-2.0-or-later', class_contract: 'wordpress-classic', css: ['style.css'], assets: ['kit/hero.jpg'], source: 'https://wordpress.org/themes/w/', kit };
  assert.deepEqual(rules(imported), ['asset-no-licence']);
  assert.deepEqual(rules({ ...imported, asset_licences: { 'kit/hero.jpg': 'LicenseRef-Unsplash' } }), []);
  validateThemeManifest({ ...imported, asset_licences: { 'kit/hero.jpg': 'LicenseRef-Unsplash' } });
  assert.throws(() => validateThemeManifest(imported), (e) => e.rule === 'asset-no-licence');
});

test('M10: licences.json and the page comment name the photograph\'s licence apart from the theme\'s', () => {
  const blog = { title: 'B', author: 'A', theme: { name: 'W', version: '1', licence: 'GPL-2.0-or-later', repo: 'o/r', ref: 'v1.0.0', sha256: 'a'.repeat(64) } };
  const manifest = { class_contract: 'wordpress-classic', asset_licences: { 'kit/hero.jpg': 'LicenseRef-Unsplash', 'fonts/a.woff2': 'OFL-1.1' } };
  const [theme] = licenceRecords(blog, { theme: { manifest } });
  assert.equal(theme.licence, 'GPL-2.0-or-later');
  assert.deepEqual(theme.assets, [{ path: 'fonts/a.woff2', licence: 'OFL-1.1' }, { path: 'kit/hero.jpg', licence: 'LicenseRef-Unsplash' }]);
  assert.match(licenceComment(blog, { theme: { manifest } }), /GPL-2\.0-or-later.*plus OFL-1\.1 for fonts\/a\.woff2, LicenseRef-Unsplash for kit\/hero\.jpg/);
  assert.equal(JSON.parse(licencesJson(blog, { theme: { manifest } })).dependencies[0].assets.length, 2);
  assert.equal(licenceRecords(blog, { theme: { manifest: { class_contract: 'wordpress-classic' } } })[0].assets, undefined);
});
