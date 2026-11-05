import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { describePlan, executePlan, listVideoReleases, loadBlog, loadIndex, loadPost, planChange } from '../app/site.js';
import { buildSite, validateBlog } from '../lib/blog.js';
import { resolveAsset } from '../lib/assets.js';
import { videoEmbedUrl } from '../lib/video.js';
import { parseRepoRef } from '../lib/reporef.js';
import { fakeGitHub } from './fake-github.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
const SITE = 'example/site/blog';
const enc = new TextEncoder();

async function walk(dir, base = dir) {
  const out = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await walk(p, base));
    else out[path.relative(base, p)] = await fs.readFile(p);
  }
  return out;
}

// One repository holding the blog (blog/), images (images/) and hls.webcli.app renders (videos/).
async function sharedBlogJson() {
  const bj = JSON.parse(await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8'));
  bj.repo = SITE;
  bj.assets.repos = { images: 'example/site/images', audio: 'example/audio' };
  bj.video.repos = { videos: 'example/site/videos' };
  return bj;
}

async function world() {
  const files = {};
  for (const [p, c] of Object.entries(await walk(EXAMPLE))) {
    // generated output is regenerated against the shared layout; only sources are carried over
    if (p.startsWith('posts/') || p === 'assets.lock.json') files[`blog/${p}`] = c;
  }
  files['blog/blog.json'] = JSON.stringify(await sharedBlogJson(), null, 2) + '\n';
  files['.nojekyll'] = '';
  files['images/diagram.png'] = 'PNG';
  files['images/hls-cover.png'] = 'PNG';
  files['images/default-cover.png'] = 'PNG';
  files['videos/hls-demo/render.json'] = '{}';
  const server = fakeGitHub({ 'example/site': files, 'example/audio': { 'README.md': 'audio' } }, { tags: { 'example/site': ['hls-demo/v1', 'hls-demo/v2'] } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, net, anon: new GitHub(net), authed: new GitHub(net, { token: 'github_pat_test' }) };
}

const NEW_POST = (extra = '', status = 'published', body = 'Fresh words about nothing.') =>
  `---\nslug: fresh-post\ntitle: Fresh post\ndate: 2026-11-07\nstatus: ${status}\n${extra}---\n\n${body}\n`;

test('parseRepoRef: owner/name with an optional folder', () => {
  assert.deepEqual(parseRepoRef('a/b'), { repo: 'a/b', folder: '', ref: 'a/b' });
  assert.deepEqual(parseRepoRef('a/b/blog/v2'), { repo: 'a/b', folder: 'blog/v2', ref: 'a/b/blog/v2' });
  for (const bad of ['a', 'a/b/../c', 'a/b/.git', '/a/b', 'a/b/', 'a//b']) assert.throws(() => parseRepoRef(bad), bad);
});

test('urls: the folder is part of the pinned address; logical references are unchanged', async () => {
  const blog = validateBlog(await sharedBlogJson());
  const sha = 'a'.repeat(40);
  assert.equal(resolveAsset('asset:images/pic one.png'.replace(' ', '-'), blog, { 'images/pic-one.png': sha }), `https://cdn.jsdelivr.net/gh/example/site@${sha}/images/pic-one.png`);
  assert.equal(videoEmbedUrl('video:videos/clip@v3', blog), 'https://strataeditor.dev/player/#https://cdn.jsdelivr.net/gh/example/site@clip/v3/videos/clip/&present=true');
  // a root-level video repo keeps hls-webCLI's own layout
  blog.video.repos.videos = 'example/renders';
  assert.equal(videoEmbedUrl('video:videos/clip@v3', blog), 'https://strataeditor.dev/player/#https://cdn.jsdelivr.net/gh/example/renders@clip/v3/clip/&present=true');
});

test('blog.json: the blog and an asset or video repo cannot be the same place', async () => {
  const bj = await sharedBlogJson();
  assert.doesNotThrow(() => validateBlog(bj));
  assert.throws(() => validateBlog({ ...bj, video: { ...bj.video, repos: { videos: SITE } } }), (e) => e.code === 'bad-blog-json' && /give the blog or the video a folder/.test(e.detail));
  assert.throws(() => validateBlog({ ...bj, repo: 'example/site', assets: { ...bj.assets, repos: { images: 'example/site' } } }), (e) => e.code === 'bad-blog-json');
  assert.throws(() => validateBlog({ ...bj, repo: 'example/site/blog', assets: { ...bj.assets, repos: { images: 'example/site/..' } } }), (e) => e.code === 'bad-blog-json');
  // different folders of one repository are fine, and so is the same folder name in another repository
  assert.doesNotThrow(() => validateBlog({ ...bj, assets: { ...bj.assets, repos: { images: 'other/site/blog' } } }));
});

test('slugs: a post cannot take the name of a folder inside the blog directory', async () => {
  const bj = await sharedBlogJson();
  bj.repo = 'example/site'; // the blog at the root, images in images/
  const fm = (slug) => `---\nslug: ${slug}\ntitle: T\ndate: 2026-01-01\nstatus: published\n---\n\nbody\n`;
  const lock = { 'images/default-cover.png': '1'.repeat(40) };
  const codes = (slug) => buildSite({ blog: bj, lock, posts: [{ path: `posts/${slug}.md`, text: fm(slug) }] }).errors.map((e) => e.code);
  assert.deepEqual(codes('images'), ['slug-collision']);
  assert.deepEqual(codes('videos'), ['slug-collision']);
  assert.deepEqual(codes('ordinary'), []);
  // with the blog in blog/, siblings of blog/ are not in its way
  bj.repo = SITE;
  assert.deepEqual(codes('images'), []);
});

test('reader: a blog in a folder of a shared repository renders; nothing is uploaded (B11)', async () => {
  const { net, anon } = await world();
  await assert.rejects(loadBlog(anon, 'example/site'), (e) => e.code === 'no-blog-json', 'the repository root is not the blog');
  const ctx = await loadBlog(anon, SITE);
  const index = await loadIndex(anon, SITE); // no generated index yet: falls back to listing blog/posts
  assert.deepEqual(index.map((e) => e.slug), ['static-hls-in-git', 'markdown-is-the-format']);
  const { html } = await loadPost(anon, SITE, 'static-hls-in-git', undefined, ctx);
  assert.ok(html.includes('example/site@2222222222222222222222222222222222222222/images/diagram.png'), 'image under the images folder');
  assert.ok(html.includes('#https://cdn.jsdelivr.net/gh/example/site@hls-demo/v1/videos/hls-demo/&amp;present=true'), 'video under the videos folder');
  await assert.rejects(loadPost(anon, SITE, 'unfinished-thoughts', undefined, ctx), /No such post/);
  assert.equal(net.ledger.uploaded.bytes, 0);
  assert.ok((await listVideoReleases(anon, ctx.blog)).map((r) => r.ref).includes('video:videos/hls-demo@v2'));
});

test('publish into a folder: blog files, image and pin land in their own folders; nothing else is touched', async () => {
  const { server, authed } = await world();
  const before = server.files('example/site');
  const bytes = Uint8Array.from([137, 80, 78, 71, 9]);
  const plan = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: NEW_POST('cover: asset:images/fresh.png\n'), staged: [{ key: 'images', path: 'fresh.png', bytes }] });

  const lines = describePlan(plan);
  assert.match(lines[0], /^1 file, 5 B, to github\.com\/example\/site \(main\)$/);
  assert.match(lines[1], /to github\.com\/example\/site \(main\) in blog\/$/);
  assert.ok(plan.changes.every((c) => c.path.startsWith('blog/')), 'every blog change is under blog/');
  assert.ok(plan.assetGroups[0].files[0].path === 'images/fresh.png');

  const receipt = await executePlan(authed, plan);
  assert.equal(receipt.commits.length, 2);
  const [assetCommit, blogCommit] = receipt.commits;
  const S = server.state['example/site'];
  assert.equal(S.commits[blogCommit.sha].parents[0], assetCommit.sha, 'the blog commit builds on the image commit');
  assert.equal(S.branches.main, blogCommit.sha);

  const after = server.files('example/site');
  const changed = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p]);
  assert.ok(changed.length && changed.every((p) => p.startsWith('blog/') || p === 'images/fresh.png'), `unexpected changes: ${changed.filter((p) => !p.startsWith('blog/'))}`);
  assert.equal(after['.nojekyll'], '');
  assert.equal(JSON.parse(after['blog/assets.lock.json'])['images/fresh.png'], assetCommit.sha, 'the lock key is logical; the pin is the image commit');
  assert.ok(after['blog/fresh-post/index.html'].includes(`example/site@${assetCommit.sha}/images/fresh.png`));
  assert.ok(after['blog/posts/fresh-post.md'].includes('cover: asset:images/fresh.png') && !/jsdelivr/.test(after['blog/posts/fresh-post.md']));
  for (const p of ['blog/index.html', 'blog/feed.xml', 'blog/index/posts.json']) assert.ok(after[p], p);
  assert.ok(!('index.html' in after) && !('fresh-post/index.html' in after), 'nothing generated at the repository root');

  // The browser's output is what the CLI would regenerate from the blog folder alone.
  const folder = Object.fromEntries(Object.entries(after).filter(([p]) => p.startsWith('blog/')).map(([p, t]) => [p.slice(5), t]));
  const regen = buildSite({
    blog: folder['blog.json'],
    posts: Object.entries(folder).filter(([p]) => p.startsWith('posts/')).map(([p, t]) => ({ path: p, text: t })),
    lock: JSON.parse(folder['assets.lock.json']),
  });
  for (const [p, c] of Object.entries(regen.files)) assert.equal(folder[p], c, `${p} differs from a fresh regeneration`);
});

test('publish into a folder: a draft removes the generated page from that folder', async () => {
  const { server, authed } = await world();
  const first = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: NEW_POST() });
  await executePlan(authed, first);
  assert.ok('blog/fresh-post/index.html' in server.files('example/site'));
  const plan = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: NEW_POST('', 'draft') });
  assert.ok(plan.changes.some((c) => c.delete && c.path === 'blog/fresh-post/index.html'));
  await executePlan(authed, plan);
  const after = server.files('example/site');
  assert.ok(!('blog/fresh-post/index.html' in after) && !after['blog/feed.xml'].includes('fresh-post'));
});

test('publish into a folder: work pushed since planning is not overwritten, even with an image in the same repository', async () => {
  const { server, authed } = await world();
  const staged = [{ key: 'images', path: 'a.png', bytes: Uint8Array.from([1, 2, 3]) }];
  const mine = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: NEW_POST('cover: asset:images/a.png\n'), staged });
  const theirs = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: NEW_POST('', 'published', 'Someone else got there first.') });
  await executePlan(authed, theirs);
  await assert.rejects(executePlan(authed, mine), /422|fast forward/);
  assert.ok(server.files('example/site')['blog/posts/fresh-post.md'].includes('Someone else'));
});

test('corrections: a pull request from a folder; staged images in the same repository are refused', async () => {
  const { server, authed } = await world();
  const slug = 'markdown-is-the-format';
  const text = (await fs.readFile(path.join(EXAMPLE, 'posts', `${slug}.md`), 'utf8')).replace('every tool in the world', 'every tool on earth');
  const before = server.state['example/site'].branches.main;
  const plan = await planChange(authed, { repo: SITE, branch: 'main', slug, text, mode: 'pr' });
  assert.match(describePlan(plan)[0], /\(new branch from main\) in blog\/$/);
  const receipt = await executePlan(authed, plan, {});
  assert.equal(server.state['example/site'].branches.main, before);
  assert.ok(server.files('example/site', receipt.commits[0].branch)[`blog/posts/${slug}.md`].includes('every tool on earth'));
  assert.match(server.state['example/site'].pulls[0].body, /blog\/posts\/markdown-is-the-format\.md/);

  await assert.rejects(
    planChange(authed, { repo: SITE, branch: 'main', slug, text: text.replace('body', 'x') + '\n![](asset:images/n.png)\n', mode: 'pr', staged: [{ key: 'images', path: 'n.png', bytes: enc.encode('x') }] }),
    /default branch alone/,
  );
});

test('video: tags are checked against the shared repository, not the folder', async () => {
  const { authed } = await world();
  const withVideo = (ref) => NEW_POST('', 'published', `![](${ref})`);
  const ok = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: withVideo('video:videos/hls-demo@v2') });
  assert.ok(ok.changes.some((c) => c.path === 'blog/fresh-post/index.html' && c.content.includes('example/site@hls-demo/v2/videos/hls-demo/')));
  await assert.rejects(planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh-post', text: withVideo('video:videos/hls-demo@v9') }), (e) => e.code === 'unresolved-asset');
});
