import test from 'node:test';
import assert from 'node:assert/strict';
import { slideshowHtml } from '../lib/slideshow.js';
import { mdToDelta, deltaToMd } from '../lib/markdown.js';
import { collectAssetRefs } from '../lib/assets.js';
import { deltaToHtml } from '../lib/html.js';
import { buildSite } from '../lib/blog.js';
import { promises as fs } from 'node:fs';
import { animateModule } from '../cli/build-live.js';
import { THEME_DEFAULT, THEME_RESPONSIVE } from '../lib/theme.js';
import { checkPublishedCss } from '../lib/theme-pack.js';

const slide = (name) => ({ image: `asset:images/${name}.jpg`, alt: `${name} picture`, title: name, text: 'A <boat> & water', label: 'Products', url: 'https://example.com/products/' });
const slides = [slide('first'), slide('second')];

test('slideshow HTML round-trips, escapes captions, and pins its image references', () => {
  const md = `${slideshowHtml(slides)}\n`;
  const delta = mdToDelta(md);
  assert.equal(deltaToMd(delta), md);
  assert.deepEqual(collectAssetRefs(delta), ['asset:images/first.jpg', 'asset:images/second.jpg']);
  const html = deltaToHtml(delta, { resolve: (ref) => `https://images.example/${ref.slice(6)}` });
  assert.match(html, /A &lt;boat&gt; &amp; water/);
  assert.match(html, /src="https:\/\/images.example\/images\/first.jpg"/);
  assert.equal((html.match(/<figure /g) || []).length, 2, 'without scripting all slides remain readable');
  assert.doesNotMatch(html, /<script| hidden/);
});

test('slideshow refuses missing images, inaccessible slides, incomplete links, and unsafe URLs', () => {
  for (const bad of [[], [slides[0]], [null, slide('a')], Array(11).fill(slides[0]), [slide('a'), { ...slide('b'), image: '' }], [slide('a'), { ...slide('b'), alt: '' }], [slide('a'), { ...slide('b'), label: '' }], [slide('a'), { ...slide('b'), url: 'javascript:alert(1)' }], [slide('a'), { ...slide('b'), image: 'data:image/svg+xml,x' }]]) {
    assert.throws(() => slideshowHtml(bad), (error) => error.code === 'bad-html');
  }
});

test('slide animation choices survive markdown without making legacy HTML depend on an animation class', () => {
  const legacy = slideshowHtml(slides);
  assert.doesNotMatch(legacy, /webcli-animate-/);
  const html = slideshowHtml([{ ...slides[0], animation: 'fadeInUp' }, { ...slides[1], animation: 'none' }]);
  assert.match(html, /class="webcli-slide webcli-animate-fadeInUp"/);
  assert.match(html, /class="webcli-slide webcli-animate-none"/);
  assert.equal(deltaToMd(mdToDelta(`${html}\n`)), `${html}\n`);
  for (const animation of ['arbitrary', 'fadeIn" onload="alert(1)', null, 'fadeOut']) {
    assert.throws(() => slideshowHtml([{ ...slides[0], animation }, slides[1]]), /choose an animation/);
  }
});

test('Animate.css ships locally with default and pinned themes, retaining its MIT notice and source fidelity', async () => {
  for (const css of [THEME_DEFAULT, THEME_RESPONSIVE]) {
    assert.match(css, /@keyframes fadeIn/);
    assert.match(css, /\.animate__animated/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /Copyright \(c\) 2020 Daniel Eden/);
    assert.match(css, /Permission is hereby granted/);
    assert.equal(checkPublishedCss(css), css);
  }
  const generated = await fs.readFile(new URL('../vendor/animate/animate.esm.js', import.meta.url), 'utf8');
  assert.equal(generated, await animateModule(), 'run npm run build:live after replacing the upstream stylesheet');
});

test('slideshow builds on the landing and standalone page, shipping a local runtime only when needed', () => {
  const blog = { title: 'T', author: 'A', description: 'D', domain: 'https://example.com', repo: 'me/blog', assets: { repos: { images: 'me/blog/images' }, base: 'https://images.example/{sha}/{path}' } };
  const lock = { 'images/first.jpg': 'a'.repeat(40), 'images/second.jpg': 'a'.repeat(40) };
  const text = `---\nslug: home\ntitle: Home\nstatus: published\n---\n\n${slideshowHtml(slides)}\n`;
  const out = buildSite({ blog, lock, posts: [{ path: 'pages/home.md', text }] });
  assert.deepEqual(out.errors, []);
  assert.match(out.files['index.html'], /src="\.\/webcli-slideshow.js"/);
  assert.match(out.files['home/index.html'], /src="\.\.\/webcli-slideshow.js"/);
  assert.match(out.files['webcli-slideshow.js'], /Slideshow controls/);
  assert.match(out.files['index.html'], /webcli-slide/);
  const empty = buildSite({ blog, lock, posts: [] });
  assert.equal(empty.files['webcli-slideshow.js'], undefined);
  assert.doesNotMatch(empty.files['index.html'], /<script[^>]+webcli-slideshow/);
  const post = text.replace('slug: home', 'slug: boats').replace('status: published', 'date: 2026-01-01T00:00\nstatus: published');
  const standalone = buildSite({ blog, lock, posts: [{ path: 'posts/boats.md', text: post }] });
  assert.deepEqual(standalone.errors, []);
  assert.match(standalone.files['boats/index.html'], /src="\.\.\/webcli-slideshow.js"/);
  assert.ok(standalone.files['webcli-slideshow.js'], 'a slideshow only in a post still ships its runtime');
});
