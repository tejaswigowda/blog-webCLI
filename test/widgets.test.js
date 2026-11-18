import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { widgetHtml } from '../lib/widget-markup.js';
import { WIDGET_CLASSES } from '../lib/widgets.js';
import { checkHtmlBlock, tokenizeHtml } from '../lib/rawhtml.js';
import { deltaToMarkdownChecked, hasMath, mdToDelta } from '../lib/markdown.js';
import { deltaToHtml, excerpt } from '../lib/html.js';
import { buildSite } from '../lib/blog.js';
import { EXAMPLE_BLOG } from '../lib/sample.js';
import { headingNavigation } from '../lib/headings.js';
import { emittedNames, loadCorpus } from '../cli/sweep-core.mjs';
import { postBody } from '../lib/contracts.js';

const image = { image: './picture.jpg', alt: 'A boat', caption: 'Caption & detail' };
export const examples = [
  { type: 'faq', items: [{ question: 'How?', answer: 'First paragraph.\n\nSecond paragraph.', open: true }, { question: 'Where?', answer: 'Here.', open: false }] },
  ...['note', 'warning', 'tip'].map((variant) => ({ type: 'note', variant, text: 'Read this.\n\nAnd this.' })),
  { type: 'columns', columns: ['Left', 'Middle', 'Right'] },
  { type: 'figure', ...image, credit: 'Photographer' },
  { type: 'button', url: './products/?a=1&b=2', label: 'Shop & explore' },
  { type: 'quote', text: 'A quote.\n\nMore quoted text.', citation: 'Author' },
  { type: 'steps', items: ['First', 'Second\n\nWith more detail.'] },
  { type: 'compare', figures: [image, { ...image, caption: 'After' }] },
  { type: 'definitions', items: [{ term: 'Term', definition: 'Its meaning.' }, { term: 'Other', definition: 'More.\n\nDetails.' }] },
  { type: 'embed', title: 'Video & sound', url: 'https://player.example/#https://cdn.example/a&present=true' },
  { type: 'native-video', title: 'Demonstration', url: 'https://example.org/demo.mp4' },
  { type: 'film-cards', cards: [{ image: './poster.jpg', url: './film/', title: 'Film', topic: 'Geometry', duration: '1:00', status: 'demonstration', claim: 'A claim.', scene: 'https://example.org/scene', tutorial: 'https://example.org/tutorial' }] },
  { type: 'markdown', markdown: '## Heading\n\nA **bold** link to [more](https://example.org/).\n' },
];

test('every widget round-trips Markdown → Delta → Markdown byte-identically before publication', () => {
  for (const w of examples) {
    const src = widgetHtml(w);
    checkHtmlBlock(src);
    const md = `${src}\n`;
    const checked = deltaToMarkdownChecked(mdToDelta(md));
    assert.equal(checked.md, md, w.type);
    assert.match(deltaToHtml(checked.delta), new RegExp(w.type === 'definitions' ? '<dl>' : 'class="wc-'));
  }
  checkHtmlBlock('<div class="wc-steps"><ol><li>One</li></ol></div>');
  checkHtmlBlock('<div class="author-class"><p>Untouched</p></div>');
});

test('iframe widget emits only sandboxed HTTPS frames with a fallback and escaped values', () => {
  const src = widgetHtml({ type: 'embed', title: 'A "video"', url: 'https://player.example/#https://cdn.example/a&present=true' });
  const rendered = deltaToHtml(mdToDelta(src + '\n'));
  assert.match(rendered, /<iframe src="https:\/\/player\.example\/#https:\/\/cdn\.example\/a&amp;present=true" title="A &quot;video&quot;" loading="lazy" allow="fullscreen" sandbox="allow-scripts" referrerpolicy="no-referrer"><\/iframe>/);
  assert.match(rendered, /<a href="https:\/\/player\.example/);
  for (const url of ['http://example.org/', '//example.org/', 'javascript:alert(1)', 'https://user:pass@example.org/', 'https://example.org\\@evil.org/']) {
    assert.throws(() => widgetHtml({ type: 'embed', title: 'Test', url }), /embed|scheme/i);
  }
  assert.throws(() => checkHtmlBlock('<iframe src="https://example.org/"></iframe>'), /not allowed/);
  const blog = { ...EXAMPLE_BLOG, video: { player: 'https://player.example/', base: 'https://cdn.example/{tag}/{slug}/', repos: { videos: 'me/videos' } } };
  const post = { path: 'posts/embed.md', text: `---\nslug: embed\ntitle: Embed\ndate: 2026-01-01\nstatus: published\n---\n\n${src}\n` };
  assert.deepEqual(buildSite({ blog, posts: [post], lock: {} }).errors, []);
});

test('native video widget preserves the source and renders controls with a fallback link', () => {
  const src = '<div class="wc-video" title="A demonstration"><a href="https://example.org/demo.mp4">Watch the demonstration</a></div>';
  assert.equal(deltaToMarkdownChecked(mdToDelta(src + '\n')).md, src + '\n');
  const rendered = deltaToHtml(mdToDelta(src + '\n'));
  assert.match(rendered, /<video src="https:\/\/example.org\/demo.mp4" title="A demonstration" controls preload="metadata"><\/video>/);
  assert.match(rendered, /<a href="https:\/\/example.org\/demo.mp4"/);
  for (const href of ['javascript:alert(1)', 'http://example.org/demo.mp4', 'https://example.org/page.html', 'https://user:pass@example.org/demo.mp4']) {
    assert.throws(() => checkHtmlBlock(src.replace('https://example.org/demo.mp4', href)));
  }
  assert.throws(() => checkHtmlBlock('<video src="https://example.org/demo.mp4"></video>'), /not allowed/);
});

test('Markdown widget preserves source, renders the subset, and checks its asset and provider links', () => {
  const src = widgetHtml({ type: 'markdown', markdown: '## Heading\n\nA **bold** [link](https://example.org/).\n' });
  assert.equal(deltaToMarkdownChecked(mdToDelta(src + '\n')).md, src + '\n');
  assert.match(deltaToHtml(mdToDelta(src + '\n')), /<div class="wc-markdown"><h2>Heading<\/h2>\n<p>A <strong>bold<\/strong>/);
  assert.equal(excerpt(mdToDelta(src + '\n')), 'A bold link.');
  assert.throws(() => widgetHtml({ type: 'markdown', markdown: '<script>bad()</script>\n' }), /HTML blocks|not allowed/);
  assert.throws(() => widgetHtml({ type: 'markdown', markdown: 'not canonical' }), /canonical/);
  const body = widgetHtml({ type: 'markdown', markdown: '![Poster](asset:images/missing.png)\n' });
  const post = { path: 'posts/test.md', text: `---\nslug: test\ntitle: Test\ndate: 2026-01-01\nstatus: published\n---\n\n${body}\n` };
  assert.equal(buildSite({ blog: EXAMPLE_BLOG, posts: [post], lock: {} }).errors[0].code, 'unresolved-asset');
  const provider = widgetHtml({ type: 'markdown', markdown: '[Provider](https://raw.githubusercontent.com/me/repo/main/a)\n' });
  assert.equal(buildSite({ blog: EXAMPLE_BLOG, posts: [{ ...post, text: post.text.replace(body, provider) }], lock: {} }).errors[0].code, 'provider-url');
  const math = widgetHtml({ type: 'markdown', markdown: 'The value is \\(x\\).\n' });
  assert.equal(hasMath(mdToDelta(math + '\n')), true);
  assert.match(deltaToHtml(mdToDelta(math + '\n')), /<math/);
});

test('unknown reserved names and malformed structures are refused, with file and nearest-name diagnostics', () => {
  const invalid = [
    '<div class="wc-colums"><p>x</p></div>',
    '<div class="wc-columns"><div class="wc-col">x</div><p>not a column</p></div>',
    '<div class="wc-columns"><div class="wc-col"></div><div class="wc-col">x</div></div>',
    '<div class="wc-col">Orphan</div>',
    '<div class="wc-faq"><details><p>Answer</p><summary>Wrong order</summary></details></div>',
    '<div class="wc-faq"><details><summary>Question</summary></details></div>',
    '<aside class="wc-note">Missing variant</aside>',
    '<aside class="wc-note tip warning">Ambiguous variant</aside>',
    '<figure class="wc-figure"><img src="./a.jpg" alt="a"><figcaption>No credit</figcaption></figure>',
    '<small class="wc-credit">Orphan</small>',
    '<a class="wc-button">No address</a>',
    '<div class="wc-quote"><p>Wrong tag</p></div>',
    '<ol class="wc-steps"><p>Not a step</p></ol>',
    '<div class="wc-compare"><figure><img src="./a" alt="a"><figcaption>a</figcaption></figure></div>',
  ];
  for (const src of invalid) assert.throws(() => tokenizeHtml(src), (e) => e.code === 'bad-widget', src);
  const out = buildSite({ blog: JSON.stringify(EXAMPLE_BLOG), posts: [{ path: 'posts/typo.md', text: `---\nslug: typo\ntitle: Typo\ndate: 2026-01-01\nstatus: published\n---\n\n${invalid[0]}\n` }] });
  assert.equal(out.errors[0].code, 'bad-widget');
  assert.match(out.errors[0].message, /posts\/typo.md/);
  assert.match(out.errors[0].message, /wc-colums.*wc-columns/);
  assert.equal(out.files['typo/index.html'], undefined);
});

test('widgets do not widen the HTML allowlist; dialog values are escaped and addresses still checked', () => {
  for (const src of ['<button class="wc-button">x</button>', '<div role="tab">x</div>', '<details aria-expanded="true"><summary>x</summary>y</details>', '<div data-widget="x">x</div>', '<svg></svg>', '<input>']) assert.throws(() => tokenizeHtml(src), (e) => e.code === 'bad-html', src);
  assert.throws(() => widgetHtml({ type: 'button', url: 'javascript:alert(1)', label: 'x' }), /scheme/);
  const src = widgetHtml({ type: 'note', variant: 'note', text: '<script>bad()</script>' });
  assert.match(src, /&lt;script&gt;/);
  assert.doesNotMatch(src, /<script/);
});

test('trusted generation cannot invent or malform widgets; class names mentioned as text are not attributes', () => {
  const make = (bodyHtml) => postBody('blog-webcli-v1', { blog: EXAMPLE_BLOG, bodyHtml, meta: { title: 'Widgets', date: '2026-01-01', tags: [] } });
  assert.throws(() => make('<div class="wc-unknown"></div>'), (e) => e.code === 'bad-widget');
  assert.throws(() => make('<div class="wc-columns"><p>Not columns</p></div>'), (e) => e.code === 'bad-widget');
  assert.throws(() => make('<div class="wc&#45;unknown"></div>'), (e) => e.code === 'bad-widget');
  assert.doesNotThrow(() => make('<p>Write class="wc-example" in your explanation.</p><!-- class="wc-unknown" -->'));
});

test('layout corpus is accepted and exposes every reserved class to theme-check', async () => {
  const source = await readFile(new URL('./layout/widgets.md', import.meta.url), 'utf8');
  const corpus = await loadCorpus();
  const built = buildSite({ blog: JSON.stringify(corpus.blog0), lock: corpus.lock, posts: [{ path: 'posts/widgets.md', text: source }] });
  assert.deepEqual(built.errors, []);
  const names = emittedNames(corpus);
  for (const c of WIDGET_CLASSES) assert.ok(names.classes.includes(c), c);
});

test('heading anchors are text-derived; contents are opt-in at three h2/h3 headings', () => {
  assert.equal(headingNavigation('<p>Nothing</p>'), '<p>Nothing</p>');
  const short = '<h1>Title</h1><h2>One</h2><h3>Two</h3><h4>Four</h4>';
  const one = headingNavigation(short);
  assert.match(one, /<h1 id="title">Title <a class="anchor"/);
  assert.match(one, /<h4 id="four">Four <a class="anchor"/);
  assert.doesNotMatch(one, /class="toc"/);
  assert.doesNotMatch(headingNavigation(short, { contents: true }), /class="toc"/, 'h1 and h4 do not count toward the threshold');
  assert.doesNotMatch(headingNavigation(short, { contents: false }), /class="toc"/);

  const html = '<p id="cafe-tea">Reserved</p><h2>Caf&#233; &amp; <em>tea</em></h2><h3>Café &amp; tea</h3><h4>中文</h4><h2 id="chosen">Authored</h2><h1>Top</h1><h2>Last</h2>';
  const out = headingNavigation(html, { contents: true });
  for (const id of ['cafe-tea-2', 'cafe-tea-3', 'last', 'chosen']) assert.match(out, new RegExp(`href="#${id}"`));
  assert.match(out, /Caf&#233; &amp; tea<\/a>/);
  assert.match(out, /<h4 id="中文">中文 <a class="anchor"/);
  assert.match(out, /<h1 id="top">Top <a class="anchor"/);
  assert.match(out, /<nav class="toc"[\s\S]*href="#cafe-tea-2"[\s\S]*href="#cafe-tea-3"[\s\S]*href="#last"/);
  assert.doesNotMatch(out.slice(0, out.indexOf('<h2')), /href="#section"/, 'h4 is excluded from contents');
  assert.equal(headingNavigation(out, { contents: true }), out);
  assert.doesNotMatch(headingNavigation(html), /class="toc"/);
  assert.equal(headingNavigation('<pre>&lt;h2&gt;Not a heading&lt;/h2&gt;</pre>'), '<pre>&lt;h2&gt;Not a heading&lt;/h2&gt;</pre>');
  assert.match(headingNavigation('<div id="one"></div><h2>One</h2>'), /<h2 id="one-2">/);

  const duplicates = '<h2>Same</h2><h3>Same</h3><h2>Same</h2>';
  const duplicateOutput = headingNavigation(duplicates, { contents: true });
  for (const id of ['same', 'same-2', 'same-3']) assert.match(duplicateOutput, new RegExp(`id="${id}"`));
  const withInsertedHeading = headingNavigation(`<h2>Unrelated</h2>${duplicates}`, { contents: true });
  for (const id of ['same', 'same-2', 'same-3']) assert.match(withInsertedHeading, new RegExp(`id="${id}"`));
  const authoredIds = headingNavigation('<h2 id="fixed">First</h2><h2 id="fixed">Second</h2>');
  assert.equal((authoredIds.match(/<h2 id="fixed">/g) || []).length, 2, 'authored duplicate ids are preserved');
  const nonLatin = headingNavigation('<h2>你好世界</h2><h2>Αθήνα</h2>');
  const nonLatinWithInsertion = headingNavigation('<h2>東京</h2><h2>你好世界</h2><h2>Αθήνα</h2>');
  for (const id of ['你好世界', 'αθηνα']) {
    assert.match(nonLatin, new RegExp(`id="${id}"`));
    assert.match(nonLatinWithInsertion, new RegExp(`id="${id}"`));
  }
  assert.match(nonLatinWithInsertion, /id="東京"/);

  const legacy = '<div class="toc" role="navigation">Existing</div><h2 id="old">Old <a class="anchor" href="#old">#</a></h2><h2>New</h2>';
  const updated = headingNavigation(legacy, { contents: true });
  assert.equal((updated.match(/class="toc"/g) || []).length, 1);
  assert.equal((updated.match(/class="anchor"/g) || []).length, 2);
  assert.match(updated, /<h2 id="old">Old <a class="anchor" href="#old">#<\/a><\/h2>/);
});
