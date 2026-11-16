import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { clearPackCache, loadPacks } from '../app/packs.js';
import { describePlan, executePlan, planChange, planLook, planSettings, planTheme, planThemeFile } from '../app/site.js';
import { loadBlog } from '../app/read.js';
import { blogToForm } from '../lib/settings.js';
import { buildSite } from '../lib/blog.js';
import { exportTheme } from '../lib/theme-export.js';
import { sha256 } from '../lib/sha256.js';
import { EX, readDirFiles } from './helpers.js';
import { fakeGitHub } from './fake-github.js';

const dec = new TextDecoder();
const code = (c) => (e) => {
  if (e.code === undefined) console.error(e);
  return e.code === c;
};

// A world with the example blog and two themes, none of them
// listed anywhere (there is no list in this world at all).
async function world({ theme = 'theme-plain', patch = {}, extra = {} } = {}) {
  clearPackCache();
  const blogFiles = await readDirFiles(path.join(EX, 'blog'));
  const themeFiles = await readDirFiles(path.join(EX, theme));
  const classic = await readDirFiles(path.join(EX, 'theme-classic'));
  const repos = {
    'example/blog': blogFiles,
    'me/theme': themeFiles,
    'me/classic': classic,
    'example/images': { 'README.md': 'i' },
    ...extra,
  };
  for (const [k, v] of Object.entries(patch)) repos[k] = v;
  const names = Object.keys(repos).filter((r) => r.startsWith('me/'));
  const server = fakeGitHub(repos, {
    tags: Object.fromEntries(names.map((r) => [r, ['v1.0.0']])),
    aliases: Object.fromEntries(names.map((r) => [r, { 'v1.0.0': 'main', [sha1]: 'main' }])),
  });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, net, gh: new GitHub(net, { token: 'github_pat_test' }), anon: new GitHub(net) };
}
const sha1 = 'e'.repeat(40);


// ---------- X9: a theme with no entry in any list works by its address ----------
test('X9: a theme is used by repository address; no list is involved, and the plan names its licence', async () => {
  const { server, net, gh } = await world();
  const plan = await planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } });
  assert.equal(net.ledger.uploaded.bytes, 0, 'planning uploads nothing');
  assert.deepEqual(plan.licences.map((l) => [l.kind, l.name, l.licence]), [['theme', 'Plain Paper', 'MIT']]);
  const paths = plan.changes.map((c) => c.path).sort();
  for (const p of ['blog.json', 'theme.css', 'index.html', 'licences.json', 'static-hls-in-git/index.html', 'markdown-is-the-format/index.html']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => p.startsWith('posts/')), 'posts are never touched');

  await executePlan(gh, plan);
  const after = server.files('example/blog');
  const blog = JSON.parse(after['blog.json']);
  assert.deepEqual(Object.keys(blog.theme).sort(), ['contract', 'licence', 'name', 'ref', 'repo', 'sha256', 'version']);
  assert.equal(blog.theme.ref, 'v1.0.0');
  assert.match(blog.theme.sha256, /^[0-9a-f]{64}$/);
  assert.ok(after['index.html'].includes('url("https://cdn.jsdelivr.net/gh/me/theme@v1.0.0/img/rule.svg")'));
  assert.equal(JSON.parse(after['licences.json']).dependencies[0].licence, 'MIT');

  // what a later reader or CI regenerates from this repository alone is exactly what was committed
  const posts = Object.entries(after).filter(([p]) => p.startsWith('posts/')).map(([p, t]) => ({ path: p, text: t }));
  const packs = await loadPacks(new GitHub(net), blog);
  const regen = buildSite({ blog: after['blog.json'], lock: JSON.parse(after['assets.lock.json']), posts, ...packs });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(after[p], c, p);
});

test('X9: stopping the theme removes theme.css and returns to the default theme', async () => {
  const { server, gh } = await world();
  await executePlan(gh, await planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }));
  assert.ok('theme.css' in server.files('example/blog'));
  const back = await planTheme(gh, { repo: 'example/blog', branch: 'main', use: null });
  assert.ok(back.changes.some((c) => c.delete && c.path === 'theme.css'));
  await executePlan(gh, back);
  const after = server.files('example/blog');
  assert.ok(!('theme.css' in after) && !('theme' in JSON.parse(after['blog.json'])));
  assert.ok(after['index.html'].includes('header.site{display:flex'));
});

test('classic theme: switching it on changes the markup of every page (X7 through the editor path)', async () => {
  const { server, gh } = await world();
  const plan = await planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/classic', ref: 'v1.0.0' } });
  assert.equal(plan.licences[0].licence, 'GPL-2.0-or-later');
  await executePlan(gh, plan);
  const after = server.files('example/blog');
  assert.ok(after['static-hls-in-git/index.html'].includes('class="entry-content"') && after['index.html'].includes('<body class="home blog">'));
  assert.equal(JSON.parse(after['blog.json']).theme.contract, 'wordpress-classic');
});

// ---------- X4 ----------
test('X4: a branch, an unknown tag, or an ambiguous name cannot be pinned', async () => {
  const { server, gh, net } = await world();
  const use = (ref) => planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref } });
  await assert.rejects(use('main'), (e) => e.code === 'unpinned-ref' && /is a branch/.test(e.detail));
  await assert.rejects(use('v9.9.9'), (e) => e.code === 'unpinned-ref' && /has no tag/.test(e.detail));
  await assert.rejects(use('latest'), code('unpinned-ref'));
  // a name that is both a tag and a branch means two things: refused
  server.state['me/theme'].branches['v1.0.0'] = server.state['me/theme'].branches.main;
  await assert.rejects(use('v1.0.0'), (e) => e.code === 'unpinned-ref' && /both a tag and a branch/.test(e.detail));
  delete server.state['me/theme'].branches['v1.0.0'];
  // a commit sha is always a valid pin
  const ok = await use(sha1);
  assert.equal(ok.licences[0].ref, sha1);
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('X4: a theme that changed after it was pinned refuses every later build', async () => {
  const { server, gh } = await world();
  await executePlan(gh, await planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }));
  const pinnedBlog = server.files('example/blog');
  // same blog.json, but the tag now serves different css
  const themeFiles = await readDirFiles(path.join(EX, 'theme-plain'));
  themeFiles['style.css'] = new TextEncoder().encode(dec.decode(themeFiles['style.css']) + '\nbody{background:red}');
  const { gh: gh2 } = await world({ patch: { 'example/blog': Object.fromEntries(Object.entries(pinnedBlog).map(([k, v]) => [k, new TextEncoder().encode(v)])), 'me/theme': themeFiles } });
  await assert.rejects(planSettings(gh2, { repo: 'example/blog', branch: 'main', form: blogToForm(JSON.parse(pinnedBlog['blog.json'])) }), (e) => e.code === 'pin-mismatch' && /changed after it was pinned/.test(e.detail));
  const text = Object.fromEntries(Object.entries(pinnedBlog).filter(([p]) => p.startsWith('posts/')));
  await assert.rejects(planChange(gh2, { repo: 'example/blog', branch: 'main', slug: 'markdown-is-the-format', text: text['posts/markdown-is-the-format.md'].replace('every tool', 'each tool') }), code('pin-mismatch'));
});

// ---------- X5 at the point of pinning ----------
test('X5: a theme with no licence cannot be pinned', async () => {
  const noLicence = async (dir, file) => {
    const files = await readDirFiles(path.join(EX, dir));
    const m = JSON.parse(dec.decode(files[file]));
    delete m.licence;
    files[file] = new TextEncoder().encode(JSON.stringify(m));
    return files;
  };
  const { gh } = await world({ patch: { 'me/theme': await noLicence('theme-plain', 'theme.json') } });
  await assert.rejects(planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }), code('no-licence'));
  const bad = await world({ patch: { 'me/theme': await (async () => { const f = await readDirFiles(path.join(EX, 'theme-plain')); f['theme.json'] = new TextEncoder().encode(dec.decode(f['theme.json']).replace('"MIT"', '"Proprietary"')); return f; })() } });
  await assert.rejects(planTheme(bad.gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }), code('bad-licence'));
});

// ---------- R7: a registry entry is a claim, never the pin ----------
test('R7: a registry sha256 or licence that disagrees with the repository pins nothing; the pin is what the app computes', async () => {
  const { gh } = await world();
  const base = { repo: 'example/blog', branch: 'main' };
  const use = (expect) => planTheme(gh, { ...base, use: { where: 'me/theme', ref: 'v1.0.0', expect } });
  await assert.rejects(use({ sha256: 'a'.repeat(64) }), code('registry-mismatch'));
  await assert.rejects(use({ licence: 'GPL-3.0-only' }), code('registry-mismatch'));
  const plain = await use(undefined);
  const real = JSON.parse(plain.changes.find((c) => c.path === 'blog.json').content).theme;
  const agreed = await use({ sha256: real.sha256, licence: real.licence });
  assert.deepEqual(JSON.parse(agreed.changes.find((c) => c.path === 'blog.json').content).theme, real);
});

// ---------- starting fresh with a theme ----------
test('starting fresh: choosing a theme can set aside the blog\'s own colours, fonts, width, list layout and CSS, and keeps what it says', async () => {
  const { server, gh } = await world();
  const blog = JSON.parse(server.files('example/blog')['blog.json']);
  assert.ok(blog.customize.colors && blog.customize.list && blog.customize.header && blog.customize.footer, 'the example blog has a look and content');
  const keep = await planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } });
  await executePlan(gh, keep);
  assert.deepEqual(JSON.parse(server.files('example/blog')['blog.json']).customize, blog.customize, 'without the option, nothing else changes');

  const { server: s2, gh: g2 } = await world();
  const plan = await planTheme(g2, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' }, fresh: true });
  assert.match(plan.changes.find((c) => c.path === 'blog.json').content, /"theme"/);
  await executePlan(g2, plan);
  const after = JSON.parse(s2.files('example/blog')['blog.json']);
  for (const k of ['colors', 'font', 'headingFont', 'width', 'fontSize', 'css', 'list']) assert.equal(after.customize?.[k], undefined, `${k} is cleared`);
  assert.deepEqual(after.customize.header, blog.customize.header, 'the header is kept');
  assert.deepEqual(after.customize.footer, blog.customize.footer, 'the footer is kept');
  assert.equal(after.title, blog.title);
  assert.ok(!s2.files('example/blog')['index.html'].includes('#0b7a5f'), "the blog's accent colour is no longer on the pages");
});

// ---------- matching an existing site (a measured look) ----------
test('a measured look replaces the blog\'s own look, keeps its header and footer, and is refused if it carries css or anything else', async () => {
  const { server, gh } = await world();
  const blog = JSON.parse(server.files('example/blog')['blog.json']);
  const look = { colors: { accent: '#1450c8', text: '#1e1e1e', background: '#faf8f0', muted: '#6e6e6e' }, font: 'serif', width: '640px', fontSize: '18px', list: { layout: 'list' } };
  await assert.rejects(planLook(gh, { repo: 'example/blog', branch: 'main', look: { ...look, css: 'a{background:url(https://e.com/x)}' } }), /never carries css/);
  await assert.rejects(planLook(gh, { repo: 'example/blog', branch: 'main', look: { ...look, header: { links: [] } } }), /not one/);
  assert.equal(JSON.parse(server.files('example/blog')['blog.json']).customize.colors.accent, blog.customize.colors.accent, 'a refused look changes nothing');
  const plan = await planLook(gh, { repo: 'example/blog', branch: 'main', look });
  assert.match(plan.message || plan.title || JSON.stringify(plan), /Match an existing site/);
  await executePlan(gh, plan);
  const after = JSON.parse(server.files('example/blog')['blog.json']);
  assert.deepEqual(after.customize.colors, look.colors);
  assert.equal(after.customize.font, 'serif');
  assert.equal(after.customize.css, undefined, 'no css came with it');
  assert.deepEqual(after.customize.header, blog.customize.header, 'the header is kept');
  assert.deepEqual(after.customize.footer, blog.customize.footer, 'the footer is kept');
  assert.equal(after.theme, blog.theme, 'the theme is untouched');
});

// ---------- the theme as a JSON file ----------
test('export a blog\'s theme as JSON, and import it into another blog: the pin is verified, the look applied, the logo kept', async () => {
  const { server, gh } = await world();
  // blog A: a theme and a look
  await executePlan(gh, await planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }));
  const a = JSON.parse(server.files('example/blog')['blog.json']);
  const file = exportTheme({ ...a, customize: { ...a.customize, css: '.x{color:red}', header: { ...(a.customize.header || {}), logo: 'asset:images/logo.png' } } }, { from: 'example/blog' });
  assert.equal(file.format, 'blog-webcli-theme');
  assert.equal(file.theme.sha256, a.theme.sha256);
  assert.equal(file.customize.header.logo, undefined, 'the logo is a picture of that blog');
  assert.equal(file.customize.css, '.x{color:red}');
  // blog B: another blog with its own logo and no theme
  const { server: s2, gh: g2 } = await world();
  const b = JSON.parse(s2.files('example/blog')['blog.json']);
  assert.equal(b.theme, 'default');
  const plan = await planThemeFile(g2, { repo: 'example/blog', branch: 'main', text: JSON.stringify(file) });
  await executePlan(g2, plan);
  const after = JSON.parse(s2.files('example/blog')['blog.json']);
  assert.equal(after.theme.sha256, a.theme.sha256);
  assert.equal(after.customize.css, '.x{color:red}');
  assert.deepEqual(after.customize.colors, file.customize.colors);
  assert.equal(after.title, b.title, 'nothing but the look changes');
  assert.match(s2.files('example/blog')['index.html'], /color:red/);
  // a pin that does not hash to what the file says is refused
  const lied = { ...file, theme: { ...file.theme, sha256: '0'.repeat(64) } };
  await assert.rejects(planThemeFile(g2, { repo: 'example/blog', branch: 'main', text: JSON.stringify(lied) }), code('registry-mismatch'));
  // a file with css the grammar refuses, or that is not a theme file, is refused before anything is read
  await assert.rejects(planThemeFile(g2, { repo: 'example/blog', branch: 'main', text: JSON.stringify({ ...file, customize: { css: '@import url(x.css);' } }) }), /css/i);
  await assert.rejects(planThemeFile(g2, { repo: 'example/blog', branch: 'main', text: '{"format":"other"}' }), /not a blog-webcli-theme file/);
});
