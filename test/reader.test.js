import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { loadIndex, loadPost } from '../app/site.js';
import { hashFor, isTrustedHost, normalizeBlogUrl, openBlog, parseReaderHash, staticAddress, staticPostUrl } from '../app/reader-core.js';
import { validateBlog, withRepoOverrides } from '../lib/blog.js';
import { fakeGitHub } from './fake-github.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
const exampleBlog = async () => validateBlog(await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8'));

test('hash: repo, post, ref, media overrides and the static blog address', () => {
  assert.deepEqual(parseReaderHash('#repo=me/site/blog&post=hello&ref=dev&images=me/img&video=me/renders&audio=me/aud&blog=https://me.github.io/site/blog'), {
    repo: 'me/site/blog', post: 'hello', path: null, ref: 'dev', blogUrl: 'https://me.github.io/site/blog', images: 'me/img', video: 'me/renders', audio: 'me/aud',
  });
  assert.deepEqual(parseReaderHash(''), { repo: null, post: null, path: null, ref: undefined, blogUrl: null, images: null, video: null, audio: null });
  assert.equal(parseReaderHash('#repo= me/x ').repo, 'me/x');
});

test('hash: links keep every parameter the reader was opened with', () => {
  const p = parseReaderHash('#repo=me/site/blog&images=me/img&blog=https://me.github.io/site/blog');
  assert.equal(hashFor(p), '#repo=me/site/blog&images=me/img&blog=https://me.github.io/site/blog');
  assert.equal(hashFor(p, { post: 'hello' }), '#repo=me/site/blog&post=hello&images=me/img&blog=https://me.github.io/site/blog');
  assert.deepEqual(parseReaderHash(hashFor(p, { post: 'a b' })), { ...p, post: 'a b' });
  // any page of the published site: tags, pages of the index, the archive
  assert.equal(hashFor(p, { path: '/tags/video/' }), '#repo=me/site/blog&path=tags/video/&images=me/img&blog=https://me.github.io/site/blog');
  assert.equal(parseReaderHash(hashFor(p, { path: 'page/2/' })).path, 'page/2/');
});

test('blog address: https only, no credentials, query or fragment', () => {
  assert.equal(normalizeBlogUrl('https://me.github.io/site/?x=1#y'), 'https://me.github.io/site');
  assert.equal(normalizeBlogUrl('https://me.github.io/'), 'https://me.github.io');
  for (const bad of ['http://me.github.io', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@me.github.io', 'not a url', '//evil.example', 'ftp://x.y']) {
    assert.throws(() => normalizeBlogUrl(bad), Error, bad);
  }
});

test('blog address: only GitHub Pages and this app open without a confirmation', () => {
  assert.ok(isTrustedHost('https://me.github.io/blog'));
  assert.ok(isTrustedHost('https://blog.webcli.app/x'));
  for (const u of ['https://evil.example/', 'https://me.github.io.evil.example/', 'https://github.io.evil.example', 'https://notgithub.io/']) assert.ok(!isTrustedHost(u), u);
});

test('failsafe address: the hash, then blog.json, then the usual Pages address (marked uncertain)', async () => {
  const blog = await exampleBlog();
  assert.deepEqual(staticAddress({ blogUrl: 'https://x.example/b/', blog, repo: 'me/notes' }), { base: 'https://x.example/b', certain: true });
  assert.deepEqual(staticAddress({ blog, repo: 'me/notes' }), { base: 'https://example.github.io/blog', certain: true });
  assert.deepEqual(staticAddress({ blog: null, repo: 'me/notes/blog' }), { base: 'https://me.github.io/notes/blog', certain: false });
  assert.equal(staticPostUrl('https://me.github.io/notes', 'hello'), 'https://me.github.io/notes/hello/');
  assert.throws(() => staticAddress({ blogUrl: 'http://x.example', blog: null, repo: 'me/notes' }));
});

test('overrides: the hash wins, blog.json fills in the rest, the input is untouched', async () => {
  const blog = await exampleBlog();
  const before = JSON.stringify(blog);
  const next = withRepoOverrides(blog, { images: 'me/pics/web', video: 'me/clips' });
  assert.equal(next.assets.repos.images, 'me/pics/web', 'overridden');
  assert.equal(next.assets.repos.audio, 'example/audio', 'filled in from blog.json');
  assert.equal(next.video.repos.videos, 'me/clips', 'the only video key is the one overridden');
  assert.equal(next.assets.base, blog.assets.base, 'templates still come from blog.json');
  assert.equal(next.customize.width, '42rem', 'so does everything else');
  assert.equal(JSON.stringify(blog), before);
  assert.equal(withRepoOverrides(blog, {}).title, blog.title);
  assert.equal(withRepoOverrides(blog, { audio: 'me/aud' }).assets.repos.audio, 'me/aud');
});

test('overrides: a blog.json with no media section gets the default templates; bad values are refused', async () => {
  const bare = validateBlog({ title: 'T', description: 'D', author: 'A', domain: 'https://x.github.io/t', repo: 'me/t' });
  const next = withRepoOverrides(bare, { images: 'me/pics', video: 'me/clips' });
  assert.match(next.assets.base, /^https:\/\/cdn\.jsdelivr\.net\/gh\/\{owner\}\/\{repo\}@\{sha\}\/\{path\}$/);
  assert.equal(next.video.player, 'https://strataeditor.dev/player/');
  assert.deepEqual(next.video.repos, { videos: 'me/clips' });
  for (const bad of [{ images: 'not a repo' }, { video: '../x' }, { audio: 'me/x/..' }, { images: 'me/t' }]) {
    assert.throws(() => withRepoOverrides(bare, bad), (e) => e.code === 'bad-blog-json', JSON.stringify(bad));
  }
});

async function world() {
  const files = {};
  for (const f of ['blog.json', 'assets.lock.json', 'index/posts.json', 'posts/static-hls-in-git.md', 'posts/markdown-is-the-format.md', 'posts/unfinished-thoughts.md']) files[f] = await fs.readFile(path.join(EXAMPLE, f));
  const server = fakeGitHub({ 'example/blog': files });
  await server.ready;
  const net = createNet(server.fetch);
  return { net, gh: new GitHub(net) };
}

test('reader: an anonymous read opens the blog with overrides applied and uploads nothing (B11)', async () => {
  const { net, gh } = await world();
  const parsed = parseReaderHash('#repo=example/blog&images=me/mirror/pics&post=static-hls-in-git');
  const ctx = await openBlog(gh, parsed);
  assert.equal(ctx.blog.assets.repos.images, 'me/mirror/pics');
  assert.equal((await loadIndex(gh, 'example/blog')).length, 2);
  const { html } = await loadPost(gh, 'example/blog', 'static-hls-in-git', undefined, ctx);
  assert.ok(html.includes('me/mirror@2222222222222222222222222222222222222222/pics/diagram.png'), 'the override decides where images are read from');
  assert.ok(html.includes('<iframe src="https://strataeditor.dev/player/#'));
  assert.equal(net.ledger.uploaded.bytes, 0);
  assert.ok(net.ledger.log.every((l) => l.method === 'GET'));
});

test('reader: failures are errors the page can turn into the failsafe, never partial content', async () => {
  const { gh } = await world();
  await assert.rejects(openBlog(gh, parseReaderHash('#repo=example/missing')), (e) => e.code === 'no-blog-json');
  await assert.rejects(openBlog(gh, parseReaderHash('#repo=nonsense')), /Open a blog with #repo/);
  await assert.rejects(openBlog(gh, parseReaderHash('#repo=example/blog&images=bad')), (e) => e.code === 'bad-blog-json');
  const down = new GitHub(createNet(() => Promise.reject(new TypeError('Failed to fetch'))));
  await assert.rejects(openBlog(down, parseReaderHash('#repo=example/blog')), /Failed to fetch/);
  // and what the page would offer then
  assert.equal(staticAddress({ blog: null, repo: 'example/blog' }).base, 'https://example.github.io/blog');
});
