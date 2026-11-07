// The bulk path: a blog of hundreds or thousands of posts is read a hundred files to a request, patiently, with progress and a Stop,
// and what was read is not read again; a repository too big to list in one request is listed a folder at a time; and the plan and
// the commit that follow work the same as for a small blog, because they are the same code.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createNet } from '../app/net.js';
import { BULK_AT, GitHub } from '../app/github.js';
import { executePlan, planChange, planSettings } from '../app/site.js';
import { blogToForm } from '../lib/settings.js';
import { buildSite } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';
import { EX, readDirFiles } from './helpers.js';
import { fakeGitHub } from './fake-github.js';

const dec = new TextDecoder();
const post = (n) => `---\nslug: p${n}\ntitle: Post number ${n}\ndate: 2025-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}\ntags: [${n % 3 === 0 ? 'three' : 'other'}]\nstatus: published\n---\n\nWords of post ${n}.${' More text.'.repeat(n % 5)}\n`;
const posts = (count) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`posts/p${n}.md`, post(n)]));

async function world(count, opts = {}) {
  const base = await readDirFiles(path.join(EX, 'blog'));
  const blog = JSON.parse(dec.decode(base['blog.json']));
  const lock = dec.decode(base['assets.lock.json']);
  const files = { 'blog.json': JSON.stringify({ ...blog, pageSize: 25 }), 'assets.lock.json': lock, ...posts(count) };
  const built = buildSite({ blog: JSON.parse(files['blog.json']), posts: Object.entries(posts(count)).map(([p, text]) => ({ path: p, text })), lock: JSON.parse(lock) });
  assert.deepEqual(built.errors, []);
  const server = fakeGitHub({ 'example/blog': { ...built.files, ...files }, 'example/images': { 'README.md': 'i' } }, opts);
  await server.ready;
  return { server, built, files };
}
const logOf = (server) => server.state['example/blog'].log;
const only = (log, re) => log.filter((l) => re.test(l));
const clientFor = (server, { token = 'github_pat_test', wait = async () => {}, fetch = server.fetch } = {}) => {
  const gh = new GitHub(createNet(fetch), { token, wait });
  gh.wait = wait;
  return gh;
};

test('bulk: 250 posts are read in three GraphQL requests, with no request per post, and progress that ends at the total', async () => {
  const { server, files } = await world(250);
  const gh = clientFor(server);
  const head = await gh.headCommit('example/blog', 'main');
  const tree = await gh.tree('example/blog', head.treeSha);
  const items = Object.keys(files).filter((p) => p.startsWith('posts/')).map((p) => ({ path: p, sha: tree.get(p) }));
  const seen = [];
  gh.onProgress = (what, done, total) => seen.push([what, done, total]);
  const got = await gh.readMany('example/blog', items, { ref: head.sha });
  assert.equal(got.size, 250);
  for (const [p, text] of Object.entries(files).filter(([p]) => p.startsWith('posts/'))) assert.equal(got.get(p), text, p);
  const log = logOf(server);
  assert.deepEqual(only(log, /graphql/), ['POST graphql 100', 'POST graphql 100', 'POST graphql 50']);
  assert.equal(only(log, /^GET (contents|git\/blobs)/).length, 0, 'not one request per post');
  assert.ok(seen.length >= 3 && seen.every(([w, d, t]) => w === 'Reading' && t === 250 && d <= 250));
  assert.deepEqual(seen.map((s) => s[1]), [...seen.map((s) => s[1])].sort((a, b) => a - b), 'never goes backwards');
  assert.deepEqual(seen[seen.length - 1], ['Reading', 250, 250]);
  assert.equal(gh.patient, false, 'patience is only for the length of the job');
});

test('bulk: what was read is not read again; a file that changed is the only one asked for', async () => {
  const { server, files } = await world(130);
  const gh = clientFor(server);
  const read = async () => {
    const head = await gh.headCommit('example/blog', 'main');
    const tree = await gh.tree('example/blog', head.treeSha);
    const paths = Object.keys(files).filter((p) => p.startsWith('posts/'));
    return gh.readMany('example/blog', paths.map((p) => ({ path: p, sha: tree.get(p) })), { ref: head.sha });
  };
  await read();
  const before = logOf(server).length;
  await read();
  assert.deepEqual(logOf(server).slice(before).filter((l) => /graphql|contents|blobs/.test(l)), [], 'the second read touches no file');
  // one post is edited elsewhere: one request, for that one
  const S = server.state['example/blog'];
  const t = S.trees[S.commits[S.branches.main].tree];
  const bytes = new TextEncoder().encode(post(7).replace('Words', 'Edited words'));
  const { gitBlobSha } = await import('../app/github.js');
  t.set('posts/p7.md', { bytes, sha: await gitBlobSha(bytes) });
  const mark = logOf(server).length;
  const again = await read();
  assert.match(again.get('posts/p7.md'), /Edited words/);
  assert.deepEqual(logOf(server).slice(mark).filter((l) => /graphql|contents|blobs/.test(l)), ['GET git/blobs/' + t.get('posts/p7.md').sha]);
});

test('bulk: a short list is read by blob, not by GraphQL; a missing file is absent, not an error', async () => {
  const { server, files } = await world(5);
  const gh = clientFor(server);
  const head = await gh.headCommit('example/blog', 'main');
  const tree = await gh.tree('example/blog', head.treeSha);
  const got = await gh.readMany('example/blog', [{ path: 'posts/p1.md', sha: tree.get('posts/p1.md') }, { path: 'posts/gone.md', sha: 'e'.repeat(40) }], { ref: head.sha });
  assert.equal(got.get('posts/p1.md'), files['posts/p1.md']);
  assert.ok(!got.has('posts/gone.md'));
  assert.equal(only(logOf(server), /graphql/).length, 0);
});

test('bulk: GraphQL not available to the token: every file is read by blob, and GraphQL is not asked again', async () => {
  const { server, files } = await world(60, { graphql: false });
  const gh = clientFor(server);
  const head = await gh.headCommit('example/blog', 'main');
  const tree = await gh.tree('example/blog', head.treeSha);
  const items = Object.keys(files).filter((p) => p.startsWith('posts/')).map((p) => ({ path: p, sha: tree.get(p) }));
  const got = await gh.readMany('example/blog', items, { ref: head.sha });
  assert.equal(got.size, 60);
  assert.equal(gh.noGraphql, true);
  assert.equal(only(logOf(server), /^GET git\/blobs/).length, 60);
  const gh2 = clientFor(server);
  gh2.noGraphql = true;
  await gh2.readMany('example/blog', items.map((i, n) => ({ ...i, path: `${i.path}#${n}` })), { ref: head.sha });
  assert.equal(only(logOf(server), /graphql/).length, 0, 'the answer is remembered: no second try');
});

test('bulk: a file GraphQL cuts short, or cannot give as text, is read by blob instead', async () => {
  const { server, files } = await world(30, { graphqlCutoff: 120 });
  const gh = clientFor(server);
  const head = await gh.headCommit('example/blog', 'main');
  const tree = await gh.tree('example/blog', head.treeSha);
  const items = Object.keys(files).filter((p) => p.startsWith('posts/')).map((p) => ({ path: p, sha: tree.get(p) }));
  const got = await gh.readMany('example/blog', items, { ref: head.sha });
  for (const i of items) assert.equal(got.get(i.path), files[i.path], `${i.path} is whole`);
  assert.ok(only(logOf(server), /^GET git\/blobs/).length > 0);
});

test('bulk: without a token the public host is read, a few at a time; no API is touched', async () => {
  const { server, files } = await world(40);
  let live = 0;
  let peak = 0;
  const urls = [];
  const fetch = async (u, o) => {
    urls.push(String(u));
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 2));
    try {
      return await server.fetch(u, o);
    } finally {
      live--;
    }
  };
  const gh = clientFor(server, { token: null, fetch });
  const items = Object.keys(files).filter((p) => p.startsWith('posts/')).map((p) => ({ path: p, sha: 'a'.repeat(40) }));
  const got = await gh.readMany('example/blog', items, { ref: 'main', concurrency: 5 });
  assert.equal(got.size, 40);
  assert.ok(peak <= 5, `at most 5 at once, saw ${peak}`);
  assert.ok(urls.every((u) => u.startsWith('https://raw.githubusercontent.com/')));
});

test('bulk: a long job waits out the rate limit and carries on; a short one fails, as it always did', async () => {
  const { server, files } = await world(BULK_AT + 20, { graphql: false });
  let limited = 0;
  const waits = [];
  const fetch = async (u, o) => {
    if (new URL(u).hostname === 'api.github.com' && /git\/blobs/.test(u) && limited < 2) {
      limited++;
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'retry-after': '30', 'content-type': 'application/json' } });
    }
    return server.fetch(u, o);
  };
  const gh = clientFor(server, { fetch, wait: async (ms) => waits.push(ms) });
  gh.onWait = (s) => waits.push(`waiting ${s}`);
  const head = await gh.headCommit('example/blog', 'main');
  const tree = await gh.tree('example/blog', head.treeSha);
  const items = Object.keys(files).filter((p) => p.startsWith('posts/')).map((p) => ({ path: p, sha: tree.get(p) }));
  assert.ok(items.length > BULK_AT);
  const got = await gh.readMany('example/blog', items, { ref: head.sha });
  assert.equal(got.size, items.length, 'everything came');
  assert.ok(waits.some((w) => typeof w === 'string' && /waiting 3\d/.test(w)), 'it said it was waiting');
  assert.equal(limited, 2);
  // a short read is not patient
  limited = 0;
  const small = clientFor(server, { fetch });
  await assert.rejects(small.readMany('example/blog', items.slice(0, 3), { ref: head.sha }), /rate limit/);
});

test('bulk: Stop ends a read between requests, changes nothing, and says so', async () => {
  const { server, files } = await world(450);
  const gh = clientFor(server);
  const head = await gh.headCommit('example/blog', 'main');
  const tree = await gh.tree('example/blog', head.treeSha);
  const items = Object.keys(files).filter((p) => p.startsWith('posts/')).map((p) => ({ path: p, sha: tree.get(p) }));
  let stop = false;
  gh.isCancelled = () => stop;
  gh.onProgress = (what, done) => {
    if (done >= 100) stop = true;
  };
  await assert.rejects(gh.readMany('example/blog', items, { ref: head.sha }), (e) => e instanceof Refusal && e.code === 'cancelled' && /Nothing was changed/.test(e.detail));
  assert.ok(only(logOf(server), /graphql/).length < 5, 'it stopped asking');
  assert.equal(gh.patient, false);
  assert.ok(logOf(server).every((l) => !/^(POST|PATCH) (git|refs)/.test(l)), 'nothing was written');
});

test('bulk: a repository too big to list in one request is listed a folder at a time', async () => {
  const { server, files } = await world(300, { treeLimit: 400 });
  const gh = clientFor(server);
  const head = await gh.headCommit('example/blog', 'main');
  const walked = await gh.tree('example/blog', head.treeSha);
  const S = server.state['example/blog'];
  const truth = S.trees[head.treeSha];
  assert.equal(walked.size, truth.size);
  for (const [p, e] of truth) assert.equal(walked.get(p), e.sha, p);
  assert.ok(only(logOf(server), /^GET git\/trees/).length > 2, 'one request per folder');
  assert.ok(walked.has('posts/p299.md') && walked.has('tags/three/index.html'));
  // a single folder too big to list at all is refused plainly
  const { server: s2 } = await world(300, { treeLimit: 100 });
  const gh2 = clientFor(s2);
  await assert.rejects(gh2.tree('example/blog', (await gh2.headCommit('example/blog', 'main')).treeSha), /too large to list/);
});

test('bulk: a settings change on a blog of 450 posts reads them in batches, regenerates every page, and commits them in chained trees', async () => {
  const { server, files } = await world(450);
  const gh = clientFor(server);
  const progress = [];
  gh.onProgress = (what, done, total) => progress.push(`${what} ${done}/${total}`);
  const S = server.state['example/blog'];
  const blog = JSON.parse(files['blog.json']);
  const form = { ...blogToForm(blog), title: 'A New Title' };
  const plan = await planSettings(gh, { repo: 'example/blog', branch: 'main', form });
  assert.ok(plan.changes.length > 450, `${plan.changes.length} files change: every page carries the title`);
  assert.equal(only(logOf(server), /^GET contents\/posts/).length, 0);
  assert.deepEqual(only(logOf(server), /graphql/), ['POST graphql 100', 'POST graphql 100', 'POST graphql 100', 'POST graphql 100', 'POST graphql 50']);
  assert.ok(progress.includes('Reading 450/450'));
  const posted = [];
  const before = logOf(server).length;
  const receipt = await executePlan(gh, plan);
  assert.equal(receipt.commits.length, 1, 'one commit: the site is never half changed');
  assert.ok(progress.some((p) => /^Sending 0\/\d+$/.test(p)) && progress.some((p) => /^Sending (\d+)\/\1$/.test(p) && Number(p.match(/\d+/)[0]) === plan.changes.length), 'progress while sending');
  const trees = logOf(server).slice(before).filter((l) => l === 'POST git/trees').length;
  assert.ok(trees >= 2, `${trees} tree requests: files go in chunks, never a request per file`);
  assert.ok(!logOf(server).slice(before).some((l) => l === 'POST git/blobs'), 'no blob per file');
  assert.equal(gh.patient, false);
  // what is on GitHub now is what a full build of the new settings makes
  const now = server.files('example/blog');
  assert.equal(JSON.parse(now['blog.json']).title, 'A New Title');
  const want = buildSite({ blog: JSON.parse(now['blog.json']), posts: Object.entries(files).filter(([p]) => p.startsWith('posts/')).map(([p, text]) => ({ path: p, text })), lock: JSON.parse(files['assets.lock.json']) });
  for (const [p, c] of Object.entries(want.files)) assert.equal(now[p], c, p);
  assert.ok(S.commits);
});

test('bulk: publishing one more post on a big blog reads the newest few and the neighbours, not the blog; the second post reads almost nothing', async () => {
  const { server } = await world(300);
  const gh = clientFor(server);
  const reads = (since) => logOf(server).slice(since).filter((l) => /graphql|contents\/posts|git\/blobs/.test(l));
  const first = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'p300', text: post(300), create: true });
  const firstReads = reads(0);
  assert.ok(firstReads.length <= 2 && firstReads.every((l) => /graphql (\d+)/.test(l) ? Number(/graphql (\d+)/.exec(l)[1]) <= 55 : true), `one batch of the newest posts and their neighbours, not 300: ${firstReads}`);
  assert.ok(first.changes.some((c) => c.path === 'p300/index.html'));
  await executePlan(gh, first);
  const mark = logOf(server).length;
  const second = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'p301', text: post(301), create: true });
  assert.ok(reads(mark).length <= 3, `almost nothing is read again: ${reads(mark)}`);
  assert.ok(second.changes.some((c) => c.path === 'p301/index.html'));
  assert.ok(first.changes.length < 120 && second.changes.length < 120, `a new post changes pages, not the whole site (${second.changes.length})`);
  // what lands is what a full build makes
  await executePlan(gh, second);
  const now = server.files('example/blog');
  const posts_ = Object.entries(now).filter(([p]) => /^posts\//.test(p)).map(([path, text]) => ({ path, text }));
  const want = buildSite({ blog: now['blog.json'], posts: posts_, lock: JSON.parse(now['assets.lock.json']) });
  for (const [p, c] of Object.entries(want.files)) assert.equal(now[p], c, p);
});
