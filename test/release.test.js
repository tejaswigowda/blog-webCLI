// Creating a video release: what a folder must hold, the version it gets, and the commit and tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { describeRelease, executeRelease, listReleaseFolders, planTagRelease } from '../app/release.js';
import { loadBlog, planChange } from '../app/site.js';
import { LIMITS, checkRelease, nextVersion, releaseFolders, versionsOf } from '../lib/release.js';
import { sha256Bytes } from '../lib/sha256.js';
import { fakeGitHub } from './fake-github.js';

const enc = new TextEncoder();
const code = (c) => (e) => e.code === c;
const file = (path, text = 'x') => ({ path, bytes: typeof text === 'string' ? enc.encode(text) : text });

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p30/index.m3u8\n';
const RUNG = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg00001.m4s\n#EXT-X-ENDLIST\n';
const render = (extra = []) => [file('master.m3u8', MASTER), file('render.json', '{"version":2}'), file('poster.jpg', 'JPG'), file('720p30/index.m3u8', RUNG), file('720p30/init.mp4', 'INIT'), file('720p30/seg00001.m4s', 'SEG'), ...extra];
const sums = (files) => files.filter((f) => f.path !== 'files.sha256').map((f) => `${sha256Bytes(f.bytes)}  ${f.path}`).join('\n') + '\n';

// ---------- the pure part ----------
test('versions: the next one follows the highest, and other names are not mixed in', () => {
  const tags = ['clip/v1', 'clip/v3', 'clip/v2', 'other/v9', 'clip-2/v5', 'clip/v0', 'clip/vx', 'a.b/v1'];
  assert.deepEqual(versionsOf(tags, 'clip'), [1, 2, 3]);
  assert.equal(nextVersion(tags, 'clip'), 4);
  assert.equal(nextVersion(tags, 'new'), 1);
  assert.equal(nextVersion(tags, 'a.b'), 2, 'a name is matched literally, not as a pattern');
});

test('folders: those with a master.m3u8 directly under the video folder', () => {
  const tree = new Map(['videos/clip/master.m3u8', 'videos/clip/720p30/index.m3u8', 'videos/notes/readme.md', 'videos/deep/er/master.m3u8', 'other/x/master.m3u8', 'videos/Bad_Name/master.m3u8', 'videos/a+b/master.m3u8'].map((p) => [p, 's']));
  assert.deepEqual(releaseFolders(tree, 'videos/'), ['a+b', 'clip']);
  assert.deepEqual(releaseFolders(new Map([['clip/master.m3u8', 's'], ['x/y.txt', 's']]), ''), ['clip']);
});

test('refusals: a release is refused, never repaired', () => {
  const ok = checkRelease('clip', render());
  assert.equal(ok.files.length, 6);
  assert.deepEqual(ok.files.map((f) => f.path), [...ok.files.map((f) => f.path)].sort());

  const refused = (name, files, re) => assert.throws(() => checkRelease(name, files), (e) => e.code === 'bad-release' && re.test(e.message), `${name}: ${re}`);
  for (const bad of ['', 'Clip', 'my clip', 'clip_1', '-clip', 'clip/v1', 'a--b']) refused(bad, render(), /not a valid release name/);
  refused('clip', [], /no files/);
  refused('clip', render().filter((f) => f.path !== 'master.m3u8'), /master\.m3u8 is missing/);
  refused('clip', render([file('index.html', '<script>')]), /\.html is not one of them/);
  refused('clip', render([file('run.sh', 'x')]), /\.sh is not one of them/);
  refused('clip', render([file('noext', 'x')]), /is not one of them/);
  refused('clip', render([file('a b.ts', 'x')]), /not a safe file name/);
  refused('clip', render([file('../x.ts', 'x')]), /not a safe file name/);
  refused('clip', render([file('a/../b.ts', 'x')]), /not a safe file name/);
  refused('clip', render([file('/abs.ts', 'x')]), /not a safe file name/);
  refused('clip', render([file('master.m3u8', 'x')]), /appears twice/);
  refused('clip', render([file('big.mp4', new Uint8Array(LIMITS.file + 1))]), /limit is 50 MB a file/);
  refused('clip', Array.from({ length: LIMITS.files + 1 }, (_, i) => file(`s${i}.ts`)), /limited to 2000/);
  const shared = new ArrayBuffer(LIMITS.file); // views of one buffer: every file counts toward the total, the test holds one
  const many = Math.ceil(LIMITS.total / LIMITS.file) + 1;
  refused('clip', Array.from({ length: many }, (_, i) => file(i ? `s${i}.ts` : 'master.m3u8', new Uint8Array(shared))), /MB in all/);
});

test('playlists name files inside the release and nothing else', () => {
  const withMaster = (master, ...more) => [file('master.m3u8', master), ...more];
  const refused = (files) => assert.throws(() => checkRelease('clip', files), (e) => e.code === 'bad-release' && /points outside the release/.test(e.message));
  refused(withMaster('#EXTM3U\nhttps://cdn.example/seg.m4s\n'));
  refused(withMaster('#EXTM3U\n//cdn.example/seg.m4s\n'));
  refused(withMaster('#EXTM3U\n/seg.m4s\n'));
  refused(withMaster('#EXTM3U\n../other/seg.m4s\n'));
  refused(withMaster('#EXTM3U\n#EXT-X-MAP:URI="https://cdn.example/init.mp4"\nseg.m4s\n'));
  refused(withMaster('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain,k"\nseg.m4s\n'));
  refused([...withMaster(MASTER), file('720p30/index.m3u8', '#EXTM3U\r\nhttp://x.example/a.m4s\r\n')]);
  assert.doesNotThrow(() => checkRelease('clip', withMaster('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n720p30/seg.m4s\n#EXT-X-ENDLIST\n')));
});

test('files.sha256: when present it is checked in sha256sum format', () => {
  const base = render();
  assert.doesNotThrow(() => checkRelease('clip', [...base, file('files.sha256', sums(base))]));
  assert.doesNotThrow(() => checkRelease('clip', [...base, file('files.sha256', sums(base).replace(/  /g, '  ./'))]), './ prefixes and blank lines are fine');
  const changed = base.map((f) => (f.path === '720p30/seg00001.m4s' ? file(f.path, 'TAMPERED') : f));
  assert.throws(() => checkRelease('clip', [...changed, file('files.sha256', sums(base))]), (e) => e.code === 'bad-release' && /720p30\/seg00001\.m4s does not match files\.sha256/.test(e.message));
  assert.throws(() => checkRelease('clip', [...base, file('files.sha256', `${'a'.repeat(64)}  gone.ts\n`)]), /lists gone\.ts, which is not in the folder/);
  assert.throws(() => checkRelease('clip', [...base, file('files.sha256', 'not a checksum line\n')]), /not in sha256sum format/);
});

// ---------- against an in-memory GitHub ----------
const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/site/blog', repo: 'example/site/blog' });

async function world({ push = true, tags = {} } = {}) {
  const files = { 'blog/blog.json': BLOG + '\n', '.nojekyll': '', 'videos/clip/master.m3u8': MASTER, 'videos/clip/render.json': '{}', 'videos/old/master.m3u8': MASTER, 'videos/notes/readme.md': 'not a render' };
  const server = fakeGitHub({ 'example/site': files }, { tags: { 'example/site': tags.list || [] } });
  await server.ready;
  const fetch = push ? server.fetch : async (url, init) => {
    const res = await server.fetch(url, init);
    return String(url) === 'https://api.github.com/repos/example/site' ? new Response(JSON.stringify({ default_branch: 'main', permissions: { push: false } }), { status: 200, headers: { 'content-type': 'application/json' } }) : res;
  };
  const gh = new GitHub(createNet(fetch), { token: 'github_pat_test' });
  const { blog } = await loadBlog(gh, 'example/site/blog', 'main');
  return { server, gh, blog };
}
const WHERE = 'example/site/videos';

test('listing: render folders in the video repository, and whether each is already released', async () => {
  const { gh, blog } = await world({ tags: { list: ['old/v1'] } });
  assert.deepEqual(blog.video.repos, { videos: 'example/site/videos' }, 'the default video home');
  const [r] = await listReleaseFolders(gh, blog);
  assert.equal(r.canPush, true);
  assert.deepEqual(r.folders.map((f) => [f.name, f.state, f.latest, f.next]), [['clip', 'new', 0, 1], ['old', 'released', 1, 2]], 'notes/ has no master.m3u8, so it is not listed');
  assert.equal(r.folders[0].files, 2);
});

test('tag a folder: one tag at the current commit, nothing uploaded, the next version', async () => {
  const { server, gh, blog } = await world();
  const plan = await planTagRelease(gh, { where: WHERE, name: 'clip' });
  assert.equal(plan.tag, 'clip/v1');
  assert.match(describeRelease(plan)[0], /^Tag clip\/v1 on github\.com\/example\/site \(main\), the commit it is at now\. 2 files already in videos\/clip\/; nothing is uploaded\.$/);
  const before = server.state['example/site'].branches.main;
  const receipt = await executeRelease(gh, plan);
  assert.equal(receipt.commit, null);
  assert.equal(receipt.tag, 'clip/v1');
  assert.equal(server.state['example/site'].branches.main, before, 'no commit was made');
  assert.equal(server.state['example/site'].tagRefs['clip/v1'], before, 'the tag is at the commit that was inspected');

  const [r] = await listReleaseFolders(gh, blog);
  assert.deepEqual(r.folders.find((f) => f.name === 'clip'), { name: 'clip', files: 2, latest: 1, next: 2, state: 'released' });
  assert.equal((await planTagRelease(gh, { where: WHERE, name: 'clip' })).tag, 'clip/v2');
  await assert.rejects(planTagRelease(gh, { where: WHERE, name: 'notes' }), code('bad-release'));
  await assert.rejects(planTagRelease(gh, { where: WHERE, name: 'missing' }), code('bad-release'));
});

test('a tag that appears between planning and sending is never moved', async () => {
  const { server, gh } = await world();
  const plan = await planTagRelease(gh, { where: WHERE, name: 'clip' });
  await gh.createTag('example/site', 'clip/v1', server.state['example/site'].branches.main);
  await assert.rejects(executeRelease(gh, plan), (e) => e.code === 'bad-release' && /already exists, and a tag never moves/.test(e.message));
});

test('no write access: refused before anything is sent', async () => {
  const { gh, blog } = await world({ push: false });
  const [r] = await listReleaseFolders(gh, blog);
  assert.equal(r.canPush, false);
  await assert.rejects(planTagRelease(gh, { where: WHERE, name: 'clip' }), /do not have write access to example\/site/);
});

test('a repository that cannot be read is reported, not thrown', async () => {
  const { gh, blog } = await world();
  const other = { ...blog, video: { ...blog.video, repos: { videos: 'example/site/videos', gone: 'example/missing' } } };
  const list = await listReleaseFolders(gh, other);
  assert.equal(list.length, 2);
  assert.ok(list[0].folders.length && !list[0].error);
  assert.ok(list[1].error && list[1].folders.length === 0);
});

// ---------- the editor after a long dialog ----------
import { insertionPoint } from '../lib/selection.js';

test('embeds: with the cursor gone, they go at the end instead of failing after the upload is done', () => {
  const quill = (selection, length) => ({ getSelection: (focus) => (assert.equal(focus, true, 'it asks for focus'), selection), getLength: () => length });
  assert.deepEqual(insertionPoint(quill({ index: 7, length: 0 }, 50)), { index: 7, length: 0 }, 'the cursor, when there is one');
  assert.deepEqual(insertionPoint(quill(null, 50)), { index: 49 }, 'the end of the text (Quill keeps a trailing newline)');
  assert.deepEqual(insertionPoint(quill(null, 1)), { index: 0 }, 'an empty document');
  assert.deepEqual(insertionPoint(quill(null, 0)), { index: 0 });
});
