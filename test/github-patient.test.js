// A long upload is slow on purpose and can be carried on: GitHub's limit is waited out for as long as it asks, a blob that
// was already sent is not sent again, and a run that changes nothing makes no commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executeImport, planImport } from '../app/import.js';
import { fakeGitHub } from './fake-github.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), keys: () => [...m.keys()] };
};

function limitedFor(failures, headers, status = 403) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (calls.length <= failures) return json({ message: 'API rate limit exceeded for user ID 1.' }, status, headers);
    return json({ sha: 'abc' }, 201);
  };
  const waits = [];
  const told = [];
  const gh = new GitHub(createNet(fetch), { token: 'github_pat_test', wait: async (ms) => waits.push(ms) });
  gh.onWait = (s) => told.push(s);
  return { gh, calls, waits, told };
}

test('patient: the hourly limit is waited out for as long as GitHub says, reads included, and counted down', async () => {
  const w = limitedFor(6, { 'retry-after': '30' });
  w.gh.patient = true;
  assert.deepEqual(await w.gh.api('GET', '/repos/o/r'), { sha: 'abc' });
  assert.equal(w.calls.length, 7, 'six refusals, more than the four a normal write tolerates, then the answer');
  assert.equal(w.waits.reduce((a, b) => a + b, 0), 6 * 31000);
  assert.ok(w.told.includes(31) && w.told.includes(6) && w.told.every((s) => s <= 31));

  const reset = Math.floor(Date.now() / 1000) + 600;
  const h = limitedFor(1, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
  h.gh.patient = true;
  await h.gh.api('POST', '/repos/o/r/git/blobs', {});
  const waited = h.waits.reduce((a, b) => a + b, 0) / 1000;
  assert.ok(waited >= 600 && waited <= 605, `waits until the reset GitHub named: ${waited}`);

  const impatient = limitedFor(1, { 'retry-after': '30' });
  await assert.rejects(impatient.gh.api('GET', '/repos/o/r'), /GitHub 403/, 'without patient mode a read is still not retried');
});

test('patient: stops short of the limit, and Stop ends a wait', async () => {
  const reset = Math.floor(Date.now() / 1000) + 300;
  const calls = [];
  const waits = [];
  const fetch = async (url, init = {}) => {
    calls.push(init.method || 'GET');
    return json({ ok: true }, 200, { 'x-ratelimit-remaining': calls.length === 1 ? '2' : '4000', 'x-ratelimit-reset': String(reset) });
  };
  const gh = new GitHub(createNet(fetch), { token: 'github_pat_test', wait: async (ms) => waits.push(ms) });
  gh.patient = true;
  await gh.api('GET', '/a');
  assert.equal(waits.length, 0);
  await gh.api('GET', '/b'); // 2 left: wait for the reset before asking, not after being refused
  assert.ok(waits.length > 0 && waits.reduce((a, b) => a + b, 0) / 1000 >= 300);
  assert.equal(calls.length, 2);

  const w = limitedFor(9, { 'retry-after': '600' });
  w.gh.patient = true;
  let stopped = false;
  w.gh.isCancelled = () => stopped;
  w.gh.wait = async () => { stopped = true; };
  await assert.rejects(w.gh.api('GET', '/x'), (e) => e.code === 'cancelled');
});

async function repoWorld() {
  const server = fakeGitHub({ 'me/site': { 'README.md': 'hello' } });
  await server.ready;
  return server;
}

const png = (i) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, i, i >> 8, 1, 2, 3]);
const file = (i) => ({ path: `images/wp/p${String(i).padStart(3, '0')}.png`, content: png(i) });

test('resume: blobs already sent are not sent again, and a run that changes nothing makes no commit', async () => {
  const server = await repoWorld();
  let blobs = 0;
  let breakAt = 0;
  const net = createNet(async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && String(url).endsWith('/git/blobs')) {
      blobs++;
      if (breakAt && blobs === breakAt) return json({ message: 'boom' }, 500);
    }
    return server.fetch(url, init);
  });
  const store = memory();
  const gh = new GitHub(net, { token: 'github_pat_test', store });
  const head = await gh.headCommit('me/site', 'main');
  const files = Array.from({ length: 12 }, (_, i) => file(i));
  const base = { branch: 'main', parent: head.sha, baseTree: head.treeSha, files, message: 'pictures' };

  breakAt = 8;
  await assert.rejects(gh.commit('me/site', base), /GitHub 500/);
  assert.ok(blobs >= 8 && blobs < 12 + 3);
  const sent = blobs;
  assert.ok(store.keys().includes('blog.webcli.blobs:me/site'), 'what was sent is remembered, in storage');

  // a new page load: a new client with the same storage
  breakAt = 0;
  blobs = 0;
  const again = new GitHub(net, { token: 'github_pat_test', store });
  const c = await again.commit('me/site', base);
  assert.equal(blobs, 12 - (sent - 1), `only the ${12 - (sent - 1)} that had not been sent are sent`);
  assert.equal(Object.keys(server.files('me/site')).filter((p) => p.startsWith('images/wp/')).length, 12);

  // the same again: nothing to send, and nothing to commit
  const h2 = await again.headCommit('me/site', 'main');
  blobs = 0;
  const none = await again.commit('me/site', { ...base, parent: h2.sha, baseTree: h2.treeSha, skipIfUnchanged: true });
  assert.equal(blobs, 0);
  assert.equal(none.unchanged, true);
  assert.equal(none.sha, h2.sha, 'the existing commit holds the files');
  assert.equal(c.sha === h2.sha, true);
});

test('resume: a remembered blob that GitHub no longer has is sent again, not trusted', async () => {
  const server = await repoWorld();
  const net = createNet((url, init) => server.fetch(url, init));
  const store = memory();
  const f = file(1);
  // pretend an earlier run sent this blob to a repository that has since been replaced
  const { gitBlobSha } = await import('../app/github.js');
  store.setItem('blog.webcli.blobs:me/site', JSON.stringify({ [await gitBlobSha(f.content)]: Date.now() }));
  const gh = new GitHub(net, { token: 'github_pat_test', store });
  const head = await gh.headCommit('me/site', 'main');
  const c = await gh.commit('me/site', { branch: 'main', parent: head.sha, baseTree: head.treeSha, files: [f], message: 'x' });
  assert.ok(c.sha);
  assert.ok(server.files('me/site')[f.path], 'the file is there whatever the memory said');
});

test('commit: thousands of text files are a few tree requests, not a blob each, and the chain makes the same tree as the files', async () => {
  const server = await repoWorld();
  const seen = { blobs: 0, trees: 0 };
  const net = createNet(async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && String(url).endsWith('/git/blobs')) seen.blobs++;
    if ((init.method || 'GET') === 'POST' && String(url).endsWith('/git/trees')) seen.trees++;
    return server.fetch(url, init);
  });
  const gh = new GitHub(net, { token: 'github_pat_test' });
  const head = await gh.headCommit('me/site', 'main');
  const files = Array.from({ length: 1500 }, (_, i) => ({ path: `posts/p${String(i).padStart(4, '0')}.md`, content: `# post ${i}\n${'word '.repeat(1000)}\n` })); // ~7.5 MB of text
  files.push({ path: 'images/a.png', content: png(1) });
  files.push({ path: 'big.txt', content: 'x'.repeat(3_500_000) }); // too big for a tree request: its own blob
  const c = await gh.commit('me/site', { branch: 'main', parent: head.sha, baseTree: head.treeSha, files, message: 'many' });
  assert.equal(seen.blobs, 2, 'only the picture and the one oversized file');
  assert.ok(seen.trees >= 5 && seen.trees <= 12, `a few dozen at most, however many files: ${seen.trees}`);
  const after = server.files('me/site');
  assert.equal(Object.keys(after).filter((p) => p.startsWith('posts/')).length, 1500);
  assert.equal(after['posts/p0007.md'].startsWith('# post 7'), true);
  assert.equal(after['big.txt'].length, 3_500_000);
  assert.ok(after['README.md'], 'what was there is kept');

  const h2 = await gh.headCommit('me/site', 'main');
  const again = await gh.commit('me/site', { branch: 'main', parent: h2.sha, baseTree: h2.treeSha, files, message: 'same', skipIfUnchanged: true });
  assert.equal(again.unchanged, true, 'the same files in a chain of trees are the tree the branch already has');
  assert.equal(c.sha === h2.sha, true);
});

test('commit: a tree request GitHub times out is made again in halves, and the result is the same', async () => {
  const server = await repoWorld();
  let posts = 0;
  let timedOut = 0;
  const net = createNet(async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && String(url).endsWith('/git/trees')) {
      posts++;
      const body = JSON.parse(init.body);
      if (body.tree.length > 40) {
        timedOut++;
        return json({ message: "Sorry, your request timed out. It's likely that your input was too large to process." }, 422);
      }
    }
    return server.fetch(url, init);
  });
  const gh = new GitHub(net, { token: 'github_pat_test' });
  const head = await gh.headCommit('me/site', 'main');
  const files = Array.from({ length: 150 }, (_, i) => ({ path: `posts/p${i}.md`, content: `post ${i}` }));
  await gh.commit('me/site', { branch: 'main', parent: head.sha, baseTree: head.treeSha, files, message: 'halves' });
  assert.ok(timedOut >= 1 && posts > timedOut);
  assert.equal(Object.keys(server.files('me/site')).filter((p) => p.startsWith('posts/')).length, 150);
});
