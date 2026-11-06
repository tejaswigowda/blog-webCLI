import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNet } from '../app/net.js';
import { GitHub, assertToken } from '../app/github.js';
import { listVideoReleases, loadBlog, loadIndex, loadPost, planChange, executePlan, describePlan, NotFound } from '../app/site.js';
import { buildSite } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';
import { fakeGitHub } from './fake-github.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
async function walk(dir, base = dir) {
  const out = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await walk(p, base));
    else out[path.relative(base, p)] = await fs.readFile(p);
  }
  return out;
}
const dec = new TextDecoder();

async function world() {
  const blogFiles = await walk(EXAMPLE);
  const server = fakeGitHub({ 'example/blog': blogFiles, 'example/images': { 'README.md': 'images', 'new.png': 'PNGDATA' }, 'example/audio': { 'README.md': 'audio' }, 'example/renders': { 'hls-demo/render.json': '{}' } }, { tags: { 'example/renders': ['hls-demo/v1', 'hls-demo/v2', 'a+b-cubed/v1', 'not-a-release', 'Bad_Name/v1'] } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, net, anon: new GitHub(net), authed: new GitHub(net, { token: 'github_pat_test' }) };
}

const NEW_POST = (extra = '', status = 'published', body = 'Fresh words about nothing.') =>
  `---\nslug: fresh-post\ntitle: Fresh post\ndate: 2026-11-07\ntags: [new]\nstatus: ${status}\n${extra}---\n\n${body}\n`;

test('B11: ledger reads zero uploaded after a full render-and-browse session', async () => {
  const { net, anon } = await world();
  const ctx = await loadBlog(anon, 'example/blog');
  const index = await loadIndex(anon, 'example/blog');
  assert.equal(index.length, 2);
  for (const e of index) {
    const { html } = await loadPost(anon, 'example/blog', e.slug, undefined, ctx);
    assert.ok(html.includes('<p>'));
    if (e.slug === 'static-hls-in-git') assert.ok(html.includes('<iframe src="https://strataeditor.dev/player/#'), 'the video is in the rendered post');
  }
  await assert.rejects(loadPost(anon, 'example/blog', 'unfinished-thoughts', undefined, ctx), NotFound, 'drafts are not readable anonymously');
  await assert.rejects(loadPost(anon, 'example/blog', '../blog.json', undefined, ctx), NotFound, 'slugs cannot traverse paths');
  assert.equal(net.ledger.uploaded.bytes, 0);
  assert.equal(net.ledger.uploaded.requests, 0);
  assert.ok(net.ledger.read.bytes > 1000 && net.ledger.read.requests >= 5);
  assert.ok(net.ledger.log.every((l) => l.method === 'GET' && l.up === 0));
});

test('reader falls back to listing posts/ when there is no generated index', async () => {
  const { server } = await world();
  const files = server.files('example/blog');
  const bare = fakeGitHub({ 'me/bare': { 'blog.json': files['blog.json'], 'posts/a.md': files['posts/markdown-is-the-format.md'].replace('markdown-is-the-format', 'a'), 'posts/d.md': files['posts/unfinished-thoughts.md'].replace('unfinished-thoughts', 'd') } });
  await bare.ready;
  const gh = new GitHub(createNet(bare.fetch), { token: 'github_pat_x' });
  const index = await loadIndex(gh, 'me/bare');
  assert.deepEqual(index.map((e) => e.slug), ['a']);
});

test('reader refuses a repo with no blog.json', async () => {
  const { anon } = await world();
  await assert.rejects(loadBlog(anon, 'example/images'), (e) => e instanceof Refusal && e.code === 'no-blog-json');
});

test('a token without write access gets a message that names the request, permission and repository', async () => {
  const refuse = (url, init) => Promise.resolve(new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }));
  const gh = new GitHub(createNet(refuse), { token: 'github_pat_x' });
  await assert.rejects(gh.api('POST', '/repos/me/blogtest/git/trees', { tree: [] }), (e) => {
    assert.equal(e.status, 403);
    assert.match(e.message, /POST \/repos\/me\/blogtest\/git\/trees/);
    assert.match(e.message, /"Contents: Read and write" on me\/blogtest/);
    return true;
  });
  await assert.rejects(gh.api('POST', '/repos/me/blogtest/pulls', {}), /"Pull requests: Read and write"/);
  await assert.rejects(gh.api('GET', '/repos/me/blogtest/git/trees/abc?recursive=1'), /"Contents: Read-only"/);
  // other 403s (rate limits, say) are not dressed up as permission problems
  const limited = new GitHub(createNet(() => Promise.resolve(new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 }))), { token: 'github_pat_x' });
  await assert.rejects(limited.api('GET', '/repos/me/x'), (e) => !/needs "/.test(e.message));
});

test('a branch that moved gives an explanation, and requests are never served from the HTTP cache', async () => {
  const seen = [];
  const moved = (url, init) => {
    seen.push(init.cache);
    return Promise.resolve(new Response(JSON.stringify({ message: 'Update is not a fast forward' }), { status: 422 }));
  };
  const gh = new GitHub(createNet(moved), { token: 'github_pat_x' });
  await assert.rejects(gh.api('PATCH', '/repos/me/b/git/refs/heads/main', { sha: 'x' }), /Reload the page and publish again/);
  await gh.api('GET', '/repos/me/b/commits/main').catch(() => {});
  assert.deepEqual(seen, ['no-store', 'no-store'], 'GitHub caches branch heads for 60s; a stale head makes the next commit a non-fast-forward');
});

test('classic tokens are refused; fine-grained ones accepted', () => {
  assert.throws(() => assertToken('ghp_' + 'a'.repeat(36)), (e) => e.code === 'classic-token');
  assert.doesNotThrow(() => assertToken('github_pat_' + 'a'.repeat(40)));
});

test('publish: pre-flight is concrete, one commit, and matches what the CLI would generate', async () => {
  const { server, net, authed } = await world();
  const plan = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST() });
  assert.equal(net.ledger.uploaded.bytes, 0, 'planning uploads nothing');

  const lines = describePlan(plan);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d+ files?, [\d.]+ (B|KB|MB), to github\.com\/example\/blog \(main\)$/);
  const paths = plan.changes.map((c) => c.path).sort();
  // the new post is the newest, so the page that was newest gains a neighbour (its previous link)
  assert.deepEqual(paths, ['feed.xml', 'fresh-post/index.html', 'index.html', 'index/posts.json', 'posts/fresh-post.md', 'static-hls-in-git/index.html']);

  const receipt = await executePlan(authed, plan);
  assert.equal(receipt.commits.length, 1);
  assert.match(receipt.commits[0].url, /^https:\/\/github\.com\/example\/blog\/commit\/[0-9a-f]{40}$/);
  assert.ok(net.ledger.uploaded.bytes >= plan.changes.reduce((n, c) => n + c.size, 0));

  const after = server.files('example/blog');
  assert.ok(after['fresh-post/index.html'].includes('Fresh words about nothing.'));
  assert.ok(JSON.parse(after['index/posts.json']).posts.some((p) => p.slug === 'fresh-post'));
  assert.ok(!after['posts/fresh-post.md'].includes('"ops"'), 'markdown, never Delta');

  // The browser-produced output is exactly what the CI check regenerates.
  const posts = Object.entries(after).filter(([p]) => p.startsWith('posts/')).map(([p, t]) => ({ path: p, text: t }));
  const regen = buildSite({ blog: after['blog.json'], posts, lock: JSON.parse(after['assets.lock.json']) });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(after[p], c, `${p} differs from a fresh regeneration`);

  // A second publish of the same text changes nothing.
  const again = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST() });
  assert.equal(again.changes.length, 0);
});

test('publish: moving a post to draft removes its page, index entry and feed entry', async () => {
  const { server, authed } = await world();
  const slug = 'markdown-is-the-format';
  const text = server.files('example/blog')[`posts/${slug}.md`].replace('status: published', 'status: draft');
  const plan = await planChange(authed, { repo: 'example/blog', branch: 'main', slug, text });
  assert.ok(plan.changes.some((c) => c.delete && c.path === `${slug}/index.html`));
  await executePlan(authed, plan);
  const after = server.files('example/blog');
  assert.ok(!(`${slug}/index.html` in after));
  assert.ok(!after['feed.xml'].includes(slug) && !after['index/posts.json'].includes(slug) && !after['index.html'].includes(slug));
});

test('publish: staged image uploads to its own repo and is pinned to that commit', async () => {
  const { server, net, authed } = await world();
  const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  const text = NEW_POST('cover: asset:images/fresh-cover.png\n');
  const plan = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text, staged: [{ key: 'images', path: 'fresh-cover.png', bytes }] });
  assert.equal(plan.summary.length, 2);
  const lines = describePlan(plan);
  assert.match(lines[0], /^1 file, 7 B, to github\.com\/example\/images \(main\)$/);
  assert.match(lines[1], /to github\.com\/example\/blog \(main\)$/);
  assert.equal(net.ledger.uploaded.bytes, 0);

  const receipt = await executePlan(authed, plan);
  assert.equal(receipt.commits.length, 2);
  const assetCommit = receipt.commits[0].sha;
  assert.equal(receipt.commits[0].repo, 'example/images');
  assert.ok(server.state['example/images'].trees[server.state['example/images'].commits[assetCommit].tree].has('fresh-cover.png'));
  const after = server.files('example/blog');
  assert.equal(JSON.parse(after['assets.lock.json'])['images/fresh-cover.png'], assetCommit);
  assert.ok(after['fresh-post/index.html'].includes(`images@${assetCommit}/fresh-cover.png`));
  assert.ok(!after['posts/fresh-post.md'].includes('jsdelivr'), 'source keeps the logical reference');
  assert.ok(after['posts/fresh-post.md'].includes('cover: asset:images/fresh-cover.png'));
});

test('publish: existing asset is pinned from its latest commit; missing asset is refused before any write', async () => {
  const { server, net, authed } = await world();
  const ok = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST('cover: asset:images/new.png\n') });
  const lockChange = ok.changes.find((c) => c.path === 'assets.lock.json');
  assert.ok(lockChange && JSON.parse(lockChange.content)['images/new.png'] === server.state['example/images'].branches.main);

  await assert.rejects(
    planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST('cover: asset:images/ghost.png\n') }),
    (e) => e instanceof Refusal && e.code === 'unresolved-asset',
  );
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('publish: lossy or malformed source is refused before any write', async () => {
  const { net, authed } = await world();
  await assert.rejects(planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST('', 'published', 'wrapped\nline') }), (e) => e.code === 'lossy-round-trip');
  await assert.rejects(planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'other', text: NEW_POST() }), (e) => e.code === 'slug-mismatch');
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('correction path: a pull request on a new branch; main is untouched', async () => {
  const { server, authed } = await world();
  const slug = 'markdown-is-the-format';
  const before = server.state['example/blog'].branches.main;
  const text = server.files('example/blog')[`posts/${slug}.md`].replace('every tool in the world', 'every tool on earth');
  const plan = await planChange(authed, { repo: 'example/blog', branch: 'main', slug, text, mode: 'pr' });
  assert.match(describePlan(plan)[0], /to github\.com\/example\/blog \(new branch from main\)$/);
  const receipt = await executePlan(authed, plan, { pullBody: 'Typo.' });
  assert.equal(server.state['example/blog'].branches.main, before);
  assert.match(receipt.commits[0].branch, /^correction\/markdown-is-the-format-/);
  assert.equal(receipt.pull.number, 1);
  assert.equal(server.state['example/blog'].pulls[0].base, 'main');
  const onBranch = server.files('example/blog', receipt.commits[0].branch);
  assert.ok(onBranch[`posts/${slug}.md`].includes('every tool on earth'));
});

test('video: releases are listed from tags, newest version first; non-releases are ignored', async () => {
  const { net, authed } = await world();
  const { blog } = await loadBlog(authed, 'example/blog');
  const list = await listVideoReleases(authed, blog);
  assert.deepEqual(list.map((r) => r.ref), ['video:videos/a+b-cubed@v1', 'video:videos/hls-demo@v2', 'video:videos/hls-demo@v1']);
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('video: publish refuses a release that does not exist, before any write', async () => {
  const { net, authed } = await world();
  const withVideo = (ref) => NEW_POST('', 'published', `![](${ref})`);
  const ok = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: withVideo('video:videos/hls-demo@v2') });
  assert.ok(ok.changes.some((c) => c.path === 'fresh-post/index.html' && c.content.includes('hls-demo/v2/hls-demo/')));
  await assert.rejects(planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: withVideo('video:videos/hls-demo@v9') }), (e) => e instanceof Refusal && e.code === 'unresolved-asset' && /no release tagged hls-demo\/v9/.test(e.detail));
  // a draft may name a release that is not published yet
  const draft = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST('', 'draft', '![](video:videos/hls-demo@v9)') });
  assert.ok(draft.changes.every((c) => !c.path.startsWith('fresh-post/')));
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('slug-collision: a new post cannot take an existing slug', async () => {
  const { net, authed } = await world();
  await assert.rejects(
    planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'markdown-is-the-format', text: NEW_POST().replace('fresh-post', 'markdown-is-the-format'), create: true }),
    (e) => e instanceof Refusal && e.code === 'slug-collision',
  );
  assert.equal(net.ledger.uploaded.bytes, 0);
});

test('publish refuses to overwrite work pushed since planning (no force)', async () => {
  const { server, authed } = await world();
  const plan = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST() });
  const other = await planChange(authed, { repo: 'example/blog', branch: 'main', slug: 'fresh-post', text: NEW_POST('', 'published', 'Someone else got there first.') });
  await executePlan(authed, other);
  await assert.rejects(executePlan(authed, plan), /422|fast forward/);
  assert.ok(server.files('example/blog')['posts/fresh-post.md'].includes('Someone else'));
});
