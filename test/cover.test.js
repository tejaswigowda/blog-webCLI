// `cover: auto`: the post's own picture, chosen at build time, for the share preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, parsePost } from '../lib/blog.js';
import { autoCover, isCoverValue } from '../lib/cover.js';
import { parseMeta, splitFile, validateMeta } from '../lib/frontmatter.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
const LOCK = { 'images/diagram.png': '2'.repeat(40), 'images/other.png': '3'.repeat(40), 'images/default-cover.png': '1'.repeat(40) };

async function blogJson(patch = {}) {
  const b = { ...JSON.parse(await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8')), ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete b[k];
  return JSON.stringify(b);
}
const post = (body, cover = 'auto', slug = 'p-one') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: P\ndate: 2026-01-01\nstatus: published\n${cover === undefined ? '' : `cover: ${cover}\n`}---\n\n${body}\n` });
const build = async (body, { cover = 'auto', patch = {} } = {}) => buildSite({ blog: await blogJson(patch), lock: LOCK, posts: [post(body, cover)] });
const ogImage = (html) => (/<meta property="og:image" content="([^"]*)"/.exec(html) || [])[1] || null;
const IMG = '![d](asset:images/diagram.png)';
const VIDEO = '![](video:videos/clip@v2)';

test('frontmatter: cover may be auto or an asset reference, and nothing else', () => {
  const meta = (cover) => ({ slug: 's', title: 'T', date: '2026-01-01', status: 'published', cover });
  for (const ok of ['auto', 'asset:images/x.png']) assert.doesNotThrow(() => validateMeta(meta(ok), 'p'), ok);
  for (const bad of ['Auto', 'auto ', 'automatic', 'https://x.example/a.png', 'images/x.png', '']) assert.throws(() => validateMeta(meta(bad), 'p'), (e) => e.code === 'bad-frontmatter' && /asset: reference, or auto/.test(e.message), bad);
  assert.ok(isCoverValue('auto') && isCoverValue('asset:a/b.png') && !isCoverValue('x'));
  const parsed = parsePost(post(IMG));
  assert.equal(parsed.meta.cover, 'auto', 'the source keeps the word, not a resolved address');
});

test('auto: the first image of the post, as a pinned address; nothing is drawn on the page', async () => {
  const out = await build(`${VIDEO}\n\nText.\n\n${IMG}\n\n![o](asset:images/other.png)`);
  assert.deepEqual(out.errors, []);
  const html = out.files['p-one/index.html'];
  assert.equal(ogImage(html), `https://cdn.jsdelivr.net/gh/example/images@${'2'.repeat(40)}/diagram.png`, 'an image beats a video, and the first image wins');
  assert.ok(!html.includes('class="cover"'), 'the post body already shows it');
  assert.match(html, /<meta name="twitter:image" content="[^"]*diagram\.png">/);
  const entry = JSON.parse(out.files['index/posts.json']).posts[0];
  assert.equal(entry.cover, 'asset:images/diagram.png', 'the index says which asset it chose');
  assert.deepEqual(out.warnings.filter((w) => /cover/.test(w)), []);
});

test('auto: with no image, the poster of the first video, pinned by its tag', async () => {
  const out = await build(`Words.\n\n${VIDEO}\n\n![](video:videos/other@v1)`);
  assert.deepEqual(out.errors, []);
  assert.equal(ogImage(out.files['p-one/index.html']), 'https://cdn.jsdelivr.net/gh/example/renders@clip/v2/clip/poster.jpg');
  assert.equal(JSON.parse(out.files['index/posts.json']).posts[0].cover, null);
  assert.ok(!out.files['p-one/index.html'].includes('class="cover"'));
});

test('auto: with nothing to pick, the blog\'s cover, or a warning when there is none', async () => {
  const withBlogCover = await build('Only words.');
  assert.equal(ogImage(withBlogCover.files['p-one/index.html']), `https://cdn.jsdelivr.net/gh/example/images@${'1'.repeat(40)}/default-cover.png`);
  assert.deepEqual(withBlogCover.warnings.filter((w) => /cover/.test(w)), []);

  const none = await build('Only words.', { patch: { cover: undefined } });
  assert.deepEqual(none.errors, []);
  assert.equal(ogImage(none.files['p-one/index.html']), null);
  assert.ok(none.warnings.some((w) => /cover is auto but the post has no image or video/.test(w)));
});

test('an explicit cover is unchanged: drawn on the page and used for the preview', async () => {
  const out = await build('Words.', { cover: 'asset:images/other.png' });
  const html = out.files['p-one/index.html'];
  assert.match(html, /<p class="cover"><img src="[^"]*other\.png"/);
  assert.match(ogImage(html), /other\.png$/);
  assert.equal(JSON.parse(out.files['index/posts.json']).posts[0].cover, 'asset:images/other.png');
  const noCover = await build('Words.', { cover: undefined });
  assert.ok(!noCover.files['p-one/index.html'].includes('class="cover"'));
});

test('auto: a post that picks an image that is not pinned is refused like any unresolved image', async () => {
  const out = buildSite({ blog: await blogJson(), lock: {}, posts: [post('![d](asset:images/missing.png)')] });
  assert.deepEqual(out.errors.map((e) => e.code), ['unresolved-asset']);
});

test('autoCover: pure, in document order within each kind', () => {
  const ops = (...inserts) => ({ ops: inserts.map((insert) => ({ insert })) });
  const blog = { video: { player: 'https://p.example/', base: 'https://c.example/{repo}@{tag}/{slug}/', repos: { videos: 'me/r' } } };
  assert.deepEqual(autoCover(ops('text', { image: 'asset:images/a.png' }, { image: 'asset:images/b.png' }), blog), { ref: 'asset:images/a.png' });
  assert.deepEqual(autoCover(ops({ video: 'video:videos/x@v3' }), blog), { url: 'https://c.example/r@x/v3/x/poster.jpg' });
  assert.equal(autoCover(ops('text', { image: 'https://elsewhere.example/a.png' }), blog), null, 'only the blog\'s own assets');
  assert.equal(autoCover(ops('text'), blog), null);
});

test('the source file stays canonical: frontmatter with cover: auto round-trips byte for byte', async () => {
  const text = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus', 'cover-auto.md'), 'utf8');
  const parsed = parsePost({ path: 'posts/cover-auto.md', text });
  assert.ok(!parsed.lossy, "no lossy round trip");
  const { front } = splitFile(text, 'posts/cover-auto.md');
  assert.equal(parseMeta(front, 'p').cover, 'auto');
});

test('a post with no body can be saved: an empty document is not a lossy round trip', async () => {
  const { deltaToMarkdownChecked } = await import('../lib/markdown.js');
  for (const ops of [[{ insert: '\n' }], [], [{ insert: '\n\n\n' }], [{ insert: '  \n' }]]) assert.equal(deltaToMarkdownChecked({ ops }).md, '', JSON.stringify(ops));
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'x', attributes: { color: '#f00' } }, { insert: '\n' }] }), (e) => e.code === 'lossy-round-trip', 'real loss is still refused');
});
