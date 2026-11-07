// R10: the generator and the client renderer cannot drift unnoticed. For every post of a golden corpus the page the generator
// writes (lib/blog.js, run in Node from source) and the page the browser rebuilds (the browser bundle of lib/live-render.js,
// built here with esbuild for the browser platform and loaded as a separate module) are compared after the committed normaliser
// (test/normalise.js). A post that markdown cannot express is refused by both, with the same code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite, parsePost } from '../lib/blog.js';
import { collectAssetRefs, parseAssetRef } from '../lib/assets.js';
import { EX, corpus } from './helpers.js';
import { normalise } from './normalise.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(root, 'test', 'golden');
const enc = new TextEncoder();
// posts the corpus holds on purpose to be refused, and the code both renderers must refuse them with
const REFUSED = { 'lossy-fence': 'lossy-round-trip', 'html-script': 'bad-html' };

// the client, as a browser would run it: its own bundle, sharing no module instance with the generator
let client;
async function browserRenderer() {
  if (client) return client;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'client-'));
  const out = path.join(dir, 'client.mjs');
  await build({
    stdin: { contents: "export { loadSite, renderFromSite, CannotRebuild } from './lib/live-render.js';", resolveDir: root, sourcefile: 'client-entry.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: out,
    logLevel: 'silent',
  });
  client = await import(pathToFileURL(out).href);
  return client;
}

async function goldenPosts() {
  const names = (await fs.readdir(GOLDEN)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(names.map(async (n) => ({ path: `posts/${n}`, text: await fs.readFile(path.join(GOLDEN, n), 'utf8') })));
}

async function blogFor(posts) {
  const blog = { ...JSON.parse(await fs.readFile(path.join(EX, 'blog', 'blog.json'), 'utf8')), content: { base: 'https://content.test/{owner}/{repo}/{ref}/{path}' } };
  const lock = {};
  for (const p of posts) {
    try {
      const post = parsePost(p);
      for (const ref of collectAssetRefs(post.delta, post.meta)) {
        const { key, path: file } = parseAssetRef(ref);
        lock[`${key}/${file}`] = 'b'.repeat(40);
      }
    } catch {
      /* a post that is refused has no references to pin */
    }
  }
  for (const k of Object.keys(JSON.parse(await fs.readFile(path.join(EX, 'blog', 'assets.lock.json'), 'utf8')))) lock[k] = 'c'.repeat(40);
  return { blog, lock };
}

// what the repository holds after a publish: the generated files, the source and the pins
const repoOf = (blog, lock, posts, files) => {
  const map = new Map(Object.entries(files));
  map.set('blog.json', JSON.stringify(blog));
  map.set('assets.lock.json', JSON.stringify(lock));
  for (const p of posts) map.set(p.path, p.text);
  return async (p) => (map.has(p) ? enc.encode(map.get(p)) : null);
};
const slugOf = (p) => p.path.replace(/^posts\/|\.md$/g, '');

test('R10: the golden corpus covers the awkward cases the work order names', async () => {
  const names = (await goldenPosts()).map(slugOf);
  for (const need of ['nested-lists', 'fence-with-html', 'footnote-shaped', 'table-shaped', 'raw-html', 'asset-refs', 'embed', 'unicode', 'wordpress-shortcodes', 'lossy-fence', 'html-script']) assert.ok(names.includes(need), need);
});

test('R10: the golden posts are canonical markdown (a refusal is the one thing the corpus holds on purpose)', async () => {
  for (const p of await goldenPosts()) {
    if (slugOf(p) in REFUSED) continue;
    assert.equal(parsePost(p).lossy, null, `${p.path} is canonical, so what it tests is the renderer, not the refusal`);
  }
});

test('R10: generator and client output are identical after normalisation, for every post of the golden corpus', async () => {
  const { loadSite, renderFromSite } = await browserRenderer();
  const all = await goldenPosts();
  const posts = all.filter((p) => !(slugOf(p) in REFUSED));
  const { blog, lock } = await blogFor(posts);
  const r = buildSite({ blog, posts, lock });
  assert.deepEqual(r.errors, [], r.errors.map((e) => e.detail).join('\n'));
  const site = await loadSite(repoOf(blog, lock, posts, r.files));
  let compared = 0;
  for (const p of posts) {
    const slug = slugOf(p);
    const made = r.files[`${slug}/index.html`];
    assert.ok(made, `${slug} was generated`);
    const rebuilt = renderFromSite(site, { slug, text: p.text }).html;
    assert.equal(normalise(rebuilt), normalise(made), slug);
    compared++;
  }
  assert.ok(compared >= 9, `${compared} posts compared`);
  const tables = r.files['table-shaped/index.html'];
  assert.match(tables, /<table><thead><tr><th align="left">Name<\/th>/);
  assert.match(r.files['raw-html/index.html'], /<details>\n<summary>More<\/summary>/);
  assert.doesNotMatch(r.files['raw-html/index.html'], /never shown/, 'a comment is source only');
});

test('R10: the same for every published post of the example blog and the shared test corpus', async () => {
  const { loadSite, renderFromSite } = await browserRenderer();
  const posts = [];
  for (const { name, text } of await corpus()) {
    const p = { path: `posts/${name}`, text };
    try {
      if (parsePost(p).status === 'published' && !parsePost(p).lossy) posts.push(p);
    } catch {
      /* deliberately not a valid post */
    }
  }
  const { blog, lock } = await blogFor(posts);
  const r = buildSite({ blog, posts, lock });
  assert.deepEqual(r.errors, []);
  const site = await loadSite(repoOf(blog, lock, posts, r.files));
  assert.ok(posts.length >= 6);
  for (const p of posts) assert.equal(normalise(renderFromSite(site, { slug: slugOf(p), text: p.text }).html), normalise(r.files[`${slugOf(p)}/index.html`]), p.path);
});

test('R10: an edited post (a page the live copy is newer than) is rendered as the next build would render it', async () => {
  const { loadSite, renderFromSite } = await browserRenderer();
  const all = (await goldenPosts()).filter((p) => !(slugOf(p) in REFUSED));
  const { blog, lock } = await blogFor(all);
  const site = await loadSite(repoOf(blog, lock, all, buildSite({ blog, posts: all, lock }).files));
  const edited = all.map((p) => (slugOf(p) === 'unicode' ? { ...p, text: `${p.text}\nAnd a new paragraph, written later.\n` } : p));
  const next = buildSite({ blog, posts: edited, lock });
  const post = edited.find((p) => slugOf(p) === 'unicode');
  assert.equal(normalise(renderFromSite(site, { slug: 'unicode', text: post.text }).html), normalise(next.files['unicode/index.html']));
});

test('R10: a post the generator refuses is refused by the client too, with the same code', async () => {
  const { loadSite, renderFromSite, CannotRebuild } = await browserRenderer();
  const all = await goldenPosts();
  const good = all.filter((p) => ['tiny', 'nested-lists'].includes(slugOf(p)));
  for (const [slug, expected] of Object.entries(REFUSED)) {
    const refused = all.find((p) => slugOf(p) === slug);
    const { blog, lock } = await blogFor([refused, ...good]);
    const r = buildSite({ blog, posts: [refused], lock });
    assert.equal(r.errors.length, 1, slug);
    assert.equal(r.errors[0].code, expected, slug);
    assert.equal(r.files[`${slug}/index.html`], undefined, 'nothing is written for a refused post');
    // the live copy has an earlier, valid version of the post (so it is in the index); the edit that is refused arrives on top of it
    const earlier = { ...refused, text: refused.text.replace(/\n\n[^]*$/, '\n\nAn earlier version.\n') };
    const built = buildSite({ blog, posts: [earlier, ...good], lock });
    assert.deepEqual(built.errors, [], slug);
    const site = await loadSite(repoOf(blog, lock, [earlier, ...good], built.files));
    assert.throws(() => renderFromSite(site, { slug, text: refused.text }), (e) => e instanceof CannotRebuild && e.reason === expected, slug);
  }
});

test('R10: the comparison can fail: a client that renders anything differently is caught', async () => {
  const { loadSite, renderFromSite } = await browserRenderer();
  const posts = (await goldenPosts()).filter((p) => ['nested-lists', 'unicode'].includes(slugOf(p)));
  const { blog, lock } = await blogFor(posts);
  const r = buildSite({ blog, posts, lock });
  const site = await loadSite(repoOf(blog, lock, posts, r.files));
  const p = posts.find((x) => slugOf(x) === 'unicode');
  const tampered = renderFromSite(site, { slug: 'unicode', text: p.text.replace('Emoji', 'Emojis') }).html;
  assert.notEqual(normalise(tampered), normalise(r.files['unicode/index.html']));
  assert.notEqual(normalise(tampered.replace('lang="en"', 'lang="fr"')), normalise(r.files['unicode/index.html']));
});
