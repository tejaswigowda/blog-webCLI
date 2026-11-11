import test from 'node:test';
import { parseComments } from '../lib/comments.js';
import assert from 'node:assert/strict';
import { parseXml, decodeEntities, textOf, child } from '../lib/xml.js';
import { parseWxr, dateOf } from '../lib/wxr.js';
import { htmlToDelta, decodeHtml, autop, parseHtml } from '../lib/wp-html.js';
import { planWp, sniffImage } from '../lib/wp-content.js';
import { restBase, restModel } from '../lib/wp-rest.js';
import { buildSite, parsePost } from '../lib/blog.js';
import { deltaToMarkdownChecked, mdRoundTrips } from '../lib/markdown.js';
import { checkHtmlBlock } from '../lib/rawhtml.js';

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

test('html: what markdown cannot hold is flattened or kept as an HTML block, and named, never dropped without a word', () => {
  const t = md('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><hr><iframe src="https://www.youtube.com/embed/x"></iframe><p><a href="javascript:alert(1)">bad</a> <a href="#top">top</a></p>');
  assert.match(t.md, /^\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|\n\n<hr>\n\n/);
  assert.match(t.md, /\[Embedded from youtube\.com\]\(https:\/\/www\.youtube\.com\/embed\/x\)/);
  assert.ok(!t.md.includes('javascript:'));
  for (const n of ['an embedded iframe became a link', 'a link that cannot be kept was reduced to its words']) assert.ok(t.notes.includes(n), n);
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
    ['wp/2022/01/paper.pdf', 'content'],
    ['wp/2024/06/dog.jpg', 'content'],
    ['wp/2022/01/My-Unused-Photo.JPG', 'library'],
  ]);
  const paths = job.images.map((i) => i.path).sort();
  assert.deepEqual(paths, ['wp/2022/01/My-Unused-Photo.JPG', 'wp/2022/01/paper.pdf', 'wp/2024/05/cat.jpg', 'wp/2024/06/dog.jpg'], 'the resized copy is the library original; a linked PDF comes across too; another site\'s picture is not copied');
  assert.deepEqual(job.blog, { title: 'Ada & Friends', description: 'Notes &xxe; from the old blog', author: 'Ada Example' });

  const out = job.finish(fetchedAll(job));
  assert.deepEqual(out.files.map((f) => f.path).sort(), ['comments/hello-welcome.json', 'pages/about-us.md', 'pages/tags-wp.md', 'posts/hello-welcome.md', 'posts/not-ready.md', 'posts/second-post.md', 'posts/secret.md'].sort());
  const file = (p) => out.files.find((f) => f.path === p).text;

  const hello = file('posts/hello-welcome.md');
  assert.match(hello, /^---\nslug: hello-welcome\ntitle: "?Hello & welcome"?\ndate: 2024-05-02\ntags: \[News, Video Git\]\nstatus: published\ncover: asset:images\/wp\/2024\/05\/cat\.jpg\ndescription: A short excerpt\.\n---\n\n/);
  assert.match(hello, /First \*\*bold\*\* and _italic_ and \[a link\]\(https:\/\/example\.com\/x\)\./);
  assert.match(hello, /\n### Small heading\n/);
  assert.match(hello, /!\[A cat\]\(asset:images\/wp\/2024\/05\/cat\.jpg\)/);
  assert.match(hello, /See \[the second post\]\(\.\.\/second-post\/\) and \[about\]\(\.\.\/about-us\/\)\./, 'links between imported posts and pages are rewritten');
  assert.match(hello, /!\[far\]\(https:\/\/other\.example\.net\/pic\.png\)/, 'another site\'s picture stays linked');
  assert.ok(!/author:/.test(hello), 'the blog\'s own author is not repeated');
  assert.match(hello, /Read \[the paper\]\(asset:images\/wp\/2022\/01\/paper\.pdf\)\./, 'a link to a file of the old site is a link to the copy');
  // approved comments only, oldest first, a reply naming who it answers; never an email, an address, spam or a pingback
  // approved comments only, in a sidecar and not in the post: oldest first, a reply naming the comment it answers by id; never an email, an address, spam or a pingback
  assert.ok(!/Comments \(/.test(hello), 'the post is the post: its comments are data beside it');
  const sidecar = file('comments/hello-welcome.json');
  const list = parseComments(sidecar, 'comments/hello-welcome.json');
  assert.deepEqual(list.map((c) => [c.name, c.date, c.reply_to ? 'reply' : '']), [['Zed', '2024-05-03', ''], ['Ada Example', '2024-05-04', 'reply']]);
  assert.equal(list[0].body, 'Nice post!\n\nSecond paragraph.');
  assert.equal(list[1].reply_to, list[0].id);
  assert.deepEqual(Object.keys(list[0]).sort(), ['body', 'date', 'id', 'name']);
  for (const never of ['private.example', '203.0.113.9', 'Spammer', 'Buy things', 'Pingback', 'Some blog']) assert.ok(!hello.includes(never) && !sidecar.includes(never), never);

  const second = file('posts/second-post.md');
  assert.match(second, /\nauthor: Bob Guest\n/);
  assert.ok(!/aliases:/.test(second), 'its old address is where the new blog puts it');
  assert.equal(out.blog.permalink, '/{year}/{month}/{slug}/', 'the old site used year and month: the posts keep those addresses');
  assert.ok(out.notes.some((n) => n.where === 'permalinks' && /keep their old addresses/.test(n.text)));
  assert.deepEqual(out.blog.archiveAliases, { tags: ['tag', 'category'], authors: ['author'], dates: true });
  assert.ok(!/aliases:/.test(file('posts/not-ready.md')) && !/aliases:/.test(file('pages/about-us.md')), 'a plain ?p= address cannot be redirected, and a page already at /about-us/ has nothing to redirect');
  assert.match(second, /!\[\]\(asset:images\/wp\/2024\/06\/dog\.jpg\) A dog/);
  assert.match(second, /!\[A cat\]\(asset:images\/wp\/2024\/05\/cat\.jpg\)/, 'the gallery ids name library pictures');
  assert.match(second, /Text|Plain text paragraph one\./);
  assert.match(second, /\\\[sic\\\]/);
  assert.match(file('posts/not-ready.md'), /\nstatus: draft\n/);
  assert.match(file('posts/not-ready.md'), /\ndate: 2026-11-06\n/, 'a draft with no date gets the day of the import');
  assert.match(file('posts/secret.md'), /\nstatus: draft\n/);
  assert.match(file('pages/about-us.md'), /^---\nslug: about-us\ntitle: About us\nstatus: published\nmenu: 1\n---\n\nWe write things\.\n$/);
  assert.match(file('pages/tags-wp.md'), /^---\nslug: tags-wp\n/, 'a slug the new blog reserves is changed, and said');

  assert.deepEqual(out.summary, { posts: 2, drafts: 2, pages: 2, images: 3, files: 1, comments: 2, imagesFailed: 0, imageBytes: out.assets.reduce((n, a) => n + a.bytes.length, 0), internalLinks: 2, redirects: 0, skipped: { product: 1 } });
  const said = (where, re) => out.notes.some((n) => n.where === where && re.test(n.text));
  assert.ok(said('posts/hello-welcome.md', /another site/) && said('posts/second-post.md', /fancy_form/));
  assert.ok(said('posts/secret.md', /private on WordPress/));

  // and the whole blog builds: every post parses canonically and every asset reference is pinned
  const lock = Object.fromEntries(out.assets.map((a) => [`images/${a.path}`, 'a'.repeat(40)]));
  const blog = { title: job.blog.title, description: job.blog.description, author: job.blog.author, domain: 'https://x.github.io/blog', repo: 'x/blog' };
  const built = buildSite({ blog, posts: out.files.map((f) => ({ path: f.path, text: f.text })), lock });
  assert.deepEqual(built.errors.map((e) => e.message), []);
  for (const f of out.files.filter((f) => f.path.endsWith('.md'))) assert.equal(parsePost({ path: f.path, text: f.text }).lossy, null, f.path);
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
  assert.deepEqual(job.images.map((i) => i.path).sort(), ['wp/2022/01/paper.pdf', 'wp/2024/05/cat.jpg', 'wp/2024/06/dog.jpg']);
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
  const esc = restModel({ root: { name: 'Alicia&#039;s Deals &amp; More', description: 'It&#8217;s all here' }, posts: [], tags: [{ id: 3, name: 'Food &amp; Drink', slug: 'f', taxonomy: 'post_tag' }], users: [{ id: 5, name: 'O&#039;Neil', slug: 'o' }] }, { today: '2026-11-06' });
  assert.equal(esc.title, "Alicia's Deals & More", 'the site name arrives HTML-escaped from the REST index');
  assert.equal(esc.description, 'It’s all here');
});

test('import: only pictures and files on the blog\'s own site are copied, whatever the post, the cover or the library says', () => {
  const model = parseWxr(WXR);
  const html = [
    '<p><img src="https://old.example.org/wp-content/uploads/2024/05/cat.jpg" alt="own"></p>',
    '<p><img src="https://www.old.example.org/wp-content/uploads/a.png" alt="www"></p>',
    '<p><img src="https://cdn.old.example.org/b.png" alt="sub"></p>',
    '<p><img src="https://i0.wp.com/old.example.org/wp-content/uploads/c.png?resize=300" alt="photon own"></p>',
    '<p><img src="https://i0.wp.com/stranger.example.net/d.png" alt="photon other"></p>',
    '<p><img src="https://notold.example.org/e.png" alt="lookalike"></p>',
    '<p><img src="https://old.example.org.evil.test/f.png" alt="suffix trick"></p>',
    '<p><img src="https://images.unsplash.com/g.jpg" alt="stock"></p>',
    '<p><a href="https://elsewhere.example.net/h.pdf">far pdf</a></p>',
  ].join('\n');
  const post = { ...model.posts[0], html, thumbnailUrl: 'https://elsewhere.example.net/cover.jpg' };
  const m = {
    ...model,
    posts: [post],
    pages: [],
    media: [
      ...model.media,
      { id: 90, url: 'https://s3.example.net/bucket/offloaded.jpg', mime: 'image', alt: '' },
      { id: 91, url: 'https://elsewhere.example.net/lib.png', mime: 'image', alt: '' },
    ],
  };
  const job = planWp(m, { today: '2026-11-06' });
  const urls = job.images.map((i) => i.url);
  assert.ok(urls.length > 0 && urls.every((u) => /^https:\/\/(www\.|cdn\.)?old\.example\.org\//.test(u)), `fetched from the blog's own site only: ${urls.join(' ')}`);
  for (const bad of ['stranger', 'notold', 'evil.test', 'unsplash', 'elsewhere', 's3.example']) assert.ok(!urls.some((u) => u.includes(bad)), bad);
  assert.ok(urls.some((u) => u.includes('/cdn.old') || u.startsWith('https://cdn.old.example.org')) && urls.some((u) => u.includes('www.old.example.org')), 'a subdomain and www are the same site');
  assert.ok(urls.some((u) => u.startsWith('https://old.example.org/wp-content/uploads/c.png')), 'a Photon copy of its own picture is fetched from its own host');

  const out = job.finish(new Map(job.images.map((i) => [i.url, i.url.endsWith('.pdf') ? new TextEncoder().encode('%PDF-1.4') : PNG])));
  const md = out.files.find((f) => f.path === 'posts/hello-welcome.md').text;
  for (const far of ['https://i0.wp.com/stranger.example.net/d.png', 'https://notold.example.org/e.png', 'https://old.example.org.evil.test/f.png', 'https://images.unsplash.com/g.jpg', 'https://elsewhere.example.net/h.pdf']) assert.ok(md.includes(far), `${far} stays as it was`);
  assert.ok(!/^cover:/m.test(md), 'a cover on another site is not taken');
  assert.ok(out.notes.some((n) => /featured image is hosted on another site/.test(n.text)));
  assert.ok(out.notes.some((n) => n.where === 'library' && /2 media library files are hosted on another site/.test(n.text)));
});

test('import: two posts with the same long title get valid, distinct slugs (the cut never leaves a double hyphen)', () => {
  const model = parseWxr(WXR);
  const title = 'Score a Free 8x10 Photo Enlargement from Walgreens with Any Order Today';
  const mk = (id) => ({ ...model.posts[0], id, title, slug: '', html: '<p>x</p>', thumbnailUrl: '', comments: [] });
  const out = planWp({ ...model, posts: [mk(1), mk(2), mk(3)], pages: [], media: [], menu: [] }, { today: '2026-11-06' }).finish(new Map());
  const slugs = out.files.filter((f) => f.path.startsWith('posts/')).map((f) => f.path.slice(6, -3));
  assert.equal(slugs.length, 3);
  assert.equal(new Set(slugs).size, 3);
  for (const s of slugs) assert.match(s, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, s);
});

test('import: a long blog is imported with pagination on, a short one without', async () => {
  const { makeBlogJson } = await import('../lib/init.js');
  const model = parseWxr(WXR);
  const many = Array.from({ length: 60 }, (_, i) => ({ ...model.posts[0], id: 1000 + i, title: `Post number ${i}`, slug: `post-number-${i}`, html: '<p>x</p>', thumbnailUrl: '', comments: [] }));
  const long = planWp({ ...model, posts: many, pages: [], media: [], menu: [] }, { today: '2026-11-06' }).finish(new Map());
  assert.equal(long.blog.pageSize, 20);
  assert.deepEqual(makeBlogJson('me/site', { ...long.blog, domain: 'https://me.github.io/site' }).pagination, { size: 20, stable: true });
  const short = planWp(model, { today: '2026-11-06' }).finish(new Map());
  assert.equal(short.blog.pageSize, undefined);
  assert.equal(makeBlogJson('me/site', { ...short.blog, domain: 'https://me.github.io/site' }).pagination, undefined);
});

test('html: a plain table becomes a markdown table, with alignment and the markup of its cells; the post is canonical', () => {
  const r = md('<table><thead><tr><th>Name</th><th style="text-align:right">Price</th></tr></thead><tbody><tr><td><b>Apple</b> | pie</td><td align="right">3</td></tr><tr><td><a href="https://x.test/a">link</a></td><td><img src="a.png" alt="p"></td></tr></tbody></table>');
  assert.equal(r.md, '| Name | Price |\n| --- | ---: |\n| **Apple** \\| pie | 3 |\n| [link](https://x.test/a) | ![p](a.png) |\n');
  assert.deepEqual(r.notes, []);
  assert.equal(mdRoundTrips(r.md).ok, true);
  // Gutenberg's wrapper, and a caption outside the table, are only a figure around it
  assert.match(md('<figure class="wp-block-table"><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><figcaption>Sizes</figcaption></figure>').md, /^\| A \|\n\| --- \|\n\| 1 \|\n\nSizes\n$/);
});

test('html: a table markdown cannot hold is kept as an HTML block with only the tags a block may hold, and the note says so', () => {
  const merged = md('<table class="x" style="width:100%"><tr><th colspan="2" onclick="x()">Merged</th></tr><tr><td>a<br>b</td><td><script>x()</script><img src="http://old.test/p.png" alt="p"> <a href="javascript:x()">bad</a></td></tr></table>');
  assert.equal(merged.md, '<table>\n<tr><th colspan="2">Merged</th></tr>\n<tr><td>a<br>b</td><td><img src="http://old.test/p.png" alt="p"> bad</td></tr>\n</table>\n');
  assert.deepEqual(merged.notes, ['a table was kept as an HTML block (it has merged cells, no header row, a caption or more than a line in a cell)']);
  assert.equal(mdRoundTrips(merged.md).ok, true);
  const bare = md('<table><tr><td>1</td><td>2</td></tr></table>');
  assert.equal(bare.md, '<table>\n<tr><td>1</td><td>2</td></tr>\n</table>\n', 'no header row: not given a made-up one');
  assert.match(md('<table><caption>Cap</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>').md, /<caption>Cap<\/caption>/);
  assert.match(md('<table><tr><th>A</th></tr><tr><td><ul><li>x</li><li>y</li></ul></td></tr></table>').md, /<td><ul><li>x<\/li><li>y<\/li><\/ul><\/td>/);
  // whatever the importer writes, the generator accepts
  for (const t of [merged.md, bare.md]) assert.doesNotThrow(() => checkHtmlBlock(t.trim()));
});

test('html: a horizontal rule is kept', () => {
  assert.equal(md('<p>a</p><hr><p>b</p>').md, 'a\n\n<hr>\n\nb\n');
});

// ---------- old permalinks ----------
const wxr = (items, link = 'https://old.example.org') => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/"><channel>
<title>Site</title><link>${link}</link><description>d</description><language>en</language><wp:wxr_version>1.2</wp:wxr_version><wp:base_blog_url>${link}</wp:base_blog_url>
${items.map((i, n) => `<item><title>${i.title || `Post ${n}`}</title><link>${i.link}</link><dc:creator>ada</dc:creator><content:encoded><![CDATA[${i.html || '<p>Text.</p>'}]]></content:encoded><wp:post_id>${n + 1}</wp:post_id><wp:post_date>2024-01-0${n + 1} 10:00:00</wp:post_date><wp:post_name>${i.slug}</wp:post_name><wp:status>publish</wp:status><wp:post_type>${i.type || 'post'}</wp:post_type></item>`).join('\n')}
</channel></rss>`;
const planOf = (items, opts, link) => planWp(parseWxr(wxr(items, link), { today: '2026-11-06' }), { today: '2026-11-06', ...opts });
const aliasesOf = (out, p) => (/\naliases: \[([^\]]*)\]\n/.exec(out.files.find((f) => f.path === p).text) || [])[1];

test('redirects: each post keeps its old path as an alias; a plain ?p= address, the same address, and the home page have nothing to redirect', () => {
  const out = planOf([
    { slug: 'one', link: 'https://old.example.org/2020/05/one/' }, { slug: 'two', link: 'https://old.example.org/blog/two.html' },
    { slug: 'three', link: 'https://old.example.org/three/' }, { slug: 'four', link: 'https://old.example.org/?p=4' }, { slug: 'five', link: 'https://old.example.org/%E6%97%A5%E6%9C%AC/five/' },
  ]).finish();
  assert.equal(aliasesOf(out, 'posts/one.md'), '"2020/05/one"');
  assert.equal(aliasesOf(out, 'posts/two.md'), 'blog/two.html');
  assert.equal(aliasesOf(out, 'posts/three.md'), undefined, 'already at /three/');
  assert.equal(aliasesOf(out, 'posts/four.md'), undefined);
  assert.equal(aliasesOf(out, 'posts/five.md'), '日本/five', 'the path as people read it; the address is the same');
  assert.equal(out.summary.redirects, 3);
  assert.ok(out.notes.some((n) => n.where === 'permalinks' && /1 post uses a plain address/.test(n.text)));
});

test('redirects: a blog that lived in a folder keeps the paths below it; an address outside it is left alone; they can be switched off', () => {
  const items = [{ slug: 'a', link: 'https://old.example.org/blog/2021/a/' }, { slug: 'b', link: 'https://old.example.org/elsewhere/b/' }];
  const out = planOf(items, {}, 'https://old.example.org/blog').finish();
  assert.equal(aliasesOf(out, 'posts/a.md'), '"2021/a"');
  assert.equal(aliasesOf(out, 'posts/b.md'), undefined);
  assert.equal(planOf(items, { redirects: false }, 'https://old.example.org/blog').finish().summary.redirects, 0);
  assert.ok(!/aliases:/.test(planOf(items, { redirects: false }).finish().files[0].text));
});

test('redirects: an old address the new blog uses for something else is dropped and said, never written to collide', () => {
  const out = planOf([
    { slug: 'one', link: 'https://old.example.org/tags/one/' }, { slug: 'two', link: 'https://old.example.org/2020/two/' }, { slug: 'three', link: 'https://old.example.org/2020/two/' },
    { slug: 'x', link: 'https://old.example.org/zeta/x/' }, { slug: 'zeta', link: 'https://old.example.org/zeta-old/' },
  ]).finish();
  assert.equal(aliasesOf(out, 'posts/one.md'), undefined, 'below tags/, which the generator owns');
  assert.equal(aliasesOf(out, 'posts/two.md'), '"2020/two"');
  assert.equal(aliasesOf(out, 'posts/three.md'), undefined, 'one address, one page');
  assert.equal(aliasesOf(out, 'posts/x.md'), undefined, 'below zeta/, which is a post');
  assert.equal(out.notes.filter((n) => /could not be kept/.test(n.text)).length, 3);
});

test('redirects: the imported blog builds, with a page at every old address that goes to the post; the index records them', () => {
  const out = planOf([{ slug: 'one', link: 'https://old.example.org/2020/05/one/' }, { slug: 'two', link: 'https://old.example.org/2020/06/two/' }]).finish();
  const posts = out.files.map((f) => ({ path: f.path, text: f.text }));
  const r = buildSite({ blog: { ...out.blog, domain: 'https://new.example.org', repo: 'me/blog' }, posts, lock: {} });
  assert.deepEqual(r.errors, []);
  assert.match(r.files['2020/05/one/index.html'], /<link rel="canonical" href="https:\/\/new\.example\.org\/one\/">[\s\S]*url=\.\.\/\.\.\/\.\.\/one\//);
  assert.deepEqual(JSON.parse(r.files['index/posts.json']).redirects.filter((x) => x.slug), [{ from: '2020/05/one', slug: 'one' }, { from: '2020/06/two', slug: 'two' }]);
});

test('import: a picture that could not be downloaded stays linked to the old site inside a table and an HTML block too', () => {
  const html = '<table><thead><tr><th>Pic</th></tr></thead><tbody><tr><td><img src="https://old.example.org/wp-content/uploads/a.png" alt="a"></td></tr></tbody></table><table><tr><td colspan="2"><img src="https://old.example.org/wp-content/uploads/b.png" alt="b"></td></tr></table>';
  const job = planOf([{ slug: 'pics', link: 'https://old.example.org/pics/', html }]);
  const text = job.finish(new Map()).files.find((f) => f.path === 'posts/pics.md').text;
  assert.match(text, /\| !\[a\]\(https:\/\/old\.example\.org\/wp-content\/uploads\/a\.png\) \|/);
  assert.match(text, /<img src="https:\/\/old\.example\.org\/wp-content\/uploads\/b\.png" alt="b">/);
  assert.ok(!text.includes('asset:images'), 'nothing is left pointing at a file that was not copied');
  // and when they did come across, the pins are logical references the build can resolve
  const ok = job.finish(new Map(job.images.map((i) => [i.url, PNG])));
  assert.match(ok.files[0].text, /asset:images\/wp\/a\.png/);
});
