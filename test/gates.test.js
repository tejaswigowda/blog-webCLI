import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSite, renderPost, parsePost } from '../lib/blog.js';
import { setMeta, parseMeta, splitFile } from '../lib/frontmatter.js';
import { Refusal } from '../lib/errors.js';
import { serve } from '../cli/serve.js';
import { corpus } from './helpers.js';

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'cli', 'blog.js');
const EXAMPLE = path.join(root, 'examples', 'blog');

async function tmpBlog() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-'));
  await fs.cp(EXAMPLE, d, { recursive: true });
  return d;
}
const cli = (cmd, dir) => run('node', [CLI, cmd, dir]).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
const walk = async (dir, base = dir) => {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p));
  }
  return out.sort();
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const exampleInputs = async () => {
  const blog = await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8');
  const lock = JSON.parse(await fs.readFile(path.join(EXAMPLE, 'assets.lock.json'), 'utf8'));
  const posts = [];
  for (const f of await fs.readdir(path.join(EXAMPLE, 'posts'))) posts.push({ path: `posts/${f}`, text: await fs.readFile(path.join(EXAMPLE, 'posts', f), 'utf8') });
  return { blog, lock, posts };
};

test('B1: posts are markdown with frontmatter; no Delta is stored', async () => {
  for (const { name, text } of await corpus()) {
    assert.ok(text.startsWith('---\n'), `${name} lacks frontmatter`);
    parseMeta(splitFile(text, name).front, name);
  }
  const files = await walk(EXAMPLE);
  for (const f of files.filter((f) => f.startsWith('posts/'))) assert.ok(f.endsWith('.md'), `${f} is not markdown`);
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const t = await fs.readFile(path.join(EXAMPLE, f), 'utf8');
    assert.ok(!/"ops"\s*:/.test(t), `${f} looks like a Delta`);
  }
});

test('B3: curl on a published post returns its full text with scripting disabled', async () => {
  const d = await tmpBlog();
  assert.equal((await cli('build', d)).code, 0);
  const server = await serve(d);
  try {
    const url = `http://127.0.0.1:${server.address().port}/static-hls-in-git/`;
    const { stdout: html } = await run('curl', ['-s', '--fail', url]);
    const post = await fs.readFile(path.join(EXAMPLE, 'posts', 'static-hls-in-git.md'), 'utf8');
    assert.ok(!/<script|<noscript|onload=|onerror=/i.test(html), 'page must not need scripting');
    for (const phrase of ['HLS is a playlist and a pile of segments', 'Why it works', 'Segments never change once written, so they cache forever.', 'Hosting is a', 'A reference that names no provider is a reference you can move.', 'seg-000.ts', 'Read more at']) {
      assert.ok(html.includes(phrase), `missing: ${phrase}`);
    }
    // every word of the body is present, once tags are stripped
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const words = splitFile(post, 'x').body.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[`*_#>\\[\]()!-]|https?:\S+|asset:\S+|\.\.\/|^\d\./gm, ' ').split(/\s+/).filter((w) => /^[A-Za-z]{4,}$/.test(w));
    for (const w of words) assert.ok(text.includes(w), `word "${w}" missing from served page`);
  } finally {
    server.close();
  }
});

test('B4: every generated page carries OG and twitter tags with absolute urls', async () => {
  const { files } = buildSite(await exampleInputs());
  const pages = Object.keys(files).filter((f) => f.endsWith('.html'));
  assert.equal(pages.length, 3);
  for (const f of pages) {
    const h = files[f];
    for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) assert.match(h, new RegExp(`<meta property="${tag}" content="[^"]+">`), `${f} lacks ${tag}`);
    assert.match(h, /<meta name="twitter:card" content="summary_large_image">/, f);
    assert.match(h, /<meta name="description" content="[^"]+">/, f);
    assert.match(h, /<meta property="og:image" content="https:\/\/[^"]+">/, f);
    assert.match(h, /<meta property="og:url" content="https:\/\/example\.github\.io\/blog\/[^"]*">/, f);
  }
  assert.match(files['static-hls-in-git/index.html'], /og:image" content="https:\/\/cdn\.jsdelivr\.net\/gh\/example\/images@3{40}\/hls-cover\.png"/);
  // a post with no cover falls back to the blog cover
  assert.match(files['markdown-is-the-format/index.html'], /og:image" content="[^"]*default-cover\.png"/);
});

test('B5: feed.xml is generated and valid Atom', async () => {
  const { files } = buildSite(await exampleInputs());
  const feed = files['feed.xml'];
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'feed-'));
  await fs.writeFile(path.join(d, 'feed.xml'), feed);
  const x = await run('xmllint', ['--noout', path.join(d, 'feed.xml')]).then(() => 'ok', (e) => (e.code === 'ENOENT' ? 'no-xmllint' : Promise.reject(e)));
  assert.ok(x === 'ok' || x === 'no-xmllint');
  assert.match(feed, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  for (const el of ['id', 'title', 'updated']) assert.match(feed.split('<entry>')[0], new RegExp(`<${el}>`));
  const entries = feed.split('<entry>').slice(1);
  assert.equal(entries.length, 2);
  const ids = new Set();
  for (const e of entries) {
    for (const el of ['id', 'title', 'updated', 'author', 'content type="html"']) assert.ok(e.includes(`<${el}`), `entry lacks ${el}`);
    assert.match(e, /<updated>\d{4}-\d{2}-\d{2}T00:00:00Z<\/updated>/);
    ids.add(/<id>([^<]+)<\/id>/.exec(e)[1]);
  }
  assert.equal(ids.size, 2);
  assert.ok(feed.includes('<link rel="self" type="application/atom+xml" href="https://example.github.io/blog/feed.xml"/>'));
});

test('B6: no provider hostname appears in any .md file; naming one is refused', async () => {
  const hosts = ['jsdelivr', 'githubusercontent', 'unpkg.com', 'githack'];
  for (const { name, text } of await corpus()) for (const h of hosts) assert.ok(!text.includes(h), `${name} names ${h}`);
  const input = await exampleInputs();
  const bad = { ...input, posts: [{ path: 'posts/tiny.md', text: '---\nslug: tiny\ntitle: T\ndate: 2026-01-01\nstatus: published\n---\n\n![x](https://cdn.jsdelivr.net/gh/a/b@main/x.png)\n' }] };
  const r = buildSite(bad);
  assert.deepEqual(r.errors.map((e) => e.code), ['provider-url']);
});

test('B7: changing the asset base and regenerating changes no post source', async () => {
  const d = await tmpBlog();
  const before = {};
  for (const f of await fs.readdir(path.join(d, 'posts'))) before[f] = sha(await fs.readFile(path.join(d, 'posts', f)));
  assert.equal((await cli('build', d)).code, 0);
  const built = await fs.readFile(path.join(d, 'static-hls-in-git', 'index.html'), 'utf8');
  const bj = JSON.parse(await fs.readFile(path.join(d, 'blog.json'), 'utf8'));
  bj.assets.base = 'https://assets.example.org/{owner}/{repo}/{sha}/{path}';
  bj.video.base = 'https://video.example.org/{owner}/{repo}/{tag}/{slug}/';
  await fs.writeFile(path.join(d, 'blog.json'), JSON.stringify(bj, null, 2) + '\n');
  assert.equal((await cli('build', d)).code, 0);
  const rebuilt = await fs.readFile(path.join(d, 'static-hls-in-git', 'index.html'), 'utf8');
  assert.notEqual(built, rebuilt);
  assert.ok(built.includes('cdn.jsdelivr.net') && !built.includes('assets.example.org'));
  assert.ok(rebuilt.includes('https://assets.example.org/example/images/3333333333333333333333333333333333333333/hls-cover.png') && !rebuilt.includes('jsdelivr'));
  assert.ok(rebuilt.includes('#https://video.example.org/example/renders/hls-demo/v1/hls-demo/&amp;present=true'), 'video base follows blog.json too');
  for (const f of await fs.readdir(path.join(d, 'posts'))) assert.equal(sha(await fs.readFile(path.join(d, 'posts', f))), before[f], `${f} changed`);
});

test('B7b: pinned urls — replacing an image later does not change a published page', async () => {
  const input = await exampleInputs();
  const a = buildSite(input).files['static-hls-in-git/index.html'];
  const b = buildSite({ ...input, lock: { ...input.lock, 'images/unrelated.png': '9'.repeat(40) } }).files['static-hls-in-git/index.html'];
  assert.equal(a, b);
  assert.ok(a.includes('images@2222222222222222222222222222222222222222'));
});

test('B8: generated output is CI-checked and fails on any diff', async () => {
  const d = await tmpBlog();
  assert.equal((await cli('build', d)).code, 0);
  assert.equal((await cli('check', d)).code, 0, 'fresh build must pass');

  // source edited, output not regenerated
  const pp = path.join(d, 'posts', 'markdown-is-the-format.md');
  const orig = await fs.readFile(pp, 'utf8');
  await fs.writeFile(pp, orig.replace('every tool in the world', 'every tool on earth'));
  const r1 = await cli('check', d);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /differs\s+markdown-is-the-format\/index\.html/);
  assert.match(r1.stderr, /differs\s+feed\.xml/);
  await fs.writeFile(pp, orig);
  assert.equal((await cli('check', d)).code, 0);

  // hand-edited output
  await fs.appendFile(path.join(d, 'index.html'), '<!-- hand edit -->');
  assert.equal((await cli('check', d)).code, 1);
  assert.equal((await cli('build', d)).code, 0);

  // stale page for a post that no longer exists
  await fs.rm(pp);
  const r2 = await cli('check', d);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /stale\s+markdown-is-the-format\/index\.html/);
  assert.equal((await cli('build', d)).code, 0);
  assert.ok(!(await walk(d)).includes('markdown-is-the-format/index.html'));
});

test('B9: drafts appear in no index, page or feed', async () => {
  const d = await tmpBlog();
  assert.equal((await cli('build', d)).code, 0);
  const files = (await walk(d)).filter((f) => !f.startsWith('posts/'));
  assert.ok(!files.some((f) => f.includes('unfinished-thoughts')));
  for (const f of files) {
    const t = await fs.readFile(path.join(d, f), 'utf8');
    assert.ok(!/SECRET-DRAFT-MARKER|unfinished-thoughts|Unfinished thoughts/.test(t), `${f} leaks the draft`);
  }
  const draft = parsePost({ path: 'posts/unfinished-thoughts.md', text: await fs.readFile(path.join(d, 'posts', 'unfinished-thoughts.md'), 'utf8') });
  assert.throws(() => renderPost({}, draft, {}), (e) => e instanceof Refusal && e.code === 'draft-in-publish');
});

test('B10: renaming a post title does not change its URL', async () => {
  const input = await exampleInputs();
  const first = buildSite(input);
  const p = input.posts.find((p) => p.path.endsWith('static-hls-in-git.md'));
  const { front, body } = splitFile(p.text, p.path);
  const renamed = '---\n' + setMeta(front, 'title', 'A completely different title') + '---\n\n' + body;
  assert.ok(renamed.includes('slug: static-hls-in-git      # set once, never changes'), 'slug line and its comment are preserved verbatim');
  const second = buildSite({ ...input, posts: input.posts.map((x) => (x === p ? { ...x, text: renamed } : x)) });
  assert.deepEqual(Object.keys(first.files).sort(), Object.keys(second.files).sort(), 'same set of URLs');
  const page = second.files['static-hls-in-git/index.html'];
  assert.match(page, /<h1>A completely different title<\/h1>/);
  assert.match(page, /og:url" content="https:\/\/example\.github\.io\/blog\/static-hls-in-git\/"/);
  assert.equal(second.index.find((e) => e.slug === 'static-hls-in-git').title, 'A completely different title');
});

test('index is ordered by authored date, not by file order', async () => {
  const input = await exampleInputs();
  const r = buildSite({ ...input, posts: [...input.posts].reverse() });
  assert.deepEqual(r.index.map((e) => e.slug), ['static-hls-in-git', 'markdown-is-the-format']);
  assert.deepEqual(r.index.map((e) => e.status), ['published', 'published']);
});

test('G: refusal codes', async () => {
  const input = await exampleInputs();
  const post = (name, text) => ({ path: `posts/${name}.md`, text });
  const fm = (slug, extra = '') => `---\nslug: ${slug}\ntitle: T\ndate: 2026-01-01\nstatus: published\n${extra}---\n\nbody\n`;
  const codes = (posts, lock = input.lock) => buildSite({ ...input, posts, lock }).errors.map((e) => e.code);

  assert.deepEqual(codes([post('a', 'no frontmatter\n')]), ['missing-frontmatter']);
  assert.deepEqual(codes([post('a', '---\nslug: a\ntitle: T\n---\n\nbody\n')]), ['missing-frontmatter']);
  assert.deepEqual(codes([post('a', fm('b'))]), ['slug-mismatch']);
  assert.deepEqual(codes([post('index', fm('index'))]), ['slug-collision']);
  assert.deepEqual(codes([post('a', fm('a')), post('b', fm('a'))]).sort(), ['slug-collision', 'slug-mismatch']);
  assert.deepEqual(codes([post('a', fm('a', 'cover: asset:images/nope.png\n'))]), ['unresolved-asset']);
  assert.deepEqual(codes([post('a', fm('a').replace('body', '![x](asset:nokey/x.png)'))]), ['unresolved-asset']);
  assert.deepEqual(codes([post('a', fm('a').replace('body', 'wrapped\nline'))]), ['lossy-round-trip']);
  assert.deepEqual(codes([post('a', fm('a').replace('body', '[x](javascript:alert)'))]), ['unsafe-url']);
  assert.deepEqual(codes([post('a', fm('a').replace('2026-01-01', '2026-13-45'))]), ['bad-frontmatter']);
  assert.deepEqual(codes([post('a', fm('a').replace('published', 'live'))]), ['bad-frontmatter']);
  // a draft that is not canonical does not block the blog, but warns
  const warn = buildSite({ ...input, posts: [post('a', fm('a').replace('published', 'draft').replace('body', 'wrapped\nline'))] });
  assert.equal(warn.errors.length, 0);
  assert.equal(warn.warnings.length >= 1, true);
  // refusal means no partial output
  const refused = buildSite({ ...input, posts: [...input.posts, post('zzz', 'oops')] });
  assert.deepEqual(refused.files, {});

  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));
  const r = await cli('build', empty);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused: no-blog-json/);
  assert.throws(() => buildSite({ ...input, blog: '{"title":"x"}' }), (e) => e.code === 'bad-blog-json');
});

test('XSS: raw html and script urls in a post never reach the output', async () => {
  const input = await exampleInputs();
  const text = '---\nslug: x\ntitle: "<script>alert(1)</script>"\ndate: 2026-01-01\nstatus: published\n---\n\n\\<script>alert(1)\\</script> \\<img src=x onerror=alert(1)>\n\n[ok](https://example.com/?a=1&b="2")\n';
  const r = buildSite({ ...input, posts: [{ path: 'posts/x.md', text }] });
  assert.equal(r.errors.length, 0, r.errors.map((e) => e.message).join());
  const page = r.files['x/index.html'];
  assert.ok(!page.includes('<script>alert') && !page.includes('<img src=x'));
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(r.files['feed.xml'].includes('&lt;') );
});

test('video: a post embeds a release by reference; the page carries the pinned player url', async () => {
  const input = await exampleInputs();
  const post = input.posts.find((p) => p.path.endsWith('static-hls-in-git.md'));
  assert.ok(post.text.includes('![](video:videos/hls-demo@v1)'));
  assert.ok(!/strataeditor|jsdelivr/.test(post.text), 'source names no provider');
  const page = buildSite(input).files['static-hls-in-git/index.html'];
  const src = 'https://strataeditor.dev/player/#https://cdn.jsdelivr.net/gh/example/renders@hls-demo/v1/hls-demo/&amp;present=true';
  assert.ok(page.includes(`<iframe src="${src}"`));
  assert.ok(page.includes(`<a href="${src}" rel="noopener noreferrer">Watch: hls-demo v1</a>`), 'a text link survives with scripting off');
  assert.match(page, /sandbox="allow-scripts allow-same-origin"/);
  assert.ok(!/<script/i.test(page));
});

test('video: refusals', async () => {
  const input = await exampleInputs();
  const fm = (body) => `---\nslug: v\ntitle: T\ndate: 2026-01-01\nstatus: published\n---\n\n${body}\n`;
  const codes = (body, blog = input.blog) => {
    try {
      return buildSite({ ...input, blog, posts: [{ path: 'posts/v.md', text: fm(body) }] }).errors.map((e) => e.code);
    } catch (e) {
      return [e.code];
    }
  };
  assert.deepEqual(codes('![](video:videos/clip@v2)'), [], 'a well-formed reference builds');
  assert.deepEqual(codes('![](video:nokey/clip@v1)'), ['unresolved-asset']);
  assert.deepEqual(codes('![](video:videos/Clip@v1)'), ['lossy-round-trip'], 'name must follow hls-webCLI slug rules');
  assert.deepEqual(codes('![](video:videos/clip@latest)'), ['lossy-round-trip'], 'only a pinned vN is accepted');
  assert.deepEqual(codes('text ![](video:videos/clip@v1) inline'), ['lossy-round-trip'], 'must stand alone');
  assert.deepEqual(codes('![alt](video:videos/clip@v1)'), ['lossy-round-trip'], 'no alt text: the editor cannot hold it');
  assert.deepEqual(codes('![](https://strataeditor.dev/player/#x)'), ['provider-url'] );
  assert.deepEqual(codes('[watch](https://strataeditor.dev/player/#https://cdn.jsdelivr.net/gh/a/b@c/v1/c/)'), ['provider-url']);
  const noVideo = JSON.parse(input.blog);
  delete noVideo.video;
  assert.deepEqual(codes('![](video:videos/clip@v1)', JSON.stringify(noVideo)), ['unresolved-asset']);
  const badCfg = JSON.parse(input.blog);
  badCfg.video.player = 'http://insecure.example/player/';
  assert.throws(() => buildSite({ ...input, blog: JSON.stringify(badCfg) }), (e) => e.code === 'bad-blog-json');
  badCfg.video.player = 'https://strataeditor.dev/player/';
  badCfg.video.base = 'https://cdn.example/{owner}/{repo}@{tag}';
  assert.throws(() => buildSite({ ...input, blog: JSON.stringify(badCfg) }), (e) => e.code === 'bad-blog-json');
});

test('video: a draft may reference a release that is not there yet; no page is made for it', async () => {
  const input = await exampleInputs();
  const text = '---\nslug: v\ntitle: T\ndate: 2026-01-01\nstatus: draft\n---\n\n![](video:nokey/x@v1)\n';
  const r = buildSite({ ...input, posts: [{ path: 'posts/v.md', text }] });
  assert.equal(r.errors.length, 0);
  assert.ok(!('v/index.html' in r.files));
});
