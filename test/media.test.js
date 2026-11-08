// The media view (gate N12): the images of the asset repositories as lazy tiles with explicit dimensions, opening it uploads nothing,
// and "unused" is computed from the index and the lock file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { listMedia } from '../app/site.js';
import { filterMedia, imagePaths, mediaItems, tileUrl, usedRefs } from '../lib/media.js';
import { fakeGitHub } from './fake-github.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const BLOG = { title: 'T', description: 'D', author: 'A', domain: 'https://x.test', assets: { base: 'https://cdn.test/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/images/pics', audio: 'me/audio' } } };

test('imagePaths: image files inside the repository folder, relative to it', () => {
  const tree = new Map(['pics/a.png', 'pics/sub/b.JPG', 'pics/notes.txt', 'pics/c.gif', 'other/d.png', 'e.webp'].map((p) => [p, 'x']));
  assert.deepEqual(imagePaths(tree, 'me/images/pics'), ['a.png', 'c.gif', 'sub/b.JPG']);
  assert.deepEqual(imagePaths(tree, 'me/images'), ['e.webp', 'other/d.png', 'pics/a.png', 'pics/c.gif', 'pics/sub/b.JPG']);
});

test('N12: unused is what neither assets.lock.json nor an indexed cover references; a search and the filter narrow the list', () => {
  const lock = { 'images/used.png': 'a'.repeat(40) };
  const index = { posts: [{ slug: 's', cover: 'asset:images/cover.png' }, { slug: 't', cover: null }] };
  assert.deepEqual([...usedRefs(lock, index)].sort(), ['images/cover.png', 'images/used.png']);
  const items = mediaItems({ key: 'images', paths: ['used.png', 'cover.png', 'spare.png', 'Spare-2.png'], lock, index });
  assert.deepEqual(items.map((i) => [i.path, i.unused, i.pinned]), [['used.png', false, true], ['cover.png', false, false], ['spare.png', true, false], ['Spare-2.png', true, false]]);
  assert.deepEqual(filterMedia(items, { onlyUnused: true }).map((i) => i.path), ['spare.png', 'Spare-2.png']);
  assert.deepEqual(filterMedia(items, { query: 'SPARE 2' }).map((i) => i.path), ['Spare-2.png']);
  assert.equal(items[0].ref, 'asset:images/used.png');
});

test('tileUrl: the pinned CDN address a page would use, with the folder and escaping', () => {
  assert.equal(tileUrl(BLOG, 'images', 'sub dir/a b.png', 'f'.repeat(40)), `https://cdn.test/me/images@${'f'.repeat(40)}/pics/sub%20dir/a%20b.png`);
  assert.equal(tileUrl(BLOG, 'nope', 'a.png', 'f'.repeat(40)), null);
  assert.equal(tileUrl(BLOG, 'images', 'a.png', null), null);
});

test('N12: opening the media view lists every repository and uploads nothing', async () => {
  const server = fakeGitHub({ 'me/images': { 'pics/one.png': 'p1', 'pics/two.jpg': 'p2', 'pics/readme.md': 'r', 'elsewhere/three.png': 'p3' }, 'me/audio': { 'a.png': 'p4' } });
  await server.ready;
  const net = createNet(server.fetch);
  const gh = new GitHub(net, { token: 'github_pat_test' });
  const lock = { 'images/one.png': 'c'.repeat(40) };
  const { items, problems } = await listMedia(gh, { blog: BLOG, lock, index: { posts: [] } });
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => `${i.key}:${i.path}:${i.unused}`), ['images:one.png:false', 'images:two.jpg:true', 'audio:a.png:true']);
  assert.match(items[0].url, /^https:\/\/cdn\.test\/me\/images@c{40}\/pics\/one\.png$/, 'a pinned image loads from its pin');
  assert.match(items[1].url, /^https:\/\/cdn\.test\/me\/images@[0-9a-f]{40}\/pics\/two\.jpg$/, 'an unpinned one from the repository head');
  assert.equal(net.ledger.uploaded.bytes, 0, 'nothing uploaded');
  assert.equal(net.ledger.uploaded.requests, 0);
  assert.ok(net.ledger.read.requests > 0 && net.ledger.read.bytes > 0, 'what was read is counted');
  const missing = await listMedia(gh, { blog: { ...BLOG, assets: { ...BLOG.assets, repos: { images: 'me/gone' } } }, lock, index: { posts: [] } });
  assert.equal(missing.items.length, 0);
  assert.equal(missing.problems.length, 1, 'a repository that cannot be read is reported, not fatal');
});

test('N12: every tile is lazy with explicit dimensions, and the view has no write path', async () => {
  const app = await fs.readFile(path.join(root, 'app/app.js'), 'utf8');
  assert.match(app, /h\('img', \{ src: it\.url \|\| '', alt: '', loading: 'lazy', width: 160, height: 120 \}\)/);
  const view = app.slice(app.indexOf('// ---------- media ----------'), app.indexOf('// ---------- reading ----------'));
  assert.ok(!/commit|planChange|executePlan|\.api\('(POST|PUT|PATCH|DELETE)/.test(view), 'opening the view writes nothing');
});
