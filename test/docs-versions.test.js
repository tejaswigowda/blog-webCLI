import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateBlog } from '../lib/blog.js';
import { versionRootFiles } from '../lib/docs-versions.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { planChange } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';

const run = promisify(execFile);
const root = process.cwd();
const cli = path.join(root, 'cli/blog.js');
const versions = [{ path: 'v2', ref: 'main', label: '2.0', default: true }, { path: 'v1', ref: 'v1.0', label: '1.0' }];
const blog = { title: 'Docs', description: 'Docs site', author: 'A', domain: 'https://example.test/docs', search: true, pagePermalink: '/{slug}.html', versions };
const post = (body) => `---\nslug: intro\ntitle: Intro\ndate: 2026-01-01\nstatus: published\n---\n\n${body}\n`;

test('version configuration requires distinct safe prefixes and exactly one default', () => {
  assert.doesNotThrow(() => validateBlog(blog));
  for (const bad of [[], [versions[1]], [versions[0], versions[0]], [{ ...versions[0], path: '../bad' }], [{ ...versions[0], path: 'posts' }], [{ ...versions[0], ref: '--bad' }]]) {
    assert.throws(() => validateBlog({ ...blog, versions: bad }), (e) => e.code === 'bad-blog-json');
  }
});

test('CLI assembles the default ref and immutable historical refs', async () => {
  const dir = path.join(root, `.docs-versions-test-${process.pid}`);
  const site = path.join(dir, 'site');
  await fs.mkdir(path.join(site, 'posts'), { recursive: true });
  await fs.mkdir(path.join(site, 'pages'));
  const git = (...args) => run('git', args, { cwd: dir });
  const invoke = async (command) => {
    try { return { code: 0, ...(await run('node', [cli, command, site])) }; }
    catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  };
  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.test');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(site, 'blog.json'), JSON.stringify(blog));
    await fs.writeFile(path.join(site, 'posts/intro.md'), post('Old text.'));
    await fs.writeFile(path.join(site, 'pages/guide.md'), '---\nslug: guide\ntitle: Guide\nstatus: published\ncanonical: https://elsewhere.test/guide\n---\n\nOld guide.\n');
    await git('add', 'site');
    await git('commit', '-qm', 'old');
    await git('tag', 'v1.0');
    const sha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('branch', 'old-branch');
    await fs.writeFile(path.join(site, 'posts/intro.md'), post('Current text.'));
    await git('add', 'site/posts/intro.md');
    await git('commit', '-qm', 'current');
    await fs.writeFile(path.join(site, 'posts/intro.md'), post('Uncommitted text.'));
    const built = await invoke('build');
    assert.equal(built.code, 0, built.stderr);
    const get = (name) => fs.readFile(path.join(site, name), 'utf8');
    assert.match(await get('index.html'), /url=v2\//);
    assert.match(await get('v2/intro/index.html'), /Current text/);
    assert.doesNotMatch(await get('v2/intro/index.html'), /Uncommitted text/);
    const old = await get('v1/intro/index.html');
    assert.match(old, /Old text/);
    assert.match(old, /version-notice/);
    assert.match(old, /rel="canonical" href="https:\/\/example.test\/docs\/v1\/intro\/"/);
    assert.match(await get('v1/guide.html'), /rel="canonical" href="https:\/\/example.test\/docs\/v1\/guide.html"/);
    assert.doesNotMatch(old, /application\/atom\+xml/);
    assert.match(await get('v2/feed.xml'), /Current text/);
    await assert.rejects(get('v1/feed.xml'), { code: 'ENOENT' });
    await assert.rejects(get('v1/search.json'), { code: 'ENOENT' });
    assert.match(await get('v2/search.json'), /Current text/);
    assert.match(await get('sitemap.xml'), /\/v1\/sitemap.xml/);
    assert.match(await get('v1/sitemap.xml'), /\/v1\/intro\//);
    assert.equal((await invoke('check')).code, 0);
    await fs.writeFile(path.join(site, 'v1/feed.xml'), 'obsolete');
    await fs.mkdir(path.join(site, 'v1/search'), { recursive: true });
    await fs.writeFile(path.join(site, 'v1/search/data-0.json'), 'obsolete');
    assert.equal((await invoke('check')).code, 1);
    assert.equal((await invoke('build')).code, 0);
    await assert.rejects(get('v1/feed.xml'), { code: 'ENOENT' });
    await assert.rejects(get('v1/search/data-0.json'), { code: 'ENOENT' });
    await fs.writeFile(path.join(site, 'blog.json'), JSON.stringify({ ...blog, versions: [versions[0], { ...versions[1], ref: sha }] }));
    assert.equal((await invoke('build')).code, 0);
    await fs.writeFile(path.join(site, 'blog.json'), JSON.stringify({ ...blog, versions: [versions[0], { ...versions[1], ref: 'old-branch' }] }));
    const refused = await invoke('build');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /unpinned-ref/);
    assert.match(await get('v1/intro/index.html'), /Old text/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('editor publishes only the default prefix and leaves historical files alone', async () => {
  const server = fakeGitHub({ 'example/docs': {
    'blog.json': JSON.stringify(blog),
    'posts/intro.md': post('Current text.'),
    'v1/intro/index.html': 'old snapshot',
  } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const plan = await planChange(gh, { repo: 'example/docs', branch: 'main', slug: 'intro', text: post('New text.') });
  assert.ok(plan.changes.some((c) => c.path === 'v2/intro/index.html' && c.content.includes('New text.')));
  assert.ok(!plan.changes.some((c) => c.path.startsWith('v1/')));
  assert.ok(plan.changes.some((c) => c.path === 'index.html'));
});

test('root sitemap flattens split version sitemap indexes', () => {
  const files = versionRootFiles(blog, { v1: { 'v1/sitemap.xml': '', 'v1/sitemaps/site.xml': '', 'v1/sitemaps/2026.xml': '' } });
  assert.match(files['sitemap.xml'], /v1\/sitemaps\/site.xml/);
  assert.doesNotMatch(files['sitemap.xml'], /v1\/sitemap.xml/);
});
