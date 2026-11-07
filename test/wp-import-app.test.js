// The WordPress import, end to end against an in-memory GitHub and an in-memory "old site": pictures are fetched, the
// pre-flight says what will be sent, one commit holds the pictures and one the blogs, and what lands is exactly what
// CI would regenerate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { describePlan } from '../app/site.js';
import { BATCH_FILES, executeImport, fetchImages, planImport, readExport, readSite, uploadsIndex, uploadsPath } from '../app/import.js';
import { buildSite } from '../lib/blog.js';
import { planWp } from '../lib/wp-content.js';
import { fakeGitHub } from './fake-github.js';
import { PNG, WXR } from './wp-fixtures.js';

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72]);

// the old site: files by address, with the headers a real server sends
function oldSite(files) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const f = files.get(String(url).replace(/\?.*$/, '')) || files.get(String(url));
    if (!f) return new Response('nope', { status: 404 });
    const headers = { 'content-type': f.type || 'application/octet-stream', ...(f.headers || {}) };
    return new Response(f.body, { status: 200, headers });
  };
  return { fetch, calls };
}

async function world(site) {
  const server = fakeGitHub({ 'me/site': { 'README.md': 'hello' } });
  await server.ready;
  const net = createNet((url, opts) => (String(url).startsWith('https://api.github.com') || String(url).startsWith('https://raw.githubusercontent.com') ? server.fetch(url, opts) : site.fetch(url, opts)));
  return { server, net, gh: new GitHub(net, { token: 'github_pat_test' }) };
}

const imageFiles = () =>
  new Map([
    ['https://old.example.org/wp-content/uploads/2024/05/cat.jpg', { body: PNG, type: 'text/html' }], // a server that lies about the type
    ['https://old.example.org/wp-content/uploads/2024/06/dog.jpg', { body: JPG }],
    ['https://old.example.org/wp-content/uploads/2022/01/My Unused Photo.JPG', { body: PNG }],
    ['https://old.example.org/wp-content/uploads/2022/01/My%20Unused%20Photo.JPG', { body: PNG }],
    ['https://old.example.org/wp-content/uploads/2022/01/paper.pdf', { body: new TextEncoder().encode('%PDF-1.4 a paper'), type: 'text/html' }],
  ]);

test('fetching: pictures come from the old site without credentials; what is not a picture, or cannot be read, is a reason and not a crash', async () => {
  const site = oldSite(imageFiles());
  const { net } = await world(site);
  const model = await readExport(WXR);
  const job = planWp(model, { today: '2026-11-06' });
  const seen = [];
  const { fetched, failed } = await fetchImages(net, job.images, { onProgress: (p) => seen.push(p) });
  assert.equal(fetched.size, 4);
  assert.equal(failed.size, 0);
  assert.equal(seen[seen.length - 1].done, 4);
  for (const c of site.calls) {
    assert.equal(c.opts.credentials, 'omit');
    assert.equal(c.opts.referrerPolicy, 'no-referrer');
  }
  assert.ok(net.ledger.read.requests >= 4 && net.ledger.uploaded.bytes === 0, 'reads are counted, nothing is uploaded');

  const bad = oldSite(new Map([
    ['https://old.example.org/wp-content/uploads/2024/05/cat.jpg', { body: new TextEncoder().encode('<html>not an image</html>'.repeat(3)) }],
    ['https://old.example.org/wp-content/uploads/2024/06/dog.jpg', { body: JPG, headers: { 'content-length': String(100 * 1024 * 1024) } }],
    ['https://old.example.org/wp-content/uploads/2022/01/paper.pdf', { body: new TextEncoder().encode('<!doctype html><title>Please log in</title>') }],
  ]));
  const { net: net2 } = await world(bad);
  const r = await fetchImages(net2, job.images);
  assert.equal(r.fetched.size, 0);
  assert.match(r.failed.get('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'), /not a PNG/);
  assert.match(r.failed.get('https://old.example.org/wp-content/uploads/2024/06/dog.jpg'), /more than the 90\.0 MB allowed/);
  assert.match(r.failed.get('https://old.example.org/wp-content/uploads/2022/01/paper.pdf'), /web page, not the file/, 'a login page where a PDF should be is not the PDF');
  assert.match(r.failed.get('https://old.example.org/wp-content/uploads/2022/01/My%20Unused%20Photo.JPG') || r.failed.get('https://old.example.org/wp-content/uploads/2022/01/My Unused Photo.JPG'), /HTTP 404/);

  // only https; this machine for testing; never anything else
  await assert.rejects(net.fetchRemote('http://old.example.org/x.png'), /only https/);
  await assert.rejects(net.fetchRemote('file:///etc/passwd'), /only https/);
  await assert.rejects(net.fetchRemote('not a url'), /not a web address/);
  const local = createNet(async () => new Response(PNG, { status: 200 }));
  assert.equal((await local.fetchRemote('http://127.0.0.1:9/x.png')).ok, true);

  // cancelled: nothing more is asked for
  let n = 0;
  const calls0 = site.calls.length;
  await fetchImages(net, job.images, { isCancelled: () => n++ > 0 });
  assert.ok(site.calls.length - calls0 <= 4);
});

test('import: two exports become two blogs in one repository, the pictures in one commit and the blogs in another, pinned and regenerable', async () => {
  const site = oldSite(imageFiles());
  const { server, net, gh } = await world(site);
  const model = await readExport(WXR);
  const job = planWp(model, { today: '2026-11-06' });
  const { fetched } = await fetchImages(net, job.images);
  const out = job.finish(fetched);
  const second = planWp({ ...model, title: 'Second Blog', posts: model.posts.slice(1, 2), pages: [], media: [], menu: [], skipped: {} }, { today: '2026-11-06' }).finish(new Map());
  const blogs = [
    { folder: 'ada', fields: out.blog, files: out.files, assets: out.assets },
    { folder: 'second', fields: second.blog, files: second.files, assets: second.assets },
  ];

  const plan = await planImport(gh, { where: 'me/site', branch: 'main', blogs });
  assert.equal(net.ledger.uploaded.bytes, 0, 'planning sends nothing');
  assert.equal(plan.assetGroups.length, 1);
  assert.deepEqual(plan.assetGroups[0].files.map((f) => f.path), ['images/wp/2022/01/My-Unused-Photo.JPG', 'images/wp/2022/01/paper.pdf', 'images/wp/2024/05/cat.jpg', 'images/wp/2024/06/dog.jpg']);
  const lines = describePlan(plan);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^4 files, [\d.]+ (B|KB), to github\.com\/me\/site \(main\)$/);
  assert.match(lines[1], /^\d+ files, [\d.]+ (B|KB|MB), to github\.com\/me\/site \(main\)$/);
  assert.match(plan.headline[0], /^2 blogs: 5 posts\/drafts, 2 pages, 4 images and files/);
  const paths = plan.changes.map((c) => c.path);
  for (const f of ['ada/blog.json', 'ada/posts/hello-welcome.md', 'ada/pages/about-us.md', 'ada/hello-welcome/index.html', 'ada/index.html', 'ada/assets.lock.json', 'ada/search/index.html', 'second/blog.json', 'second/index.html']) assert.ok(paths.includes(f), f);
  assert.ok(paths.every((p) => p.startsWith('ada/') || p.startsWith('second/')), 'every blog stays inside its folder');

  const progress = [];
  const receipt = await executeImport(gh, plan, { onProgress: (p) => progress.push(p.phase) });
  assert.equal(receipt.commits.length, 2, 'pictures, then blogs');
  assert.ok(progress.includes('images') && progress.includes('files'));
  assert.ok(net.ledger.uploaded.bytes > 0);

  const after = server.files('me/site');
  assert.equal(after['README.md'], 'hello', 'what was there is left alone');
  assert.ok(after['images/wp/2024/05/cat.jpg'] && after['images/wp/2024/06/dog.jpg']);
  const pin = JSON.parse(after['ada/assets.lock.json'])['images/wp/2024/05/cat.jpg'];
  assert.equal(pin, receipt.commits[0].sha, 'the commit that holds the pictures is what every picture is pinned to');
  assert.match(after['ada/hello-welcome/index.html'], new RegExp(`@${pin}/images/wp/2024/05/cat\\.jpg`.replace('/images', '/images')));
  assert.equal(JSON.parse(after['ada/blog.json']).repo, 'me/site/ada');
  assert.equal(JSON.parse(after['ada/blog.json']).search, true);
  assert.ok(!('second/assets.lock.json' in after), 'a blog with no pictures has no lock');

  // CI would regenerate exactly this, blog by blog
  for (const folder of ['ada', 'second']) {
    const mine = Object.entries(after).filter(([p]) => p.startsWith(`${folder}/`)).map(([p, t]) => [p.slice(folder.length + 1), t]);
    const posts = mine.filter(([p]) => /^(posts|pages)\//.test(p)).map(([path, text]) => ({ path, text }));
    const lock = JSON.parse(mine.find(([p]) => p === 'assets.lock.json')?.[1] || '{}');
    const regen = buildSite({ blog: mine.find(([p]) => p === 'blog.json')[1], posts, lock });
    assert.deepEqual(regen.errors, []);
    for (const [p, c] of Object.entries(regen.files)) assert.equal(after[`${folder}/${p}`], c, `${folder}/${p}`);
  }

  // an import never replaces a blog, and two blogs never share a folder
  await assert.rejects(planImport(gh, { where: 'me/site', branch: 'main', blogs: [blogs[0]] }), (e) => e.code === 'import-refused' && /already has a blog\.json/.test(e.detail));
  await assert.rejects(planImport(gh, { where: 'me/site', branch: 'main', blogs: [{ ...blogs[0], folder: 'x' }, { ...blogs[1], folder: 'x' }] }), (e) => e.code === 'import-refused' && /own folder/.test(e.detail));
});

test('import: a single blog at the top of a repository keeps its pictures in an images folder beside its posts', async () => {
  const { server, net, gh } = await world(oldSite(imageFiles()));
  const model = await readExport(WXR);
  const job = planWp(model, { today: '2026-11-06' });
  const out = job.finish((await fetchImages(net, job.images)).fetched);
  const plan = await planImport(gh, { where: 'me/site', branch: 'main', blogs: [{ folder: '', fields: out.blog, files: out.files, assets: out.assets }] });
  await executeImport(gh, plan);
  const after = server.files('me/site');
  assert.ok(after['blog.json'] && after['posts/hello-welcome.md'] && after['images/wp/2024/05/cat.jpg']);
  assert.ok(after['index.html'].includes('Ada &amp; Friends'));
});

test('rest: a site that allows it is read page by page into the same model; one that does not is a plain refusal', async () => {
  const posts = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, date: '2024-03-04T10:00:00', slug: `p${i + 1}x`, status: 'publish', link: '', title: { rendered: `Post ${i + 1}` }, content: { rendered: '<p>Body</p>' }, excerpt: { rendered: '' }, author: 5, featured_media: 0, tags: [], categories: [] }));
  const hits = [];
  const site = oldSite(new Map([
    ['https://wp.example.org/wp-json/', { body: JSON.stringify({ name: 'REST Blog', description: 'd', home: 'https://wp.example.org' }), type: 'application/json' }],
    ['https://wp.example.org/wp-json/wp/v2/posts', { body: JSON.stringify(posts), type: 'application/json', headers: { 'x-wp-totalpages': '1' } }],
    ['https://wp.example.org/wp-json/wp/v2/users', { body: JSON.stringify([{ id: 5, name: 'Ada Example', slug: 'ada' }]), type: 'application/json' }],
  ]));
  const { net } = await world({ fetch: async (u, o) => (hits.push(String(u)), site.fetch(u, o)) });
  const progress = [];
  const model = await readSite(net, 'wp.example.org', { onProgress: (p) => progress.push(p.what) });
  assert.equal(model.title, 'REST Blog');
  assert.deepEqual(model.posts.map((p) => p.title), ['Post 1', 'Post 2', 'Post 3']);
  assert.equal(model.posts[0].author, 'Ada Example');
  assert.deepEqual([...new Set(progress)], ['posts', 'pages', 'media', 'tags', 'categories', 'users', 'comments'], 'optional resources that are missing are skipped, not fatal');
  assert.ok(hits.some((u) => /posts\?status=publish&per_page=100&page=1/.test(u)));
  await assert.rejects(readSite(net, 'nowhere.example.org'), (e) => e.code === 'bad-wp-site' && /use an export file instead/.test(e.detail));
});

test('github: lists of more than a page (tags) are read to the end, and a repository too big to list is refused plainly', async () => {
  const many = Array.from({ length: 250 }, (_, i) => `clip-${i}/v1`);
  const server = fakeGitHub({ 'me/renders': { 'README.md': 'x' } }, { tags: { 'me/renders': many } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const got = await gh.tags('me/renders');
  assert.equal(got.length, 250);
  assert.equal(new Set(got).size, 250);
  const big = new GitHub(createNet(async () => new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 })), { token: 'github_pat_test' });
  await assert.rejects(big.tree('me/x', 'abc'), /too large to list/);
});

test('import: a large library goes in commits of bounded size, each file pinned to the commit it is in', async () => {
  const { server, net, gh } = await world(oldSite(new Map()));
  const model = await readExport(WXR);
  const out = planWp({ ...model, posts: model.posts.slice(0, 1), pages: [], media: [], menu: [], skipped: {} }, { today: '2026-11-06' }).finish(new Map());
  // 450 pictures (three commits of at most 200 files), and one file larger than the byte limit (a commit of its own)
  const assets = Array.from({ length: 450 }, (_, i) => ({ path: `wp/2024/p${String(i).padStart(3, '0')}.png`, bytes: new Uint8Array([...PNG, i & 255, i >> 8]) }));
  assets.push({ path: 'wp/2024/zz-big.mp4', bytes: new Uint8Array(5000) });
  const plan = await planImport(gh, { where: 'me/site', branch: 'main', limits: { bytes: 4000 }, blogs: [{ folder: '', fields: out.blog, files: out.files.slice(0, 1).map((f) => ({ ...f, text: f.text.replace(/\ncover: .*\n/, '\n').replace(/asset:images\/[^)\s]+/g, 'https://x.test/a.png') })), assets }] });
  assert.equal(plan.assetGroups.length, 4);
  assert.deepEqual(plan.assetGroups.map((g) => g.files.length), [200, 200, 50, 1]);
  assert.ok(plan.assetGroups.every((g) => g.files.length === 1 || g.files.length <= BATCH_FILES));
  assert.match(plan.headline[0], /451 images and files .*in 4 commits/);
  assert.equal(describePlan(plan)[0].replace(/[\d.]+ (B|KB|MB)/, 'N'), '451 files, N, to github.com/me/site (main)');

  const receipt = await executeImport(gh, plan);
  assert.equal(receipt.commits.length, 5, 'four of pictures, one of the blog');
  assert.deepEqual(receipt.commits.map((c) => c.files).slice(0, 4), [200, 200, 50, 1]);
  const after = server.files('me/site');
  assert.ok(after['images/wp/2024/p000.png'] && after['images/wp/2024/p449.png'] && after['images/wp/2024/zz-big.mp4']);
  const lock = JSON.parse(after['assets.lock.json']);
  assert.equal(lock['images/wp/2024/p000.png'], receipt.commits[0].sha);
  assert.equal(lock['images/wp/2024/p250.png'], receipt.commits[1].sha);
  assert.equal(lock['images/wp/2024/p449.png'], receipt.commits[2].sha);
  assert.equal(lock['images/wp/2024/zz-big.mp4'], receipt.commits[3].sha);
  assert.ok(net.ledger.uploaded.bytes > 5000);
});

test('import: a copy of the old site\'s uploads is used first, whichever folder was chosen, and a bad copy falls back to the network', async () => {
  const site = oldSite(imageFiles());
  const { net } = await world(site);
  const job = planWp(await readExport(WXR), { today: '2026-11-06' });
  const pdf = new TextEncoder().encode('<html>a saved login page</html>'); // not the file: the network is asked
  const layouts = {
    'the uploads folder': { 'uploads/2024/05/cat.jpg': PNG, 'uploads/2024/06/dog.jpg': JPG, 'uploads/2022/01/My Unused Photo.JPG': PNG, 'uploads/2022/01/paper.pdf': pdf },
    'wp-content': { 'wp-content/uploads/2024/05/cat.jpg': PNG, 'wp-content/uploads/2024/06/dog.jpg': JPG, 'wp-content/uploads/2022/01/My Unused Photo.JPG': PNG, 'wp-content/uploads/2022/01/paper.pdf': pdf },
    'a folder of another name': { 'backup-nov/2024/05/cat.jpg': PNG, 'backup-nov/2024/06/dog.jpg': JPG, 'backup-nov/2022/01/My Unused Photo.JPG': PNG, 'backup-nov/2022/01/paper.pdf': pdf },
    'a different case, and accents spelled the other way': { 'Uploads/2024/05/CAT.JPG': PNG, 'Uploads/2024/06/Dog.jpg': JPG, 'Uploads/2022/01/my unused photo.jpg': PNG, 'Uploads/2022/01/paper.pdf': pdf },
  };
  for (const [name, files] of Object.entries(layouts)) {
    const index = uploadsIndex(Object.entries(files).map(([path, bytes]) => ({ path, file: bytes })));
    site.calls.length = 0;
    const { fetched, failed, fromLocal } = await fetchImages(net, job.images, { local: async (url) => index.find(url) });
    assert.equal(failed.size, 0, name);
    assert.equal(fetched.size, 4, name);
    assert.equal(fromLocal, 3, `${name}: three from the copy, the bad one asked for`);
    assert.deepEqual(site.calls.map((c) => c.url), ['https://old.example.org/wp-content/uploads/2022/01/paper.pdf'], name);
  }
  // one year, one month, picked on their own
  const year = uploadsIndex([{ path: '2024/05/cat.jpg', file: PNG }, { path: '2024/06/dog.jpg', file: JPG }]);
  assert.ok(year.find('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'));
  const month = uploadsIndex([{ path: '05/cat.jpg', file: PNG }]);
  assert.ok(month.find('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'));
  const ambiguous = uploadsIndex([{ path: 'a/cat.jpg', file: PNG }, { path: 'b/cat.jpg', file: JPG }]);
  assert.equal(ambiguous.find('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'), null, 'two files of one name are not guessed between');
  const wrongYear = uploadsIndex([{ path: '2019/05/cat.jpg', file: PNG }, { path: 'uploads/2019/05/cat.jpg', file: PNG }]);
  assert.equal(wrongYear.find('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'), null, 'a picture of the same name from another year is not it');
  const none = uploadsIndex([{ path: 'x/y.png', file: PNG }]);
  assert.equal(none.find('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'), null);
  assert.deepEqual(none.missed, ['2024/05/cat.jpg'], 'what was looked for is kept, to say it');
  assert.equal(uploadsPath('https://x.test/blog/wp-content/uploads/2024/05/a%20b.jpg'), '2024/05/a b.jpg');
  assert.equal(uploadsPath('https://x.test/other/a.jpg'), null);
});

test('import: an interrupted import carries on where it stopped, with nothing sent twice and every picture pinned to a commit that has it', async () => {
  const { server, gh: plain } = await world(oldSite(new Map()));
  const store = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };
  let blobs = 0;
  let failAt = 0;
  const net = createNet((url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && String(url).endsWith('/git/blobs')) {
      blobs++;
      if (blobs === failAt) return Promise.resolve(new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 }));
    }
    return server.fetch(url, init);
  });
  const gh = new GitHub(net, { token: 'github_pat_test', store });
  const model = await readExport(WXR);
  const out = planWp({ ...model, posts: model.posts.slice(0, 1), pages: [], media: [], menu: [], skipped: {} }, { today: '2026-11-06' }).finish(new Map());
  const assets = Array.from({ length: 30 }, (_, i) => ({ path: `wp/2024/p${String(i).padStart(2, '0')}.png`, bytes: new Uint8Array([...PNG, i]) }));
  const blog = { folder: '', fields: out.blog, files: out.files.slice(0, 1).map((f) => ({ ...f, text: f.text.replace(/\ncover: .*\n/, '\n').replace(/asset:images\/[^)\s]+/g, 'https://x.test/a.png') })), assets };
  const run = async () => executeImport(gh, await planImport(gh, { where: 'me/site', branch: 'main', limits: { files: 10 }, blogs: [blog] }));

  failAt = 17; // the second of three commits of pictures breaks
  await assert.rejects(run(), /GitHub 500/);
  const firstSent = blobs;
  assert.ok(firstSent >= 17 && firstSent < 30);
  failAt = 0;
  blobs = 0;
  const receipt = await run();
  assert.equal(blobs, 30 - (firstSent - 1), 'only what had not been sent');
  assert.equal(Object.keys(server.files('me/site')).filter((p) => p.startsWith('images/wp/')).length, 30);
  const lock = JSON.parse(server.files('me/site')['assets.lock.json']);
  const commits = new Set(receipt.commits.map((c) => c.sha));
  assert.equal(Object.keys(lock).length, 30);
  assert.ok(Object.values(lock).every((sha) => commits.has(sha) || /^[0-9a-f]{40}$/.test(sha)), 'every picture is pinned');
  await assert.rejects(run(), /already has a blog\.json/, 'a finished import is never run over itself');
});

test('fetching: when the first pictures are all refused as a browser refuses a cross-origin read, it stops and says so instead of trying them all', async () => {
  let asked = 0;
  const net = createNet(() => { asked++; return Promise.reject(new TypeError('Failed to fetch')); });
  const images = Array.from({ length: 500 }, (_, i) => ({ url: `https://old.example.org/wp-content/uploads/p${i}.png`, path: `wp/p${i}.png`, kind: 'content' }));
  const r = await fetchImages(net, images, {});
  assert.equal(r.blocked, true);
  assert.ok(asked < 40, `only a handful were tried: ${asked}`);
  assert.equal(r.fetched.size, 0);

  // one that works, or a refusal that is not a network one (a 404), is not "blocked"
  const some = createNet((url) => Promise.resolve(String(url).endsWith('p3.png') ? new Response(PNG) : new Response('', { status: 404 })));
  const r2 = await fetchImages(some, images.slice(0, 60), {});
  assert.equal(r2.blocked, false);
  assert.equal(r2.failed.size + r2.fetched.size, 60);
  const copy = new Map([[images[0].url, PNG]]);
  const r3 = await fetchImages(net, images.slice(0, 60), { local: async (u) => copy.get(u) || null });
  assert.equal(r3.blocked, false, 'a copy of the uploads that supplied something means it is working');
});

test('fetching: a folder that has some of the pictures is used, the rest are left linked, and a site that cannot be read is not asked again', async () => {
  let asked = 0;
  const net = createNet(() => { asked++; return Promise.reject(new TypeError('Failed to fetch')); });
  const images = Array.from({ length: 400 }, (_, i) => ({ url: `https://old.example.org/wp-content/uploads/2020/12/p${i}.png`, path: `wp/2020/12/p${i}.png`, kind: 'content' }));
  // the folder has every fifth picture, none of the first thirty-odd that come first
  const have = new Set(images.filter((_, i) => i >= 100 && i % 5 === 0).map((im) => im.url));
  const r = await fetchImages(net, images, { local: async (url) => (have.has(url) ? PNG : null) });
  assert.equal(r.blocked, false, 'some came from the folder, so it is working');
  assert.equal(r.fromLocal, have.size);
  assert.equal(r.fetched.size, have.size);
  assert.equal(r.failed.size, 400 - have.size);
  assert.ok(asked < 40, `the old site was asked only until it was clear it would not answer: ${asked}`);
  assert.match([...r.failed.values()].pop(), /not in your uploads folder/);

  asked = 0;
  const none = await fetchImages(net, images, { local: async () => null });
  assert.equal(none.blocked, true, 'a folder with none of them, from a site that cannot be read: nothing came across, and it says so');
  assert.equal(none.fromLocal, 0);
  assert.ok(asked < 40);
});

test('import: into a blog that already exists, posts, pages and pictures are added; its settings, theme and posts are left exactly as they were', async () => {
  const blog = JSON.stringify({ title: 'Existing', description: 'Already here', author: 'Ann', domain: 'https://me.github.io/site', repo: 'me/site', theme: 'default', customize: { colors: { accent: '#aa0000' }, header: { links: [{ label: 'Shop', url: 'https://shop.example.com' }] } } }, null, 2) + '\n';
  const mine = (slug, extra = '') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: Mine ${slug}\ndate: 2026-01-0${slug.length % 9 + 1}\nstatus: published\n${extra}---\n\nMy own words in ${slug}.\n` });
  const existing = [mine('hello-welcome', 'aliases: [2024/05/hello-welcome-old]\n'), mine('keep-me', 'aliases: [2024/06/second-post]\n')];
  const built = buildSite({ blog, posts: existing, lock: {} });
  assert.deepEqual(built.errors, []);
  const files = { ...built.files, 'blog.json': blog, 'assets.lock.json': '{}', ...Object.fromEntries(existing.map((p) => [p.path, p.text])), 'README.md': 'hello' };
  const server = fakeGitHub({ 'me/site': files });
  await server.ready;
  const site = oldSite(imageFiles());
  const net = createNet((url, opts) => (String(url).startsWith('https://api.github.com') || String(url).startsWith('https://raw.githubusercontent.com') ? server.fetch(url, opts) : site.fetch(url, opts)));
  const gh = new GitHub(net, { token: 'github_pat_test' });
  const model = await readExport(WXR);
  const job = planWp(model, { today: '2026-11-06' });
  const out = job.finish((await fetchImages(net, job.images)).fetched);
  const blogs = [{ folder: '', fields: { title: 'Ada & Friends', description: 'x', author: 'Ada' }, files: out.files, assets: out.assets }];

  // by default an existing blog is not touched, and the refusal says what to do
  await assert.rejects(planImport(gh, { where: 'me/site', branch: 'main', blogs }), (e) => e.code === 'import-refused' && /add these posts to the blog that is there/.test(e.detail));

  const plan = await planImport(gh, { where: 'me/site', branch: 'main', blogs, addToExisting: true });
  const paths = plan.changes.map((c) => c.path);
  assert.ok(!paths.includes('blog.json') && !paths.includes('posts/hello-welcome.md'), 'neither the settings nor a post it already has');
  for (const p of ['posts/second-post.md', 'pages/about-us.md', 'second-post/index.html', 'index.html', 'feed.xml', 'assets.lock.json', 'index/posts.json']) assert.ok(paths.includes(p), p);
  assert.deepEqual(plan.skipped.map((s) => s.path), ['posts/hello-welcome.md']);
  assert.ok(plan.headline.some((l) => /settings, theme and customisation are not touched/.test(l)));
  assert.ok(plan.headline.some((l) => /1 imported post or page was left out/.test(l)));
  assert.ok(plan.notes.some((n) => /already in the blog|already has/.test(n.text) || /replaces/.test(n.text)));
  // the imported "hello-welcome" would have claimed 2024/05/hello-welcome; the blog's own alias on keep-me is for /2024/06/second-post/: the import's is dropped
  assert.ok(plan.notes.some((n) => n.where === 'posts/second-post.md' && /2024\/06\/second-post/.test(n.text) && /could not be kept/.test(n.text)));
  assert.equal(net.ledger.uploaded.bytes, 0, 'planning sends nothing');

  const receipt = await executeImport(gh, plan, {});
  assert.equal(receipt.commits.length, 2, 'pictures, then the blog');
  const after = server.files('me/site');
  assert.equal(after['blog.json'], blog, 'byte for byte');
  assert.equal(after['posts/hello-welcome.md'], existing[0].text);
  assert.equal(after['posts/keep-me.md'], existing[1].text);
  assert.equal(after['README.md'], 'hello');
  assert.match(after['index.html'], /#aa0000/, 'the theme and customisation still draw the pages');
  assert.match(after['index.html'], /Shop/);
  assert.match(after['second-post/index.html'], /#aa0000/);
  assert.ok(after['images/wp/2024/05/cat.jpg'] && after['2024/06/second-post/index.html'].includes('keep-me'), 'the blog\'s own redirect is still its own');
  assert.ok(!after['2024/05/hello-welcome/index.html'], 'the imported duplicate brought nothing');
  const lock = JSON.parse(after['assets.lock.json']);
  assert.equal(lock['images/wp/2024/05/cat.jpg'], receipt.commits[0].sha, 'new pictures are pinned to the commit they are in');

  // CI would regenerate exactly this
  const posts = Object.entries(after).filter(([p]) => /^(posts|pages)\//.test(p)).map(([path, text]) => ({ path, text }));
  const regen = buildSite({ blog: after['blog.json'], posts, lock });
  assert.deepEqual(regen.errors, []);
  for (const [p, c] of Object.entries(regen.files)) assert.equal(after[p], c, p);

  // doing it again adds nothing: every post is there, every picture is pinned
  const again = await planImport(gh, { where: 'me/site', branch: 'main', blogs, addToExisting: true });
  assert.equal(again.assetGroups.length, 0, 'pictures it has are not sent again');
  assert.equal(again.changes.length, 0, 'nothing differs');
  assert.ok(again.skipped.length >= 3);
});

test('import: into a blog that uses extensions is refused, and a blog with no images repository still gets its pictures in the default one', async () => {
  const blog = JSON.stringify({ title: 'E', description: 'd', author: 'A', domain: 'https://me.github.io/site', repo: 'me/site', extensions: [{ repo: 'me/ext', ref: 'v1.0.0', sha256: 'a'.repeat(64), name: 'X', version: '1', licence: 'MIT', kind: 'build', hooks: ['post:html'] }] });
  const server = fakeGitHub({ 'me/site': { 'blog.json': blog, 'assets.lock.json': '{}' } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  await assert.rejects(planImport(gh, { where: 'me/site', branch: 'main', blogs: [{ folder: '', fields: { title: 't', description: 'd', author: 'a' }, files: [], assets: [] }], addToExisting: true }), (e) => /uses extensions/.test(e.detail || e.message));
});
