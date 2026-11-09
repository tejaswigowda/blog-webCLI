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
  // opening the view reads; the only write is a button's planMedia -> commitPlan, which shows the pre-flight first (see below)
  assert.ok(!/executePlan|executeMedia|planChange|\.api\('(POST|PUT|PATCH|DELETE)/.test(view), 'opening the view writes nothing');
});

// ---------- add images, replace one under the same filename ----------

import { executeMedia, planMedia, mediaName } from '../app/site.js';
import { readDirFiles } from './helpers.js';

const EXROOT = path.join(root, 'examples');
async function uploadWorld(mutate = () => {}) {
  const blogFiles = await readDirFiles(path.join(EXROOT, 'blog'));
  mutate(blogFiles);
  const server = fakeGitHub({ 'example/blog': blogFiles, 'example/images': { 'diagram.png': 'old diagram', 'spare.png': 'spare', 'hls-cover.png': 'cover', 'default-cover.png': 'dc' }, 'example/renders': { 'README.md': 'r' } }, { tags: { 'example/renders': ['hls-demo/v1'] } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, net, gh: new GitHub(net, { token: 'github_pat_test' }) };
}
const bytes = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array([s]));

test('media: a new image is kept under its own cleaned name, in one commit, and nothing else changes', async () => {
  const { server, gh } = await uploadWorld();
  assert.equal(mediaName('My Photo (1).PNG'), 'my-photo-1.png');
  assert.equal(mediaName('../../etc/Pass wd.jpg'), 'pass-wd.jpg');
  const lockBefore = server.files('example/blog')['assets.lock.json'];
  const plan = await planMedia(gh, { repo: 'example/blog', branch: 'main', uploads: [{ key: 'images', name: 'Fresh Photo.PNG', bytes: bytes('three bytes') }] });
  assert.equal(plan.assetGroups[0].files[0].path, 'fresh-photo.png');
  assert.equal(plan.assetGroups[0].files[0].action, 'add');
  assert.deepEqual(plan.media.refreshed, []);
  const receipt = await executeMedia(gh, plan);
  assert.equal(receipt.commits.length, 1, 'only the upload is committed: no page embeds a new image');
  assert.equal(server.files('example/images')['fresh-photo.png'], 'three bytes');
  assert.equal(server.files('example/blog')['assets.lock.json'], lockBefore);
});

test('media: replace keeps the filename, moves the pin to the upload and regenerates the pages that embed it', async () => {
  const { server, gh } = await uploadWorld();
  const before = JSON.parse(server.files('example/blog')['assets.lock.json']);
  assert.ok(before['images/diagram.png'], 'a published post embeds diagram.png');
  const other0 = server.files('example/blog')['markdown-is-the-format/index.html'];
  const html0 = server.files('example/blog')['static-hls-in-git/index.html'];
  assert.ok(html0.includes(before['images/diagram.png']));
  const plan = await planMedia(gh, { repo: 'example/blog', branch: 'main', uploads: [{ key: 'images', path: 'diagram.png', replace: true, bytes: bytes('new diagram') }] });
  assert.equal(plan.assetGroups[0].files[0].action, 'update');
  assert.deepEqual(plan.media.refreshed, [{ key: 'images', path: 'diagram.png', pinned: true }]);
  const receipt = await executeMedia(gh, plan);
  assert.equal(receipt.commits.length, 2, 'the upload, then the one page that embeds it');
  assert.equal(server.files('example/images')['diagram.png'], 'new diagram');
  assert.ok(!server.files('example/images')['new-name.png'], 'no other file appeared');
  const after = JSON.parse(server.files('example/blog')['assets.lock.json']);
  assert.equal(after['images/diagram.png'], receipt.commits[0].sha, 'the pin is the upload commit');
  assert.equal(after['images/hls-cover.png'], before['images/hls-cover.png'], 'other pins are untouched');
  const html1 = server.files('example/blog')['static-hls-in-git/index.html'];
  assert.ok(html1.includes(receipt.commits[0].sha) && !html1.includes(before['images/diagram.png']), 'the page now loads the new file');
  assert.equal(server.files('example/blog')['markdown-is-the-format/index.html'], other0, 'a page that does not embed it is not rewritten');
  assert.match(plan.headline[0], /Embedded in 1 page: only that page is regenerated/);
  assert.equal(plan.media.full, false);
});

test('media: replacing an image no page embeds writes only the pin', async () => {
  // pinned once, embedded nowhere now
  const { server, gh } = await uploadWorld((files) => { const lock = JSON.parse(new TextDecoder().decode(files['assets.lock.json'])); lock['images/spare.png'] = 'e'.repeat(40); files['assets.lock.json'] = new TextEncoder().encode(JSON.stringify(lock)); });
  const plan = await planMedia(gh, { repo: 'example/blog', branch: 'main', uploads: [{ key: 'images', path: 'spare.png', replace: true, bytes: bytes('spare v2') }] });
  assert.deepEqual(plan.media.affected, []);
  assert.match(plan.headline[0], /only the pin in assets\.lock\.json moves/);
  const pagesBefore = server.files('example/blog')['index.html'];
  const receipt = await executeMedia(gh, plan);
  assert.deepEqual(receipt.commits.map((c) => c.files), [1, 1], 'the image, and the lock file');
  assert.equal(JSON.parse(server.files('example/blog')['assets.lock.json'])['images/spare.png'], receipt.commits[0].sha);
  assert.equal(server.files('example/blog')['index.html'], pagesBefore);
});

test('media: a replaced image nothing embeds is just uploaded', async () => {
  const { server, gh } = await uploadWorld();
  const plan = await planMedia(gh, { repo: 'example/blog', branch: 'main', uploads: [{ key: 'images', path: 'spare.png', replace: true, bytes: bytes('replaced spare') }] });
  assert.deepEqual(plan.media.refreshed, []);
  assert.equal((await executeMedia(gh, plan)).commits.length, 1);
  assert.equal(server.files('example/images')['spare.png'], 'replaced spare');
});

test('media: refusals say what to do (a name already there, nothing to replace, the same file, not an image, twice, too big, no repository)', async () => {
  const { gh } = await uploadWorld();
  const plan = (uploads) => planMedia(gh, { repo: 'example/blog', branch: 'main', uploads });
  await assert.rejects(plan([{ key: 'images', name: 'Diagram.png', bytes: bytes(1) }]), /already exists.*Replace/);
  await assert.rejects(plan([{ key: 'images', path: 'ghost.png', replace: true, bytes: bytes(1) }]), /nothing to replace/);
  await assert.rejects(plan([{ key: 'images', path: 'spare.png', replace: true, bytes: new TextEncoder().encode('spare') }]), /already there/);
  await assert.rejects(plan([{ key: 'images', name: 'notes.txt', bytes: bytes(1) }]), /only png, jpg, gif and webp/);
  await assert.rejects(plan([{ key: 'images', name: 'a.png', bytes: bytes(1) }, { key: 'images', name: 'A.png', bytes: bytes(2) }]), /twice/);
  await assert.rejects(plan([{ key: 'images', name: 'big.png', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }]), /20 MB/);
  await assert.rejects(plan([{ key: 'nope', name: 'a.png', bytes: bytes(1) }]), /no images repository "nope"/);
  await assert.rejects(plan([]), /at least one/);
});

test('media: the buttons are in the view, and a write goes through the pre-flight', async () => {
  const app = await fs.readFile(path.join(root, 'app/app.js'), 'utf8');
  const view = app.slice(app.indexOf('async function mediaView'), app.indexOf('// ---------- reading ----------'));
  assert.match(view, /Add images…/);
  assert.match(view, /onReplace/);
  assert.match(view, /commitPlan\(plan, repo, r, btn\)/);
  assert.match(app, /async function commitPlan[\s\S]*confirmPlan\(plan\)[\s\S]*executeMedia/);
});

test('media: an image a blog.json setting uses is on every page, so that one case regenerates the blog', async () => {
  const { server, gh } = await uploadWorld();
  const plan = await planMedia(gh, { repo: 'example/blog', branch: 'main', uploads: [{ key: 'images', path: 'default-cover.png', replace: true, bytes: bytes('new default cover') }] });
  assert.equal(plan.media.full, true);
  assert.match(plan.headline[0], /blog setting.*every page/);
  const receipt = await executeMedia(gh, plan);
  assert.equal(receipt.commits.length, 2);
  assert.equal(JSON.parse(server.files('example/blog')['assets.lock.json'])['images/default-cover.png'], receipt.commits[0].sha);
});
