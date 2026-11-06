// The WordPress import, end to end against an in-memory GitHub and an in-memory "old site": pictures are fetched, the
// pre-flight says what will be sent, one commit holds the pictures and one the blogs, and what lands is exactly what
// CI would regenerate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { describePlan } from '../app/site.js';
import { executeImport, fetchImages, planImport, readExport, readSite } from '../app/import.js';
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
  ]);

test('fetching: pictures come from the old site without credentials; what is not a picture, or cannot be read, is a reason and not a crash', async () => {
  const site = oldSite(imageFiles());
  const { net } = await world(site);
  const model = await readExport(WXR);
  const job = planWp(model, { today: '2026-11-06' });
  const seen = [];
  const { fetched, failed } = await fetchImages(net, job.images, { onProgress: (p) => seen.push(p) });
  assert.equal(fetched.size, 3);
  assert.equal(failed.size, 0);
  assert.equal(seen[seen.length - 1].done, 3);
  for (const c of site.calls) {
    assert.equal(c.opts.credentials, 'omit');
    assert.equal(c.opts.referrerPolicy, 'no-referrer');
  }
  assert.ok(net.ledger.read.requests >= 3 && net.ledger.uploaded.bytes === 0, 'reads are counted, nothing is uploaded');

  const bad = oldSite(new Map([
    ['https://old.example.org/wp-content/uploads/2024/05/cat.jpg', { body: new TextEncoder().encode('<html>not an image</html>'.repeat(3)) }],
    ['https://old.example.org/wp-content/uploads/2024/06/dog.jpg', { body: JPG, headers: { 'content-length': String(30 * 1024 * 1024) } }],
  ]));
  const { net: net2 } = await world(bad);
  const r = await fetchImages(net2, job.images);
  assert.equal(r.fetched.size, 0);
  assert.match(r.failed.get('https://old.example.org/wp-content/uploads/2024/05/cat.jpg'), /not a PNG/);
  assert.match(r.failed.get('https://old.example.org/wp-content/uploads/2024/06/dog.jpg'), /more than the 20\.0 MB allowed/);
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
  assert.deepEqual(plan.assetGroups[0].files.map((f) => f.path), ['images/wp/2022/01/My-Unused-Photo.JPG', 'images/wp/2024/05/cat.jpg', 'images/wp/2024/06/dog.jpg']);
  const lines = describePlan(plan);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^3 files, [\d.]+ (B|KB), to github\.com\/me\/site \(main\)$/);
  assert.match(lines[1], /^\d+ files, [\d.]+ (B|KB|MB), to github\.com\/me\/site \(main\)$/);
  assert.match(plan.headline[0], /^2 blogs: 5 posts\/drafts, 2 pages, 3 images/);
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
  assert.deepEqual([...new Set(progress)], ['posts', 'pages', 'media', 'tags', 'categories', 'users'], 'optional resources that are missing are skipped, not fatal');
  assert.ok(hits.some((u) => /posts\?status=publish&per_page=100&page=1/.test(u)));
  await assert.rejects(readSite(net, 'nowhere.example.org'), (e) => e.code === 'bad-wp-site' && /use an export file instead/.test(e.detail));
});
