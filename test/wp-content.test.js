import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, decodeEntities, textOf, child } from '../lib/xml.js';
import { parseWxr, dateOf } from '../lib/wxr.js';
import { htmlToDelta, decodeHtml, autop, parseHtml } from '../lib/wp-html.js';
import { planWp, sniffImage } from '../lib/wp-content.js';
import { restBase, restModel } from '../lib/wp-rest.js';
import { buildSite, parsePost } from '../lib/blog.js';
import { deltaToMarkdownChecked } from '../lib/markdown.js';

import { PNG, WXR } from './wp-fixtures.js';

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72]);

// ---------- reading XML ----------
test('xml: elements, attributes, CDATA, entities; a DOCTYPE is skipped and its entities are never expanded', () => {
  const doc = parseXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "boom">]><a k="1 &amp; 2" j=\'q\'><b>t&lt;x&gt; &#65;&#x42; &x; &nope;</b><c/><d><![CDATA[<raw> &amp;]]></d><!-- gone --></a>');
  const a = child(doc, 'a');
  assert.deepEqual(a.attrs, { k: '1 & 2', j: 'q' });
  assert.equal(textOf(child(a, 'b')), 't<x> AB &x; &nope;', 'declared and unknown entities are left alone');
  assert.equal(textOf(child(a, 'd')), '<raw> &amp;', 'CDATA is raw');
  assert.ok(child(a, 'c'));
  assert.equal(decodeEntities('&#0; &#x110000; &lt;'), '&#0; &#x110000; <');
  // a stray close tag and an unclosed element do not stop the reader
  assert.equal(textOf(parseXml('<a><b>x</c></b>y')), 'xy');
  assert.equal(textOf(parseXml('<a>one<b>two')), 'onetwo');
});

// ---------- reading an export ----------
test('wxr: posts, pages, drafts, tags, authors, featured images, the menu; trash and other types are not imported', () => {
  const m = parseWxr(WXR, { today: '2026-11-06' });
  assert.equal(m.title, 'Ada & Friends');
  assert.equal(m.link, 'https://old.example.org');
  assert.match(m.description, /Notes &xxe; from the old blog/, 'the declared entity was not expanded');
  assert.deepEqual(m.authors, { ada: 'Ada Example', bob: 'Bob Guest' });
  assert.deepEqual(m.posts.map((p) => [p.id, p.slug, p.date, p.status]), [[10, 'hello-welcome', '2024-05-02', 'published'], [11, 'second-post', '2024-06-10', 'published'], [12, '', '2026-11-06', 'draft'], [13, 'secret', '2024-07-01', 'draft']]);
  assert.deepEqual(m.posts[0].tags, ['News', 'Video, Git'], 'categories and tags, never "Uncategorized"');
  assert.equal(m.posts[0].thumbnailUrl, 'https://old.example.org/wp-content/uploads/2024/05/cat.jpg');
  assert.equal(m.posts[3].wpStatus, 'private');
  assert.deepEqual(m.pages.map((p) => p.slug), ['about-us', 'tags']);
  assert.deepEqual(m.menu, [20]);
  assert.deepEqual(m.media.map((x) => x.id), [31, 32, 33, 34]);
  assert.deepEqual(m.skipped, { product: 1 });
  assert.throws(() => parseWxr('<html><body>no</body></html>'), (e) => e.code === 'bad-wp-export');
  assert.equal(dateOf('0000-00-00 00:00:00', 'Tue, 02 Jan 2024 10:00:00 +0000'), '2024-01-02');
  assert.equal(dateOf('', null), null);
});

// ---------- HTML -> markdown ----------
const md = (html, opts) => {
  const { ops, notes } = htmlToDelta(html, { image: (s) => s, link: (h) => h, ...opts });
  return { md: deltaToMarkdownChecked({ ops }).md, notes };
};

test('html: the formatting the editor offers comes across, and comes out as markdown that round-trips', () => {
  assert.equal(md('<p>a <strong>b</strong> <em>c</em> <del>d</del> <code>e</code> <a href="https://x.test/">f</a></p>').md, 'a **b** _c_ ~~d~~ `e` [f](https://x.test/)\n');
  assert.equal(md('<h1>One</h1><h2>Two</h2><h4>Four</h4>').md, '# One\n\n## Two\n\n### Four\n', 'levels beyond 3 are 3');
  assert.equal(md('<ul><li>one</li><li>two<ul><li>two-a</li></ul></li></ul><ol><li>x</li></ol>').md, '- one\n- two\n    - two-a\n\n1. x\n');
  assert.equal(md('<blockquote><p>q1</p><p>q2</p></blockquote>').md, '> q1\n>\n> q2\n');
  assert.equal(md('<pre><code>let a = 1;\nlet b = 2;</code></pre>').md, '```\nlet a = 1;\nlet b = 2;\n```\n');
  assert.equal(md('<p>&amp; &hellip; &mdash; &#8217; &nbsp;x</p>').md, '& … — ’ x\n');
  assert.equal(md('<p>&lt;b&gt;</p>').md, '\\<b>\n', 'markdown escapes what would be read as a tag');
  assert.equal(md('<p>one<br>two</p>').md, 'one\n\ntwo\n', 'a line break is a new paragraph: markdown has no soft break here');
  assert.equal(md('<div><span style="color:red">plain</span> <u>words</u></div>').md, 'plain words\n');
  assert.equal(md('<p><img src="a.png" alt="An image"></p>').md, '![An image](a.png)\n');
  assert.equal(md('<script>alert(1)</script><style>p{}</style><p>safe</p><form><input></form>').md, 'safe\n');
});

test('html: what markdown cannot hold is flattened and named, never dropped without a word', () => {
  const t = md('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><hr><iframe src="https://www.youtube.com/embed/x"></iframe><p><a href="javascript:alert(1)">bad</a> <a href="#top">top</a></p>');
  assert.match(t.md, /A \| B\n\n1 \| 2/);
  assert.match(t.md, /\[Embedded from youtube\.com\]\(https:\/\/www\.youtube\.com\/embed\/x\)/);
  assert.ok(!t.md.includes('javascript:'));
  for (const n of ['a table was flattened to lines of text', 'a horizontal rule was dropped', 'an embedded iframe became a link', 'a link that cannot be kept was reduced to its words']) assert.ok(t.notes.includes(n), n);
});

test('html: a picture linked to its own bigger copy is just the picture; images the caller refuses are named', () => {
  assert.equal(md('<a href="https://x.test/big.jpg"><img src="https://x.test/small.jpg" alt="p"></a>').md, '![p](https://x.test/small.jpg)\n');
  const r = md('<p>x <img src="gone.png"></p>', { image: () => null });
  assert.equal(r.md, 'x\n');
  assert.deepEqual(r.notes, ['an image that could not be brought across was dropped']);
});

test('html: plain-text posts become paragraphs; shortcodes are expanded or named; square brackets in prose are left alone', () => {
  assert.equal(autop('one\n\ntwo\nthree\n\n<ul><li>x</li></ul>'), '<p>one</p>\n<p>two<br>three</p>\n<ul><li>x</li></ul>');
  assert.equal(autop('<p>already</p>\n\nhtml'), '<p>already</p>\n\nhtml');
  const r = md('Text [sic] and [citation needed] and [1].\n\n[caption id="a"]<img src="p.png"> Caption words[/caption]\n\n[gallery ids="1,2"]\n\n[embed]https://v.test/watch[/embed]\n\n[my_form id="3"]', { attachment: (id) => ({ url: `https://x.test/g${id}.jpg`, alt: `g${id}` }) });
  assert.match(r.md, /Text \\\[sic\\\] and \\\[citation needed\\\] and \\\[1\\\]\./, 'brackets are text, escaped for markdown');
  assert.match(r.md, /!\[\]\(p\.png\) Caption words/);
  assert.match(r.md, /!\[g1\]\(https:\/\/x\.test\/g1\.jpg\)\n\n!\[g2\]\(https:\/\/x\.test\/g2\.jpg\)/);
  assert.match(r.md, /\[https:\/\/v\.test\/watch\]\(https:\/\/v\.test\/watch\)/);
  assert.ok(r.notes.includes('the [my_form] shortcode was dropped') && r.notes.includes('a [gallery] became a run of images'));
  assert.ok(!r.md.includes('my_form'));
  assert.equal(decodeHtml('&amp;amp; &unknown; &eacute;'), '&amp; &unknown; é', 'decoded once, not twice');
  // a tolerant reader: unclosed and stray tags do not lose the words
  assert.equal(md('<p>one<p>two</i></b><li>x').md.replace(/\n+/g, '|'), 'one|two|- x|');
  assert.equal(parseHtml('<p a=1 b="2" c=\'3\' d>x</p>').children[0].attrs.d, '');
});

// ---------- the whole thing ----------
const fetchedAll = (job) => new Map(job.images.map((im, i) => [im.url, i % 2 ? JPG : PNG]));

test('import: an export becomes markdown posts and pages, pinned to images it names logically; every file is canonical', () => {
  const model = parseWxr(WXR, { today: '2026-11-06' });
  const job = planWp(model, { today: '2026-11-06' });
  assert.deepEqual(job.images.map((i) => [i.path, i.kind]), [
    ['wp/2024/05/cat.jpg', 'content'],
    ['wp/2024/06/dog.jpg', 'content'],
    ['wp/2022/01/My-Unused-Photo.JPG', 'library'],
  ]);
  const paths = job.images.map((i) => i.path).sort();
  assert.deepEqual(paths, ['wp/2022/01/My-Unused-Photo.JPG', 'wp/2024/05/cat.jpg', 'wp/2024/06/dog.jpg'], 'the resized copy is the library original; a PDF is not an image; another site\'s picture is not copied');
  assert.deepEqual(job.blog, { title: 'Ada & Friends', description: 'Notes &xxe; from the old blog', author: 'Ada Example' });

  const out = job.finish(fetchedAll(job));
  assert.deepEqual(out.files.map((f) => f.path).sort(), ['pages/about-us.md', 'pages/tags-wp.md', 'posts/hello-welcome.md', 'posts/not-ready.md', 'posts/second-post.md', 'posts/secret.md'].sort());
  const file = (p) => out.files.find((f) => f.path === p).text;

  const hello = file('posts/hello-welcome.md');
  assert.match(hello, /^---\nslug: hello-welcome\ntitle: "?Hello & welcome"?\ndate: 2024-05-02\ntags: \[News, Video Git\]\nstatus: published\ncover: asset:images\/wp\/2024\/05\/cat\.jpg\ndescription: A short excerpt\.\n---\n\n/);
  assert.match(hello, /First \*\*bold\*\* and _italic_ and \[a link\]\(https:\/\/example\.com\/x\)\./);
  assert.match(hello, /\n### Small heading\n/);
  assert.match(hello, /!\[A cat\]\(asset:images\/wp\/2024\/05\/cat\.jpg\)/);
  assert.match(hello, /See \[the second post\]\(\.\.\/second-post\/\) and \[about\]\(\.\.\/about-us\/\)\./, 'links between imported posts and pages are rewritten');
  assert.match(hello, /!\[far\]\(https:\/\/other\.example\.net\/pic\.png\)/, 'another site\'s picture stays linked');
  assert.ok(!/author:/.test(hello), 'the blog\'s own author is not repeated');

  const second = file('posts/second-post.md');
  assert.match(second, /\nauthor: Bob Guest\n/);
  assert.match(second, /!\[\]\(asset:images\/wp\/2024\/06\/dog\.jpg\) A dog/);
  assert.match(second, /!\[A cat\]\(asset:images\/wp\/2024\/05\/cat\.jpg\)/, 'the gallery ids name library pictures');
  assert.match(second, /Text|Plain text paragraph one\./);
  assert.match(second, /\\\[sic\\\]/);
  assert.match(file('posts/not-ready.md'), /\nstatus: draft\n/);
  assert.match(file('posts/not-ready.md'), /\ndate: 2026-11-06\n/, 'a draft with no date gets the day of the import');
  assert.match(file('posts/secret.md'), /\nstatus: draft\n/);
  assert.match(file('pages/about-us.md'), /^---\nslug: about-us\ntitle: About us\nstatus: published\nmenu: 1\n---\n\nWe write things\.\n$/);
  assert.match(file('pages/tags-wp.md'), /^---\nslug: tags-wp\n/, 'a slug the new blog reserves is changed, and said');

  assert.deepEqual(out.summary, { posts: 2, drafts: 2, pages: 2, images: 3, imagesFailed: 0, imageBytes: out.assets.reduce((n, a) => n + a.bytes.length, 0), internalLinks: 2, skipped: { product: 1 } });
  const said = (where, re) => out.notes.some((n) => n.where === where && re.test(n.text));
  assert.ok(said('posts/hello-welcome.md', /table was flattened/) && said('posts/hello-welcome.md', /another site/) && said('posts/second-post.md', /fancy_form/));
  assert.ok(said('posts/secret.md', /private on WordPress/));

  // and the whole blog builds: every post parses canonically and every asset reference is pinned
  const lock = Object.fromEntries(out.assets.map((a) => [`images/${a.path}`, 'a'.repeat(40)]));
  const blog = { title: job.blog.title, description: job.blog.description, author: job.blog.author, domain: 'https://x.github.io/blog', repo: 'x/blog' };
  const built = buildSite({ blog, posts: out.files.map((f) => ({ path: f.path, text: f.text })), lock });
  assert.deepEqual(built.errors.map((e) => e.message), []);
  for (const f of out.files) assert.equal(parsePost({ path: f.path, text: f.text }).lossy, null, f.path);
  assert.ok(built.files['hello-welcome/index.html'].includes('wp/2024/05/cat.jpg'));
});

test('import: an image that would not download stays linked to the old site, and is said; nothing is lost', () => {
  const job = planWp(parseWxr(WXR, { today: '2026-11-06' }), { today: '2026-11-06' });
  const fetched = fetchedAll(job);
  fetched.set('https://old.example.org/wp-content/uploads/2024/06/dog.jpg', null);
  fetched.set('https://old.example.org/wp-content/uploads/2024/05/cat.jpg', new Uint8Array(40)); // not an image, whatever the server called it
  const out = job.finish(fetched);
  assert.equal(out.summary.images, 1);
  assert.equal(out.summary.imagesFailed, 2);
  const second = out.files.find((f) => f.path === 'posts/second-post.md').text;
  assert.match(second, /!\[\]\(https:\/\/old\.example\.org\/wp-content\/uploads\/2024\/06\/dog\.jpg\)/);
  const hello = out.files.find((f) => f.path === 'posts/hello-welcome.md').text;
  assert.ok(!/\ncover:/.test(hello), 'no cover rather than a cover that is not there');
  assert.ok(out.notes.some((n) => n.where === 'posts/hello-welcome.md' && /featured image could not be downloaded/.test(n.text)));
  assert.equal(sniffImage(new Uint8Array(40)), null);
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')), null, 'an SVG is never taken for a picture');
});

test('import: drafts and the media library are options; nothing but the options changes', () => {
  const model = parseWxr(WXR, { today: '2026-11-06' });
  const job = planWp(model, { today: '2026-11-06', includeDrafts: false, includeLibrary: false });
  assert.deepEqual(job.images.map((i) => i.path).sort(), ['wp/2024/05/cat.jpg', 'wp/2024/06/dog.jpg']);
  const out = job.finish(fetchedAll(job));
  assert.ok(!out.files.some((f) => /not-ready|secret/.test(f.path)));
  assert.equal(out.summary.drafts, 0);
});

test('import: slugs are unique across posts and pages, never reserved, and always valid', () => {
  const model = parseWxr(WXR, { today: '2026-11-06' });
  const dup = (id, type, slug, title) => ({ id, title, slug, date: '2024-01-01', status: 'published', wpStatus: 'publish', author: 'ada', html: '<p>x</p>', excerpt: '', link: '', thumbnailId: 0, thumbnailUrl: '', tags: [], ...(type === 'page' ? { menuOrder: 0, parent: 0 } : {}) });
  model.posts = [dup(1, 'post', 'same', 'A'), dup(2, 'post', 'same', 'B'), dup(3, 'post', '%e6%97%a5%e6%9c%ac', 'Japanese'), dup(4, 'post', '', 'Title With Spaces!'), dup(5, 'post', 'images', 'Images'), dup(6, 'post', 'archive', 'Archive')];
  model.pages = [dup(7, 'page', 'same', 'C')];
  model.media = [];
  const out = planWp(model, { today: '2026-11-06' }).finish(new Map());
  const slugs = out.files.map((f) => f.path.replace(/^\w+\/|\.md$/g, ''));
  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual(slugs.filter((s) => /^same/.test(s)), ['same', 'same-2', 'same-3']);
  assert.ok(slugs.includes('title-with-spaces') && slugs.includes('images-wp') && slugs.includes('archive-wp'));
  assert.ok(slugs.some((s) => /^x-[0-9a-f]{8}$/.test(s)), 'a title in another script still has an address');
});

// ---------- the REST API ----------
test('rest: a site\'s public API reads into the same model', () => {
  const b = restBase('example.org/blog/');
  assert.equal(b.site, 'https://example.org/blog');
  assert.equal(b.api('posts', 2), 'https://example.org/blog/wp-json/wp/v2/posts?per_page=100&page=2');
  assert.throws(() => restBase('ftp://x'), (e) => e.code === 'bad-wp-site');
  const m = restModel({
    root: { name: 'REST Blog', description: 'About', home: 'https://example.org/blog/' },
    posts: [{ id: 1, date: '2024-03-04T10:00:00', slug: 'my-post', status: 'publish', link: 'https://example.org/blog/my-post/', title: { rendered: 'It&#8217;s &amp; so' }, content: { rendered: '<p>Body</p>' }, excerpt: { rendered: '<p>Ex</p>' }, author: 5, featured_media: 9, tags: [3], categories: [4, 1] }],
    pages: [{ id: 2, date: '2024-01-01T00:00:00', slug: 'about', status: 'publish', link: '', title: { rendered: 'About' }, content: { rendered: '<p>A</p>' }, excerpt: { rendered: '' }, author: 5, menu_order: 2, parent: 0 }],
    media: [{ id: 9, source_url: 'https://example.org/blog/wp-content/uploads/2024/03/f.png', mime_type: 'image/png', alt_text: 'F', title: { rendered: 'f' }, post: 1 }],
    tags: [{ id: 3, name: 'Tag A', slug: 'tag-a', taxonomy: 'post_tag' }],
    categories: [{ id: 4, name: 'News', slug: 'news', taxonomy: 'category' }, { id: 1, name: 'Uncategorized', slug: 'uncategorized', taxonomy: 'category' }],
    users: [{ id: 5, name: 'Ada Example', slug: 'ada' }],
  }, { today: '2026-11-06' });
  assert.equal(m.title, 'REST Blog');
  assert.deepEqual(m.posts[0].tags, ['Tag A', 'News']);
  assert.equal(m.posts[0].date, '2024-03-04');
  assert.equal(m.posts[0].author, 'Ada Example');
  assert.equal(m.posts[0].thumbnailUrl, 'https://example.org/blog/wp-content/uploads/2024/03/f.png');
  const out = planWp(m, { today: '2026-11-06' }).finish(new Map([['https://example.org/blog/wp-content/uploads/2024/03/f.png', PNG]]));
  assert.match(out.files.find((f) => f.path === 'posts/my-post.md').text, /title: It’s & so\n/);
  assert.equal(out.summary.images, 1);
  assert.throws(() => restModel({ root: '<html>', posts: [] }), (e) => e.code === 'bad-wp-site');
});
