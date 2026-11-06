import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { describePlan, executePlan, loadBlog, planSettings } from '../app/site.js';
import { buildSite, validateBlog } from '../lib/blog.js';
import { blogToForm, customizeFromForm, formToBlog, linksToText, parseLinks } from '../lib/settings.js';
import { fakeGitHub } from './fake-github.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
const exampleBlog = async () => JSON.parse(await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8'));
const lockOf = async () => JSON.parse(await fs.readFile(path.join(EXAMPLE, 'assets.lock.json'), 'utf8'));
const postsOf = async () => Promise.all(['static-hls-in-git', 'markdown-is-the-format'].map(async (s) => ({ path: `posts/${s}.md`, text: await fs.readFile(path.join(EXAMPLE, 'posts', `${s}.md`), 'utf8') })));
const refused = (fn) => assert.throws(fn, (e) => e.code === 'bad-blog-json');

test('links: "Label | url" per line, and back', () => {
  assert.deepEqual(parseLinks('About | https://a.b/c\n\n  Mail | mailto:me@x.y  \n', 'Header links'), [{ label: 'About', url: 'https://a.b/c' }, { label: 'Mail', url: 'mailto:me@x.y' }]);
  assert.equal(linksToText(parseLinks('A | https://a.b', 'x')), 'A | https://a.b');
  assert.throws(() => parseLinks('A https://a.b', 'Header links'), (e) => e.code === 'bad-blog-json' && /Header links line 1/.test(e.detail));
  assert.deepEqual(parseLinks('Pipes | https://a.b/?x=1|2', 'x'), [{ label: 'Pipes', url: 'https://a.b/?x=1|2' }], 'only the first | separates');
});

test('form <-> blog.json: the example round-trips to the same site', async () => {
  const base = await exampleBlog();
  const next = formToBlog(base, blogToForm(base));
  const run = async (b) => buildSite({ blog: JSON.stringify(b), lock: await lockOf(), posts: await postsOf() }).files;
  assert.deepEqual(await run(next), await run(base));
  assert.deepEqual(Object.keys(next).sort(), Object.keys(base).sort());
  assert.doesNotThrow(() => validateBlog(next));
});

test('form -> blog.json: only differences from the defaults are written; blank removes', async () => {
  const f = { ...blogToForm(await exampleBlog()) };
  f.layout = 'cards';
  f.tags = false;
  f.color_accent = '';
  f.dark_accent = '';
  f.width = '';
  f.headerLinks = '';
  f.footerLinks = '';
  f.footerText = '';
  const c = customizeFromForm(f);
  assert.deepEqual(c, { list: { layout: 'cards', tags: false } });
  f.layout = 'list';
  f.tags = true;
  assert.equal(customizeFromForm(f), null, 'nothing set means no customize section');
  const bare = formToBlog(await exampleBlog(), f);
  assert.ok(!('customize' in bare));
});

test('form -> blog.json: unknown keys survive; repos are added and removed with their sections', async () => {
  const base = { title: 'T', description: 'D', author: 'A', domain: 'https://x.github.io/t', repo: 'me/t', theme: 'default', cover: 'asset:images/c.png', note: { keep: 1 } };
  const f = blogToForm(base);
  assert.equal(f.images, '');
  Object.assign(f, { title: ' New title ', images: 'me/pics/web', video: 'me/clips', audio: 'me/aud' });
  const a = formToBlog(base, f);
  assert.equal(a.title, 'New title');
  assert.deepEqual(a.note, { keep: 1 });
  assert.equal(a.cover, 'asset:images/c.png');
  assert.deepEqual(a.assets.repos, { images: 'me/pics/web', audio: 'me/aud' });
  assert.match(a.assets.base, /\{sha\}.*\{path\}/);
  assert.deepEqual(a.video.repos, { videos: 'me/clips' });
  assert.equal(a.video.player, 'https://strataeditor.dev/player/');
  assert.doesNotThrow(() => validateBlog(a));
  assert.deepEqual(base.cover && Object.keys(base).includes('assets'), false, 'the input is not modified');

  const g = blogToForm(a);
  Object.assign(g, { images: '', audio: '', video: '' });
  const b = formToBlog(a, g);
  assert.ok(!('assets' in b) && !('video' in b));
  // a blog whose only video key is not "videos" keeps that key
  const clips = formToBlog({ ...base, video: { player: 'https://p.example/', base: 'https://c.example/{owner}/{repo}@{tag}/{slug}/', repos: { clips: 'me/old' } } }, { ...f, video: 'me/new' });
  assert.deepEqual(clips.video.repos, { clips: 'me/new' });
});

test('form -> blog.json: invalid values are refused by the same validator as blog.json', async () => {
  const base = await exampleBlog();
  const bad = (patch) => refused(() => validateBlog(formToBlog(base, { ...blogToForm(base), ...patch })));
  bad({ color_accent: 'blue' });
  bad({ width: '3rem' });
  bad({ font: 'Comic Sans' });
  bad({ css: 'a{background:url(x)}' });
  bad({ headerLinks: 'Bad | javascript:alert(1)' });
  bad({ logo: 'https://x.example/l.png' });
  bad({ title: '' });
  bad({ images: 'not a repo' });
  assert.throws(() => formToBlog(base, { ...blogToForm(base), footerLinks: 'no separator' }), (e) => e.code === 'bad-blog-json');
});

// ---- committing a settings change ----
async function world(extra = {}) {
  const files = {};
  const walk = async (dir, base = dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, base);
      else files[path.relative(base, p)] = await fs.readFile(p);
    }
  };
  await walk(EXAMPLE);
  const server = fakeGitHub({ 'example/blog': { ...files, ...extra }, 'example/images': { 'README.md': 'i', 'logo.png': 'PNG' } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, net, gh: new GitHub(net, { token: 'github_pat_test' }) };
}

test('settings: a change regenerates every page from the new blog.json, in one commit', async () => {
  const { server, net, gh } = await world();
  const ctx = await loadBlog(gh, 'example/blog');
  const form = { ...blogToForm(ctx.blog), color_accent: '#aa2200', footerText: 'New footer', layout: 'cards' };
  const plan = await planSettings(gh, { repo: 'example/blog', branch: 'main', form });
  assert.equal(net.ledger.uploaded.bytes, 0, 'planning uploads nothing');
  const paths = plan.changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ['blog.json', 'index.html', 'markdown-is-the-format/index.html', 'static-hls-in-git/index.html']);
  assert.ok(!paths.some((p) => p.startsWith('posts/')), 'posts are never touched by a settings change');
  assert.match(describePlan(plan)[0], /^4 files, [\d.]+ KB, to github\.com\/example\/blog \(main\)$/);

  const receipt = await executePlan(gh, plan);
  assert.equal(server.state['example/blog'].commits[receipt.commits[0].sha].msg, 'Update blog settings');
  const after = server.files('example/blog');
  assert.equal(JSON.parse(after['blog.json']).customize.colors.accent, '#aa2200');
  for (const p of ['index.html', 'static-hls-in-git/index.html']) assert.ok(after[p].includes('--link:#aa2200') && after[p].includes('New footer'), p);
  assert.ok(after['index.html'].includes('<ul class="posts cards">'));
  // CI would regenerate exactly this (gate B8)
  const regen = buildSite({ blog: after['blog.json'], lock: JSON.parse(after['assets.lock.json']), posts: Object.entries(after).filter(([p]) => p.startsWith('posts/')).map(([path, text]) => ({ path, text })) });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(after[p], c, p);

  // submitting the same settings again changes nothing
  const again = await planSettings(gh, { repo: 'example/blog', branch: 'main', form });
  assert.equal(again.unchanged, true);
  assert.equal(again.changes.length, 0);
});

test('settings: a header logo is pinned to its file; one that does not exist is refused before any write', async () => {
  const { server, net, gh } = await world();
  const ctx = await loadBlog(gh, 'example/blog');
  const base = blogToForm(ctx.blog);
  const plan = await planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...base, logo: 'asset:images/logo.png', showTitle: false } });
  const lock = JSON.parse(plan.changes.find((c) => c.path === 'assets.lock.json').content);
  assert.equal(lock['images/logo.png'], server.state['example/images'].branches.main);
  assert.ok(plan.changes.find((c) => c.path === 'index.html').content.includes(`images@${server.state['example/images'].branches.main}/logo.png`));
  await assert.rejects(planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...base, logo: 'asset:images/ghost.png' } }), (e) => e.code === 'unresolved-asset');
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('settings: invalid input is refused, and a post that cannot be published blocks the change', async () => {
  const { gh } = await world({ 'posts/broken.md': '---\nslug: broken\ntitle: B\ndate: 2026-01-01\nstatus: published\n---\n\nwrapped\nline\n' });
  const ctx = { blog: await exampleBlog() };
  const form = blogToForm(ctx.blog);
  await assert.rejects(planSettings(gh, { repo: 'example/blog', branch: 'main', form: { ...form, color_accent: 'red' } }), (e) => e.code === 'bad-blog-json');
  await assert.rejects(planSettings(gh, { repo: 'example/blog', branch: 'main', form }), (e) => e.code === 'lossy-round-trip');
});

test('settings: in a folder, only the folder changes; and there must be a blog.json', async () => {
  const files = { 'README.md': 'x', 'blog/blog.json': JSON.stringify({ title: 'T', description: 'D', author: 'A', domain: 'https://me.github.io/s/blog' }), 'blog/posts/hello.md': '---\nslug: hello\ntitle: P\ndate: 2026-01-01\nstatus: published\n---\n\nHello.\n' };
  const server = fakeGitHub({ 'me/s': files });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const form = { ...blogToForm({ title: 'T', description: 'D', author: 'A', domain: 'https://me.github.io/s/blog' }), footerText: 'hi' };
  const plan = await planSettings(gh, { repo: 'me/s/blog', branch: 'main', form });
  assert.ok(plan.changes.every((c) => c.path.startsWith('blog/')));
  assert.match(describePlan(plan)[0], /in blog\/$/);
  await executePlan(gh, plan);
  assert.equal(server.files('me/s')['README.md'], 'x');
  assert.ok(server.files('me/s')['blog/hello/index.html'].includes('hi'));
  await assert.rejects(planSettings(gh, { repo: 'me/s', branch: 'main', form }), (e) => e.code === 'no-blog-json');
});
