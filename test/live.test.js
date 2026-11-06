import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildSite, validateBlog } from '../lib/blog.js';
import { contentBase, domainPath, liveEnabled, ownsNotFoundPage, validateContent } from '../lib/content.js';
import { LIVE_SOURCE } from '../lib/live-source.js';
import { CannotRebuild, loadSite, renderFromSite, withNoindex } from '../lib/live-render.js';
import { checkMissing, checkPage, compareVersions, makeGetter, slugFromPath, varyPath, versionOf, VERSION } from '../lib/live.js';
import { collectAssetRefs, parseAssetRef } from '../lib/assets.js';
import { parsePost } from '../lib/blog.js';
import { sha256 } from '../lib/sha256.js';
import { GENERATOR_ID } from '../lib/page.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';
import { filesDigest } from '../lib/pin.js';
import { extensionFilePaths, loadExtension, pinForExtension } from '../lib/extensions.js';
import { buildSiteWith } from '../lib/build-async.js';
import { EX, corpus, localRunner, readDirFiles, stripData } from './helpers.js';

const enc = new TextEncoder();
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, '..');
const BASE = 'https://content.test/example/blog/HEAD/';

const exampleBlog = async (patch = {}) => ({ ...JSON.parse(await fs.readFile(path.join(EX, 'blog', 'blog.json'), 'utf8')), content: { base: 'https://content.test/{owner}/{repo}/{ref}/{path}' }, ...patch });

// the posts of the corpus that are published, with every asset they name pinned
async function inputs(patch = {}) {
  const blog = await exampleBlog(patch);
  const posts = [];
  for (const { name, text } of await corpus()) {
    const path = `posts/${name}`;
    try {
      if (parsePost({ path, text }).status === 'published') posts.push({ path, text });
    } catch {
      /* a corpus file that is deliberately not a valid post */
    }
  }
  const lock = {};
  for (const p of posts) {
    const post = parsePost(p);
    for (const r of collectAssetRefs(post.delta, post.meta)) {
      const { key, path: file } = parseAssetRef(r);
      lock[`${key}/${file}`] = 'b'.repeat(40);
    }
  }
  for (const k of Object.keys(JSON.parse(await fs.readFile(path.join(EX, 'blog', 'assets.lock.json'), 'utf8')))) lock[k] = 'c'.repeat(40);
  return { blog, posts, lock };
}

// what the repository holds after a publish: the generated files, the source and the pins
function live(blog, posts, lock, files) {
  const map = new Map(Object.entries(files));
  map.set('blog.json', JSON.stringify(blog));
  map.set('assets.lock.json', JSON.stringify(lock));
  for (const p of posts) map.set(p.path, p.text);
  return map;
}
const getter = (map, calls = []) => async (p) => {
  calls.push(p);
  const v = map.get(p);
  return v === undefined ? null : enc.encode(v);
};
const build = async (patch, extra = {}) => {
  const { blog, posts, lock } = await inputs(patch);
  const r = buildSite({ blog, posts, lock, ...extra });
  assert.deepEqual(r.errors, [], r.errors.map((e) => e.detail).join('\n'));
  return { blog, posts, lock, r, map: live(blog, posts, lock, r.files) };
};

// ---------- blog.json "content" ----------
test('content: a template that names owner, repo and a final {path}; nothing else', () => {
  const ok = { base: 'https://content.test/{owner}/{repo}/{ref}/{path}' };
  assert.doesNotThrow(() => validateContent(ok, 'me/blog'));
  assert.doesNotThrow(() => validateContent({ ...ok, ref: 'main' }, 'me/blog'));
  for (const [bad, why] of [
    [{}, /base/],
    [{ base: 'ftp://x/{owner}/{repo}/{path}' }, /http/],
    [{ base: 'https://x/{repo}/{path}' }, /\{owner\}/],
    [{ base: 'https://x/{owner}/{repo}/' }, /\{path\}/],
    [{ base: 'https://x/{owner}/{repo}/{path}/more' }, /end with/],
    [{ base: 'https://x/{owner}/{repo}/{nope}/{path}' }, /may only use/],
    [{ ...ok, ref: 'a b' }, /ref/],
    [{ ...ok, extra: 1 }, /not a field/],
  ]) assert.throws(() => validateContent(bad, 'me/blog'), why);
  assert.throws(() => validateContent(ok, undefined), /needs "repo"/);
  assert.throws(() => validateBlog({ title: 't', description: 'd', author: 'a', domain: 'https://x.test', content: ok }), (e) => e.code === 'bad-blog-json');
});

test('content: the base is the blog\'s own folder in the live copy, ending in a slash', () => {
  const b = (repo, content) => ({ repo, content: { base: 'https://content.test/{owner}/{repo}/{ref}/{path}', ...content } });
  assert.equal(contentBase(b('me/blog')), 'https://content.test/me/blog/HEAD/');
  assert.equal(contentBase(b('me/blog', { ref: 'main' })), 'https://content.test/me/blog/main/');
  assert.equal(contentBase(b('me/site/notes')), 'https://content.test/me/site/HEAD/notes/');
  assert.equal(contentBase({ repo: 'me/blog' }), null);
  assert.equal(domainPath({ domain: 'https://me.github.io/blog' }), '/blog');
  assert.equal(domainPath({ domain: 'https://me.example.com' }), '');
  assert.equal(ownsNotFoundPage({ repo: 'me/blog' }), true);
  assert.equal(ownsNotFoundPage({ repo: 'me/site/notes' }), false);
});

// ---------- what the generator writes ----------
test('a blog that says where its live copy is gets the script, a 404 page and the provenance of every page', async () => {
  const { r, posts } = await build();
  assert.equal(r.files['webcli-live.js'], LIVE_SOURCE);
  assert.ok(LIVE_SOURCE.length > 10000, 'the script is really there');
  assert.ok(r.files['404.html']);
  for (const p of posts) {
    const slug = p.path.replace(/^posts\/|\.md$/g, '');
    const html = r.files[`${slug}/index.html`];
    if (!html) continue;
    assert.match(html, new RegExp(`<meta name="x-generator" content="${GENERATOR_ID.replace('.', '\\.')}">`));
    assert.match(html, new RegExp(`<meta name="x-content-sha256" content="${sha256(p.text)}">`), 'the digest of the markdown the page shows');
    assert.match(html, /<meta name="x-content-base" content="https:\/\/content\.test\/example\/blog\/HEAD\/">/);
    assert.match(html, new RegExp(`<meta name="x-webcli-slug" content="${slug}">`));
    assert.match(html, /<script type="module" src="\.\.\/webcli-live\.js"><\/script>\n<\/body>/);
    assert.ok(!/x-source-commit/.test(html), 'a page cannot name the commit that holds it');
  }
  assert.match(r.files['index.html'], /<script type="module" src="\.\/webcli-live\.js"><\/script>/);
  assert.match(r.files['404.html'], /<meta name="robots" content="noindex">/);
  assert.match(r.files['404.html'], /<meta name="x-webcli-page" content="404">/);
  assert.match(r.files['404.html'], /<meta name="x-webcli-root" content="\/blog">/, 'the path the blog is served under');
  assert.match(r.files['404.html'], /<script type="module" src="\/blog\/webcli-live\.js"><\/script>/, 'root-relative: one file answers at any depth');
  assert.match(r.files['404.html'], /data-webcli-notfound/);
});

test('without "content" nothing changes for the reader: no script, no 404 page, no extra file', async () => {
  const { blog, posts, lock } = await inputs();
  delete blog.content;
  const r = buildSite({ blog, posts, lock });
  assert.deepEqual(r.errors, []);
  assert.ok(!('webcli-live.js' in r.files) && !('404.html' in r.files));
  for (const [f, html] of Object.entries(r.files)) if (f.endsWith('.html')) assert.ok(!/<script/i.test(stripData(html)), f);
  const post = Object.entries(r.files).find(([f]) => f === `${r.index[0].slug}/index.html`);
  assert.match(post[1], /<meta name="x-generator"/, 'the build is still recorded');
  assert.match(post[1], /<meta name="x-content-sha256"/);
  assert.ok(!/x-content-base/.test(post[1]));
});

test('a blog in a folder of a repository gets the script but not a 404 page: the repository\'s 404 is not its to write', async () => {
  const { r } = await build({ repo: 'example/site/notes' });
  assert.ok(r.files['webcli-live.js']);
  assert.ok(!('404.html' in r.files));
  assert.match(r.files['index.html'], /x-content-base" content="https:\/\/content\.test\/example\/site\/HEAD\/notes\/"/);
});

test('an embed extension keeps the pages exactly as the build wrote them: its frames are not recorded in blog.json', async () => {
  assert.equal(liveEnabled({ repo: 'a/b', content: { base: 'https://c/{owner}/{repo}/{path}' }, extensions: [{ kind: 'embed', hooks: ['post:html'] }] }), false);
  assert.equal(liveEnabled({ repo: 'a/b', content: { base: 'https://c/{owner}/{repo}/{path}' }, extensions: [{ kind: 'build', hooks: ['post:html'] }] }), true);
});

test('the script a blog ships is the one the sources build to, and the version is one number', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
  let esbuild = null;
  try {
    esbuild = await import('esbuild');
  } catch {
    /* installed with npm install; without it the check is skipped */
  }
  if (!esbuild) return;
  const { TARGETS, buildTarget } = await import('../cli/build-live.js');
  for (const t of TARGETS) {
    const have = await fs.readFile(path.join(root, 'lib', t.out), 'utf8');
    assert.equal(have, await buildTarget(t), `run \`node cli/build-live.js\` and commit lib/${t.out}`);
  }
});

// ---------- L5: one renderer ----------
test('L5: for every published post in the corpus, rebuilding it from the live files is byte-identical to the generator', async () => {
  const { r, posts, map } = await build();
  assert.ok(posts.length >= 4);
  const site = await loadSite(getter(map));
  for (const p of posts) {
    const slug = p.path.replace(/^posts\/|\.md$/g, '');
    const out = renderFromSite(site, { slug, text: p.text });
    assert.equal(out.html, r.files[`${slug}/index.html`], slug);
  }
});

test('L5: the same with a pinned theme and a build extension: licence comment, markup contract, css and recorded outputs', async () => {
  const themeFiles = await readDirFiles(path.join(EX, 'theme-classic'));
  const tm = JSON.parse(new TextDecoder().decode(themeFiles['theme.json']));
  const themePin = pinFor('me/theme', 'v1.0.0', tm, themeDigest(themeFiles, themeFilePaths(tm)));
  const extFiles = await readDirFiles(path.join(EX, 'ext-reading-time'));
  const em = JSON.parse(new TextDecoder().decode(extFiles['extension.json']));
  const extPin = pinForExtension('me/ext', 'v1.0.0', em, filesDigest(extFiles, extensionFilePaths(em), (m) => new Error(m)));
  const theme = loadTheme(themePin, themeFiles);
  const extension = loadExtension(extPin, extFiles);

  const { blog, posts, lock } = await inputs({ theme: themePin, extensions: [extPin] });
  const r = await buildSiteWith({ blog, posts, lock, theme, extensions: [extension], outputs: {} }, localRunner);
  assert.deepEqual(r.errors, []);
  assert.ok(r.files['extension-outputs.json'] && r.files['theme.css']);
  const map = live(blog, posts, lock, r.files);
  const site = await loadSite(getter(map));
  for (const p of posts) {
    const slug = p.path.replace(/^posts\/|\.md$/g, '');
    assert.equal(renderFromSite(site, { slug, text: p.text }).html, r.files[`${slug}/index.html`], slug);
  }
  // an edit whose extension output was not recorded cannot be rebuilt faithfully: it is refused, not guessed
  const edited = posts[0].text.replace(/\n\n/, '\n\nAn extra paragraph that no extension has seen.\n\n');
  assert.throws(() => renderFromSite(site, { slug: posts[0].path.replace(/^posts\/|\.md$/g, ''), text: edited }), (e) => e instanceof CannotRebuild && /extension-output-missing/.test(e.message));
});

// ---------- A: a post page that exists ----------
const firstPost = (posts, r) => posts.find((p) => r.files[`${p.path.replace(/^posts\/|\.md$/g, '')}/index.html`]);

test('L1: a page whose markdown is no longer the live markdown rebuilds as the next build would write it', async () => {
  const { blog, posts, lock, r, map } = await build();
  const p = firstPost(posts, r);
  const slug = p.path.replace(/^posts\/|\.md$/g, '');
  const builtSha = sha256(p.text);
  assert.deepEqual(await checkPage({ base: BASE, slug, builtSha, get: getter(map), storage: null }), { state: 'current' });

  const edited = p.text.replace(/\n\n/, '\n\nThis sentence was published a moment ago.\n\n');
  map.set(p.path, edited);
  const out = await checkPage({ base: BASE, slug, builtSha, pageGenerator: GENERATOR_ID, get: getter(map), storage: null });
  assert.equal(out.state, 'rebuilt');
  assert.ok(out.html.includes('This sentence was published a moment ago.'));
  // and it is exactly what the build that follows produces
  const later = buildSite({ blog, posts: posts.map((x) => (x === p ? { ...x, text: edited } : x)), lock });
  assert.equal(out.html, later.files[`${slug}/index.html`]);
});

test('L7: a page is checked once per session; the second visit makes no request at all', async () => {
  const { posts, r, map } = await build();
  const calls = [];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const p = firstPost(posts, r);
  const slug = p.path.replace(/^posts\/|\.md$/g, '');
  const args = { base: BASE, slug, builtSha: sha256(p.text), get: getter(map, calls), storage };
  assert.equal((await checkPage(args)).state, 'current');
  assert.deepEqual(calls, [`posts/${slug}.md`], 'one file fetch: not the API, not the index, not the rest of the site');
  assert.equal((await checkPage(args)).state, 'skipped');
  assert.equal(calls.length, 1, 'nothing more was asked');
  // a failing network is not asked again either
  const failing = { ...args, slug: 'other', get: async () => { throw new Error('offline'); } };
  assert.equal((await checkPage(failing)).state, 'left');
  assert.equal((await checkPage(failing)).state, 'skipped');
});

test('a draft in the live copy never replaces a page, and an unreachable or missing source leaves it alone', async () => {
  const { posts, r, map } = await build();
  const p = firstPost(posts, r);
  const slug = p.path.replace(/^posts\/|\.md$/g, '');
  const base = { base: BASE, slug, builtSha: sha256(p.text), pageGenerator: GENERATOR_ID, storage: null };
  map.set(p.path, p.text.replace('status: published', 'status: draft'));
  const draft = await checkPage({ ...base, get: getter(map) });
  assert.equal(draft.state, 'left');
  assert.ok(!draft.html);
  map.delete(p.path);
  assert.equal((await checkPage({ ...base, get: getter(map) })).state, 'left');
  assert.equal((await checkPage({ ...base, get: async () => { throw new Error('offline'); } })).state, 'left');
});

test('versions: a script older than the page that loaded it records that and rebuilds nothing; a newer one rebuilds', async () => {
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(versionOf('blog-webcli@1.4.0'), '1.4.0');
  assert.equal(versionOf(''), '');
  const { posts, r, map } = await build();
  const p = firstPost(posts, r);
  const slug = p.path.replace(/^posts\/|\.md$/g, '');
  map.set(p.path, p.text.replace(/\n\n/, '\n\nnew\n\n'));
  const args = { base: BASE, slug, builtSha: sha256(p.text), get: getter(map), storage: null };
  const older = await checkPage({ ...args, pageGenerator: 'blog-webcli@99.0.0' });
  assert.equal(older.state, 'left');
  assert.match(older.why, /built by 99\.0\.0/);
  assert.equal((await checkPage({ ...args, pageGenerator: 'blog-webcli@0.0.1' })).state, 'rebuilt');
});

// ---------- B: 404.html ----------
test('slugFromPath: exactly one segment under the blog\'s root, and a slug', () => {
  assert.equal(slugFromPath('/blog/new-post/', '/blog'), 'new-post');
  assert.equal(slugFromPath('/blog/new-post', '/blog'), 'new-post');
  assert.equal(slugFromPath('/blog/new-post/index.html', '/blog'), 'new-post');
  assert.equal(slugFromPath('/new-post/', ''), 'new-post');
  for (const no of ['/blog/', '/blog', '/other/new-post/', '/blog/a/b/', '/blog/New_Post/', '/blog/new-post/x.png', '/blog/posts/..%2f']) assert.equal(slugFromPath(no, '/blog'), null, no);
});

test('L2: a new post, with no page yet, is rendered at its address from the live copy', async () => {
  const { blog, posts, lock, r, map } = await build();
  const fresh = { path: 'posts/just-published.md', text: '---\nslug: just-published\ntitle: Just published\ndate: 2026-11-06\nstatus: published\n---\n\nThis was committed a minute ago.\n' };
  // the commit holds the post and the regenerated files; the Pages build has not run, so there is no page
  const after = buildSite({ blog, posts: [...posts, fresh], lock });
  const liveMap = live(blog, [...posts, fresh], lock, { ...after.files });
  const pagesNow = new Set(Object.keys(r.files));
  assert.ok(!pagesNow.has('just-published/index.html'), 'the deployed site does not have it');
  const out = await checkMissing({ pathname: '/blog/just-published/', root: '/blog', get: getter(liveMap) });
  assert.equal(out.state, 'rebuilt');
  assert.ok(out.html.includes('This was committed a minute ago.') && out.html.includes('Just published'));
  // exactly the page the build will write, plus the one marker that says this answer is a 404
  assert.equal(out.html, withNoindex(after.files['just-published/index.html']));
  // the same files, with nothing new in them: not found
  const none = await checkMissing({ pathname: '/blog/never-was/', root: '/blog', get: getter(map) });
  assert.equal(none.state, 'missing');
});

test('L4: a soft-rendered page says noindex; the page the build writes does not', async () => {
  const { blog, posts, lock } = await build();
  const fresh = { path: 'posts/another.md', text: '---\nslug: another\ntitle: Another\ndate: 2026-11-06\nstatus: published\n---\n\nBody.\n' };
  const after = buildSite({ blog, posts: [...posts, fresh], lock });
  const out = await checkMissing({ pathname: '/blog/another/', root: '/blog', get: getter(live(blog, [...posts, fresh], lock, after.files)) });
  assert.equal(out.state, 'rebuilt');
  assert.match(out.html, /<meta name="robots" content="noindex">\n<\/head>/);
  assert.ok(!/name="robots"/.test(after.files['another/index.html']), 'once built, the real page is indexable');
});

test('L3: a draft never soft-renders, whatever the index says, and is in no index', async () => {
  const { blog, posts, lock } = await build();
  const draft = { path: 'posts/secret.md', text: '---\nslug: secret\ntitle: Secret\ndate: 2026-11-06\nstatus: draft\n---\n\nNot yet.\n' };
  const after = buildSite({ blog, posts: [...posts, draft], lock });
  assert.ok(!JSON.parse(after.files['index/posts.json']).posts.some((e) => e.slug === 'secret'), 'drafts are not in the index');
  assert.ok(!('secret/index.html' in after.files));
  const map = live(blog, [...posts, draft], lock, after.files);
  assert.equal((await checkMissing({ pathname: '/blog/secret/', root: '/blog', get: getter(map) })).state, 'missing');
  // an index that is stale or wrong (it lists the slug as published) does not override the file itself
  const lying = JSON.parse(map.get('index/posts.json'));
  lying.posts.push({ slug: 'secret', title: 'Secret', date: '2026-11-06', tags: [], excerpt: '', status: 'published' });
  map.set('index/posts.json', JSON.stringify(lying));
  const out = await checkMissing({ pathname: '/blog/secret/', root: '/blog', get: getter(map) });
  assert.equal(out.state, 'missing');
  assert.ok(!out.html);
});

test('a published post that cannot be rebuilt here is not reported as missing: the page says it is on its way', async () => {
  const { blog, posts, lock } = await build();
  const fresh = { path: 'posts/coming.md', text: '---\nslug: coming\ntitle: Coming\ndate: 2026-11-06\nstatus: published\n---\n\nBody.\n' };
  const after = buildSite({ blog, posts: [...posts, fresh], lock });
  const map = live(blog, [...posts, fresh], lock, after.files);
  map.delete('licences.json');
  const out = await checkMissing({ pathname: '/blog/coming/', root: '/blog', get: getter(map) });
  assert.equal(out.state, 'pending');
});

// ---------- L6, L9: what the script is allowed to do ----------
test('L6: a request is a plain GET of a file, with no credentials, and the URL is cache-busted', async () => {
  const seen = [];
  const get = makeGetter('https://content.test/example/blog/HEAD/', async (url, init) => {
    seen.push({ url, init });
    return { status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  }, { now: () => 1234, rand: () => 0.9 }); // 0.9: never encode, so the addresses read plainly
  await get('posts/x.md');
  await get('index/posts.json');
  assert.deepEqual(seen.map((s) => s.url), ['https://content.test/example/blog/HEAD/posts/x.md?t=1234', 'https://content.test/example/blog/HEAD/index/posts.json?t=1234']);
  for (const s of seen) {
    assert.equal(s.init.credentials, 'omit');
    assert.equal(s.init.cache, 'no-store');
    assert.equal(s.init.headers, undefined, 'no Authorization or any other header of ours');
    assert.equal(s.init.method, undefined, 'a GET');
  }
  assert.ok(!/api\.github\.com|authorization|bearer|github_pat|ghp_|sessionStorage\.getItem\(["']blog\.webcli\.token/i.test(LIVE_SOURCE), 'the script knows no API and holds no token');
});

test('L9: no provider hostname is built into the generator or the script: the content base is blog.json\'s', async () => {
  for (const f of ['lib/live.js', 'lib/live-render.js', 'lib/live-entry.js', 'lib/content.js', 'lib/page.js']) {
    const src = await fs.readFile(path.join(root, f), 'utf8');
    assert.ok(!/githubusercontent|github\.io|jsdelivr|api\.github|\.github\.com/i.test(src.replace(/\/\/.*$/gm, '')), `${f} names a provider`);
  }
  assert.ok(!/raw\.githubusercontent|api\.github/i.test(LIVE_SOURCE), 'neither does the shipped script');
  // change the base in blog.json and every page and the 404 follow it, with no code change
  const { r } = await build({ content: { base: 'https://elsewhere.test/{owner}/{repo}/{ref}/{path}', ref: 'main' } });
  assert.match(r.files['404.html'], /x-content-base" content="https:\/\/elsewhere\.test\/example\/blog\/main\/"/);
  assert.ok(!/content\.test/.test(r.files['404.html']));
});

test('the script has no way to run text as code, load another script or write to GitHub', () => {
  for (const [re, what] of [[/\beval\s*\(/, 'eval'], [/new Function\s*\(/, 'new Function'], [/createElement\(\s*["']script["']/, 'creating a script'], [/importScripts|document\.write\s*\(/, 'importScripts/document.write'], [/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/i, 'a write request'], [/localStorage/, 'localStorage']]) {
    assert.ok(!re.test(LIVE_SOURCE), `the live script has ${what}`);
  }
});

test('X1 for a live blog: the only script on any page is the one same-origin module file; no inline script, no handler', async () => {
  const { r } = await build();
  const htmls = Object.entries(r.files).filter(([f]) => f.endsWith('.html'));
  assert.ok(htmls.length >= 3);
  // the home page, the posts and 404.html carry the script; the generated listings (tags, archive) carry none
  const carrying = (f) => f === 'index.html' || f === '404.html' || /^[a-z0-9-]+\/index\.html$/.test(f) && !/^(tags|archive|authors|search|page)\//.test(f);
  for (const [f, page] of htmls) {
    const html = stripData(page);
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    assert.equal(scripts.length, carrying(f) ? 1 : 0, `${f}: ${scripts.join(' ')}`);
    if (scripts.length) assert.match(scripts[0], /^<script type="module" src="(?:\.\.\/|\.\/|\/blog\/)webcli-live\.js"><\/script>|^<script type="module" src="[^":]+webcli-live\.js">$/, f);
    assert.ok(!/<script[^>]*>[^<]+<\/script>/i.test(html), `${f}: inline script`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${f}: an event handler`);
    assert.ok(!/<noscript/i.test(html), f);
    assert.ok(!/javascript:/i.test(html), f);
  }
});

test('B3 for a live blog: the post is whole in the HTML itself; the script only ever replaces it with newer text', async () => {
  const { r, posts } = await build();
  const p = firstPost(posts, r);
  const slug = p.path.replace(/^posts\/|\.md$/g, '');
  const html = r.files[`${slug}/index.html`];
  assert.match(html, /<h1[^>]*>[^<]+<\/h1>/);
  assert.ok(html.includes(parsePost(p).meta.title.replace(/&/g, '&amp;')));
});

test('the file path is requested in a randomly chosen, equivalent spelling, so a cached copy is rarely the one asked for', () => {
  // alternately kept and encoded: p o s t s / a b - 1 . m d -> p %6F s %74 s / %61 b %2D 1 . %6D d
  let k = 0;
  assert.equal(varyPath('posts/ab-1.md', () => [0.9, 0.1][k++ % 2]), 'p%6Fs%74s/%61b%2D1.%6Dd');
  for (let i = 0; i < 200; i++) {
    const v = varyPath('index/posts.json', Math.random);
    assert.equal(decodeURIComponent(v), 'index/posts.json', `${v} means the same file`);
    assert.ok(!/%2[Ff]|%2[Ee]|%5[Ff]/.test(v), `${v}: "/", "." and "_" stay as they are`);
    assert.equal(v.split('/').length, 2, 'the structure of the path is untouched');
  }
  const seen = new Set(Array.from({ length: 300 }, () => varyPath('posts/hello.md', Math.random)));
  assert.ok(seen.size > 100, `${seen.size} different spellings of one file`);
  assert.equal(varyPath('posts/x.md', () => 0.9), 'posts/x.md', 'rand decides, nothing else');
  assert.equal(varyPath('a.b', () => 0.1), '%61.%62');
});
