// Site features beyond posts and an index: sitemap and robots.txt, tag/author/archive pages, pagination, search,
// JSON-LD and per-post SEO, comments / analytics / subscribe embeds, standalone pages. Each is data in blog.json or
// frontmatter; none changes what a blog without it generates, except the pages every blog now gets (archive, tags).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, validateBlog } from '../lib/blog.js';
import { SEARCH_SOURCE } from '../lib/search-source.js';
import { rank, snippet, tokenize } from '../lib/search-client.js';
import { slugify, groupTags, paginate, byYear } from '../lib/taxonomy.js';
import { loadSite, renderFromSite } from '../lib/live-render.js';
import { stripData } from './helpers.js';

const enc = new TextEncoder();

const blogJson = (extra = {}) => ({ title: 'T', description: 'D', author: 'Ada', domain: 'https://example.test', ...extra });
const front = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}\n`).join('');
const post = (slug, o = {}) => {
  const { body = `Words about ${slug}.`, ...meta } = o;
  return { path: `posts/${slug}.md`, text: `---\n${front({ slug, title: `Post ${slug}`, date: '2026-01-01', status: 'published', ...meta })}---\n\n${body}\n` };
};
const page = (slug, o = {}) => {
  const { body = `About ${slug}.`, ...meta } = o;
  return { path: `pages/${slug}.md`, text: `---\n${front({ slug, title: `Page ${slug}`, status: 'published', ...meta })}---\n\n${body}\n` };
};
const build = (blog, posts, extra = {}) => buildSite({ blog: blogJson(blog), posts, lock: {}, ...extra });
const ok = (blog, posts) => {
  const r = build(blog, posts);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r;
};
const POSTS = [
  post('alpha', { date: '2026-03-01', tags: ['video', 'git'] }),
  post('beta', { date: '2026-02-01', tags: ['video'] }),
  post('gamma', { date: '2025-12-01', tags: ['notes'] }),
  post('secret', { date: '2026-04-01', tags: ['hidden-tag'], status: 'draft' }),
];

// ---------- taxonomy ----------
test('taxonomy: slugs, groups, years and pages are deterministic', () => {
  assert.equal(slugify('Static HLS'), 'static-hls');
  assert.equal(slugify('Café'), 'cafe');
  assert.match(slugify('日本語'), /^x-[0-9a-f]{8}$/, 'a label with no letters or digits still gets an address of its own');
  const entries = [{ slug: 'a', date: '2026-01-02', tags: ['C++', 'x'] }, { slug: 'b', date: '2025-05-05', tags: ['c'] }, { slug: 'c', date: '2026-01-02', tags: [] }];
  const groups = groupTags(entries);
  assert.deepEqual(groups.map((g) => g.slug), ['c', 'x'], 'C++ and c share an address');
  assert.deepEqual(groups[0].labels, ['C++', 'c']);
  assert.deepEqual(byYear(entries).map((y) => [y.year, y.entries.map((e) => e.slug)]), [['2026', ['a', 'c']], ['2025', ['b']]], 'newest first, ties by slug');
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(paginate([1, 2], 5), [[1, 2]]);
  assert.deepEqual(paginate([1, 2], 0), [[1, 2]]);
});

// ---------- tags, archive, authors ----------
test('tags: one page per tag of a published post, the list of tags, and tag links everywhere a tag is shown; a draft makes none', () => {
  const { files } = ok({}, POSTS);
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith('tags/')).sort(), ['tags/git/index.html', 'tags/index.html', 'tags/notes/index.html', 'tags/video/index.html']);
  assert.ok(!Object.keys(files).some((f) => f.includes('hidden-tag')), 'a draft\'s tag has no page');
  const video = files['tags/video/index.html'];
  assert.ok(video.includes('<h1>Tagged “video”</h1>'));
  assert.ok(video.indexOf('Post alpha') < video.indexOf('Post beta'), 'in the blog\'s own order');
  assert.ok(!video.includes('Post gamma'));
  assert.ok(video.includes('href="../../alpha/"'), 'relative to where the page sits');
  assert.match(files['alpha/index.html'], /<a class="tag" href="\.\.\/tags\/video\/">#video<\/a>/);
  assert.match(files['index.html'], /<a class="tag" href="\.\/tags\/git\/">#git<\/a>/);
  assert.ok(files['tags/index.html'].includes('<a href="video/">video</a> <span class="count">(2)</span>'));
  assert.match(files['tags/video/index.html'], /<title>Posts tagged video · T<\/title>/);
});

test('archive: every published post by year, newest first, whatever the blog\'s own order', () => {
  const { files } = ok({ order: { by: 'title', dir: 'asc' } }, POSTS);
  const a = files['archive/index.html'];
  assert.ok(a.indexOf('id="y2026"') < a.indexOf('id="y2025"'));
  assert.ok(a.indexOf('Post alpha') < a.indexOf('Post beta') && a.indexOf('Post beta') < a.indexOf('Post gamma'));
  assert.ok(!a.includes('Post secret'));
  assert.match(a, /<li><time datetime="2026-03-01">2026-03-01<\/time> <a href="\.\.\/alpha\/">Post alpha<\/a><\/li>/);
});

test('the header menu lists the archive and tags, and only what exists', () => {
  const { files } = ok({}, POSTS);
  assert.match(files['alpha/index.html'], /<nav><a href="\.\.\/archive\/">Archive<\/a><a href="\.\.\/tags\/">Tags<\/a><a href="\.\.\/feed\.xml">Feed<\/a><\/nav>/);
  const none = ok({}, [post('only')]).files;
  assert.ok(!('tags/index.html' in none) && !/>Tags</.test(none['index.html']), 'no tags, no Tags link');
  const empty = ok({}, []).files;
  assert.ok(!('archive/index.html' in empty) && !/Archive/.test(empty['index.html']));
});

test('authors: pages only when more than one author writes; the byline links to them', () => {
  const one = ok({}, POSTS).files;
  assert.ok(!Object.keys(one).some((f) => f.startsWith('authors/')));
  assert.ok(!/href="[^"]*authors\//.test(one['alpha/index.html']));
  const many = ok({}, [post('a', { author: 'Bob Roberts' }), post('b'), post('c', { author: 'bob-roberts' })]).files;
  assert.deepEqual(Object.keys(many).filter((f) => f.startsWith('authors/')).sort(), ['authors/ada/index.html', 'authors/bob-roberts/index.html']);
  assert.match(many['a/index.html'], /· <a href="\.\.\/authors\/bob-roberts\/">Bob Roberts<\/a>/);
  assert.ok(many['authors/bob-roberts/index.html'].includes('Post a') && many['authors/bob-roberts/index.html'].includes('Post c') && !many['authors/bob-roberts/index.html'].includes('Post b'));
  assert.match(many['authors/ada/index.html'], /<h1>Ada<\/h1>/);
});

test('the wordpress-classic contract gets the same links and pages', () => {
  const r = buildSite({ blog: blogJson({ theme: 'default' }), posts: POSTS, lock: {} });
  assert.deepEqual(r.errors, []);
});

// ---------- sitemap and robots ----------
test('sitemap: published posts, the pages made of them, in a fixed order; no drafts; robots.txt only at the root of a host', () => {
  const { files } = ok({}, POSTS);
  const locs = [...files['sitemap.xml'].matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace('https://example.test', ''));
  assert.deepEqual(locs, ['/', '/alpha/', '/beta/', '/gamma/', '/archive/', '/tags/', '/tags/git/', '/tags/notes/', '/tags/video/']);
  assert.ok(!files['sitemap.xml'].includes('secret') && !files['sitemap.xml'].includes('hidden-tag'));
  assert.match(files['sitemap.xml'], /<loc>https:\/\/example\.test\/alpha\/<\/loc><lastmod>2026-03-01<\/lastmod>/, 'dates are the authored ones');
  assert.equal(files['robots.txt'], 'User-agent: *\nAllow: /\n\nSitemap: https://example.test/sitemap.xml\n');
  const inFolder = ok({ domain: 'https://me.github.io/blog' }, POSTS).files;
  assert.ok('sitemap.xml' in inFolder && !('robots.txt' in inFolder), 'a blog in a folder of a host has no say in its robots.txt');
  assert.match(inFolder['sitemap.xml'], /<loc>https:\/\/me\.github\.io\/blog\/alpha\/<\/loc>/);
  const off = ok({ seo: { sitemap: false } }, POSTS).files;
  assert.ok(!('sitemap.xml' in off) && !('robots.txt' in off));
  const noRobots = ok({ seo: { robots: false } }, POSTS).files;
  assert.ok('sitemap.xml' in noRobots && !('robots.txt' in noRobots));
});

// ---------- pagination ----------
test('pagination: absent, one list as before; present, pages with previous/next that exist, in <head> and in the page', () => {
  const posts = ['a', 'b', 'c', 'd', 'e'].map((s, i) => post(s, { date: `2026-01-0${i + 1}`, tags: ['t'] }));
  const whole = ok({}, posts).files;
  assert.ok(!Object.keys(whole).some((f) => f.startsWith('page/')));
  for (const s of ['a', 'e']) assert.ok(whole['index.html'].includes(`href="${s}/"`));
  assert.ok(!whole['index.html'].includes('class="pagination'));

  const { files } = ok({ pagination: { size: 2 } }, posts);
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith('page/')).sort(), ['page/2/index.html', 'page/3/index.html']);
  const p1 = files['index.html'];
  assert.ok(p1.includes('href="e/"') && p1.includes('href="d/"') && !p1.includes('href="c/"'));
  assert.match(p1, /<link rel="next" href="page\/2\/">/);
  assert.ok(!/<link rel="prev"/.test(p1), 'the first page has no previous, absent and not disabled');
  assert.match(p1, /<a rel="next" href="page\/2\/">Next page →<\/a>/);
  assert.ok(!/rel="prev" href/.test(p1.replace(/<head>[\s\S]*<\/head>/, '')));
  const p2 = files['page/2/index.html'];
  assert.ok(p2.includes('href="../../c/"') && p2.includes('href="../../b/"'));
  assert.match(p2, /<link rel="prev" href="\.\.\/\.\.\/"><link rel="next" href="\.\.\/3\/">|<link rel="prev" href="\.\.\/\.\.\/">\n<link rel="next" href="\.\.\/3\/">/);
  assert.match(p2, /Page 2 of 3/);
  const p3 = files['page/3/index.html'];
  assert.ok(!/<link rel="next"/.test(p3) && /<link rel="prev" href="\.\.\/2\/">/.test(p3));
  assert.match(p3, /<link rel="canonical" href="https:\/\/example\.test\/page\/3\/">/);
  // a tag with more posts than a page holds is paged too, under its own folder
  assert.ok('tags/t/page/3/index.html' in files);
  assert.match(files['tags/t/page/2/index.html'], /<link rel="prev" href="\.\.\/\.\.\/">/);
  // the index records every post: pagination is a presentation of it, never a cut
  assert.equal(JSON.parse(files['index/posts.json']).posts.length, 5);
  assert.deepEqual(Object.keys(ok({ pagination: { size: 5 } }, posts).files).filter((f) => f.startsWith('page/')), [], 'exactly one page is no pagination');
});

test('pagination and the other settings are validated, and refused rather than guessed', () => {
  for (const [patch, why] of [
    [{ pagination: { size: 0 } }, /pagination\.size/],
    [{ pagination: { size: 'ten' } }, /pagination\.size/],
    [{ pagination: { size: 5, extra: 1 } }, /not a field/],
    [{ search: 'yes' }, /search/],
    [{ seo: { twitter: 'name' } }, /seo\.twitter/],
    [{ seo: { sitemap: 'no' } }, /seo\.sitemap/],
    [{ comments: { src: 'http://x.test/c.js' } }, /https/],
    [{ comments: { src: 'https://x.test/c.js', attrs: { onload: 'x()' } } }, /not allowed/],
    [{ analytics: { src: 'https://x.test/a.js', attrs: { 'data-x': 'a'.repeat(400) } } }, /300/],
    [{ analytics: { src: 'https://x.test/a.js', extra: 1 } }, /not a field/],
    [{ subscribe: { action: 'http://x.test/s' } }, /https/],
    [{ subscribe: { action: 'https://x.test/s', field: 'a b' } }, /field/],
  ]) assert.throws(() => validateBlog(blogJson(patch)), (e) => e.code === 'bad-blog-json' && why.test(e.detail), JSON.stringify(patch));
});

// ---------- search ----------
test('search: opt in, a search page, a search.json of published posts only, and one same-origin script on that page alone', () => {
  const off = ok({}, POSTS).files;
  assert.ok(!('search/index.html' in off) && !('search.json' in off) && !('webcli-search.js' in off));
  assert.ok(!/Search/.test(off['index.html']));
  const { files } = ok({ search: true }, POSTS);
  assert.equal(files['webcli-search.js'], SEARCH_SOURCE);
  const index = JSON.parse(files['search.json']);
  assert.deepEqual(index.posts.map((p) => p.slug), ['alpha', 'beta', 'gamma'], 'a draft is not searchable');
  assert.deepEqual(Object.keys(index.posts[0]).sort(), ['date', 'excerpt', 'slug', 'tags', 'text', 'title']);
  assert.ok(index.posts[0].text.includes('Words about alpha.'));
  const s = files['search/index.html'];
  assert.deepEqual([...s.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="../webcli-search.js">']);
  assert.match(s, /<meta name="robots" content="noindex">/);
  assert.ok(s.includes('data-nojs') && s.includes('href="../archive/"'), 'without scripting it says so and points at the archive');
  assert.match(files['alpha/index.html'], /<a href="\.\.\/search\/">Search<\/a>/);
  for (const [f, html] of Object.entries(files)) if (f.endsWith('.html') && f !== 'search/index.html') assert.ok(!/<script\b/i.test(stripData(html)), `${f}: no other page loads a script`);
  assert.match(files['index.html'], /"potentialAction":\{"@type":"SearchAction","target":\{"@type":"EntryPoint","urlTemplate":"https:\/\/example\.test\/search\/\?q=\{search_term_string\}"/);
  assert.match(files['sitemap.xml'], /^((?!search\/).)*$/s, 'a results page is not worth indexing');
});

test('search: the script ships as one string and ranks by title, tags, excerpt then body; every term must match', () => {
  assert.ok(SEARCH_SOURCE.length > 500 && SEARCH_SOURCE.length < 6000);
  assert.deepEqual(tokenize('  Static,  HLS-in git! '), ['static', 'hls', 'in', 'git']);
  const posts = [
    { slug: 'body', title: 'Notes', tags: [], excerpt: '', text: 'we talk about hls here, and hls again' },
    { slug: 'title', title: 'All about HLS', tags: [], excerpt: '', text: '' },
    { slug: 'tag', title: 'Other', tags: ['hls'], excerpt: '', text: '' },
    { slug: 'none', title: 'Unrelated', tags: [], excerpt: '', text: 'nothing' },
  ];
  assert.deepEqual(rank(posts, 'hls').map((x) => x.post.slug), ['title', 'tag', 'body']);
  assert.deepEqual(rank(posts, 'hls notes').map((x) => x.post.slug), ['body'], 'every term must match');
  assert.deepEqual(rank(posts, '   '), []);
  assert.deepEqual(rank(posts, 'zzz'), []);
  assert.equal(snippet(posts[0], 'hls'), 'we talk about hls here, and hls again');
  assert.equal(snippet({ text: 'x'.repeat(300) + ' needle ' + 'y'.repeat(300), excerpt: 'e' }, 'needle').startsWith('… '), true);
  const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
  const s = snippet({ text: long }, 'kilo', 60);
  assert.ok(s.startsWith('… ') && s.endsWith(' …') && s.includes('kilo'));
  for (const w of s.replace(/^… | …$/g, '').split(' ')) assert.ok(long.split(' ').includes(w), `"${w}" is a whole word, not half of one`);
  const first = snippet({ text: long }, 'alpha', 30);
  assert.ok(first.startsWith('alpha') && first.endsWith(' …'));
  for (const w of first.replace(/ …$/, '').split(' ')) assert.ok(long.split(' ').includes(w), w);
  assert.equal(snippet(posts[1], 'hls'), '');
  assert.equal(snippet({ text: '', excerpt: 'only the excerpt' }, 'q'), 'only the excerpt');
  // equal scores keep the blog's own order
  const tie = [{ slug: 'x', title: 'a', tags: [], text: 'k' }, { slug: 'y', title: 'a', tags: [], text: 'k' }];
  assert.deepEqual(rank(tie, 'k').map((r) => r.post.slug), ['x', 'y']);
});

// ---------- JSON-LD and per-post SEO ----------
const ld = (html) => JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)[1]);

test('JSON-LD: a BlogPosting per post, a WebSite on the index; data only, and nothing in it can end the script', () => {
  const posts = [post('alpha', { date: '2026-03-01', tags: ['video', 'git'], author: 'Bob', description: 'Why </script><script>alert(1)</script> & more' })];
  const { files } = ok({}, posts);
  const html = files['alpha/index.html'];
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.ok(!html.includes('</script><script>alert'), 'the description cannot close the element');
  const d = ld(html);
  assert.equal(d['@type'], 'BlogPosting');
  assert.equal(d.headline, 'Post alpha');
  assert.equal(d.description, 'Why </script><script>alert(1)</script> & more');
  assert.equal(d.datePublished, '2026-03-01');
  assert.deepEqual(d.author, { '@type': 'Person', name: 'Bob' });
  assert.equal(d.mainEntityOfPage['@id'], 'https://example.test/alpha/');
  assert.equal(d.keywords, 'video, git');
  assert.equal(d.wordCount, 3);
  assert.equal(ld(files['index.html'])['@type'], 'WebSite');
  assert.ok(!('potentialAction' in ld(files['index.html'])), 'no search, no search action');
});

test('per-post SEO: a search title, a share image, a canonical address, noindex; each is the author\'s say and nothing else changes', () => {
  const lock = { 'images/share.png': 'a'.repeat(40) };
  const blog = blogJson({ assets: { base: 'https://img.test/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/images' } } });
  const posts = [
    post('plain'),
    post('seo', { seo_title: 'A better title for search', image: 'asset:images/share.png', description: 'Custom description.' }),
    post('moved', { canonical: 'https://elsewhere.test/original/' }),
    post('quiet', { noindex: 'true' }),
  ];
  const r = buildSite({ blog, posts, lock });
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const seo = r.files['seo/index.html'];
  assert.match(seo, /<title>A better title for search<\/title>/);
  assert.match(seo, /<meta property="og:title" content="A better title for search">/);
  assert.match(seo, /<meta property="og:image" content="https:\/\/img\.test\/me\/images@a{40}\/share\.png">/);
  assert.match(seo, /<meta name="description" content="Custom description\.">/);
  assert.match(r.files['plain/index.html'], /<title>Post plain · T<\/title>/);
  const moved = r.files['moved/index.html'];
  assert.match(moved, /<link rel="canonical" href="https:\/\/elsewhere\.test\/original\/">/);
  assert.match(moved, /<meta property="og:url" content="https:\/\/elsewhere\.test\/original\/">/);
  assert.match(r.files['quiet/index.html'], /<meta name="robots" content="noindex">/);
  assert.ok(!/name="robots"/.test(r.files['plain/index.html']));
  const sm = r.files['sitemap.xml'];
  assert.ok(sm.includes('/plain/') && sm.includes('/seo/') && !sm.includes('/moved/') && !sm.includes('/quiet/'), 'left out of the sitemap, still in the index and the feed');
  assert.ok(JSON.parse(r.files['index/posts.json']).posts.some((p) => p.slug === 'quiet'));
  assert.ok(r.files['feed.xml'].includes('/quiet/'));
  // an image that is not pinned is refused like any other asset
  assert.deepEqual(buildSite({ blog, posts: [post('seo', { image: 'asset:images/share.png' })], lock: {} }).errors.map((e) => e.code), ['unresolved-asset']);
  for (const [patch, why] of [[{ canonical: 'ftp://x' }, /canonical/], [{ noindex: 'maybe' }, /noindex/], [{ image: 'https://x.test/a.png' }, /image/], [{ menu: '3' }, null]]) {
    const out = buildSite({ blog: blogJson(), posts: [post('x', patch)], lock: {} });
    if (why) assert.ok(out.errors.length && why.test(out.errors[0].detail), JSON.stringify(patch));
  }
  assert.match(ok({ seo: { twitter: '@ada' } }, [post('t')]).files['t/index.html'], /<meta name="twitter:site" content="@ada">/);
});

// ---------- embeds ----------
test('embeds: comments under a post, analytics on every page, a subscribe form; each is a blog.json address, and off by default', () => {
  const plain = ok({}, POSTS).files;
  for (const [f, html] of Object.entries(plain)) if (f.endsWith('.html')) assert.ok(!/<form\b|class="comments"|<script src=/.test(html), `${f}: nothing third-party by default`);

  const { files } = ok({
    comments: { src: 'https://comments.test/client.js', attrs: { 'data-repo': 'me/blog', crossorigin: 'anonymous' }, title: 'Discussion' },
    analytics: { src: 'https://stats.test/count.js', attrs: { 'data-domain': 'example.test' } },
    subscribe: { action: 'https://news.test/subscribe', field: 'em', hidden: { list: 'abc' }, title: 'Get the next one', button: 'Join' },
  }, POSTS);
  const p = files['alpha/index.html'];
  assert.match(p, /<section class="comments" id="comments" aria-label="Discussion"><script src="https:\/\/comments\.test\/client\.js" async data-repo="me\/blog" crossorigin="anonymous"><\/script><\/section>/);
  assert.match(p, /<form class="subscribe" method="post" action="https:\/\/news\.test\/subscribe"><label for="subscribe-em">Get the next one<\/label> <input id="subscribe-em" type="email" name="em" placeholder="you@example\.com" autocomplete="email" required><input type="hidden" name="list" value="abc"> <button type="submit">Join<\/button><\/form>/);
  assert.ok(p.indexOf('class="subscribe"') < p.indexOf('class="comments"') && p.indexOf('class="comments"') < p.indexOf('<footer'));
  for (const f of ['index.html', 'alpha/index.html', 'tags/video/index.html', 'archive/index.html']) assert.ok(files[f].includes('<script src="https://stats.test/count.js" defer data-domain="example.test"></script>'), f);
  assert.ok(!files['index.html'].includes('comments.test') && files['index.html'].includes('class="subscribe"'), 'comments are for posts; the home page has the form');
  assert.ok(!files['archive/index.html'].includes('class="subscribe"'));
  // the analytics script is placed once, and a page never gets a handler or inline code from this
  for (const html of Object.values(files)) if (typeof html === 'string') assert.ok(!/\son[a-z]+=|javascript:/.test(html.replace(/<style>[\s\S]*?<\/style>/g, '')));
});

// ---------- standalone pages ----------
test('pages: pages/<slug>.md becomes <slug>/ with no date, author or tags; a menu position puts it in the header; drafts do not exist', () => {
  const pages = [page('about', { menu: 2, description: 'Who writes this.' }), page('contact', { menu: 1 }), page('colophon'), page('hush', { status: 'draft', menu: 3 })];
  const { files, index, pages: info } = ok({}, [...POSTS, ...pages]);
  const about = files['about/index.html'];
  assert.match(about, /<h1>Page about<\/h1>/);
  assert.ok(!/class="meta"/.test(about), 'no date or byline');
  assert.match(about, /<meta property="og:type" content="website">/);
  assert.equal(ld(about)['@type'], 'WebPage');
  assert.match(about, /<meta name="description" content="Who writes this\.">/);
  assert.ok(!/post-nav|rel="prev"|class="comments"|class="subscribe"/.test(about.replace(/<style>[\s\S]*?<\/style>/, '')));
  assert.ok(!('hush/index.html' in files) && !files['sitemap.xml'].includes('hush'), 'a draft page is invisible');
  assert.ok(files['alpha/index.html'].includes('<nav><a href="../contact/">Page contact</a><a href="../about/">Page about</a><a href="../archive/">Archive</a>'), 'menu pages first, lowest position first');
  assert.ok(!files['alpha/index.html'].includes('colophon'), 'a page with no menu value is not in the header');
  assert.deepEqual(info, [{ slug: 'about', title: 'Page about', menu: 2 }, { slug: 'colophon', title: 'Page colophon' }, { slug: 'contact', title: 'Page contact', menu: 1 }], 'sorted by slug, so the index does not depend on the order files were read in');
  assert.ok(!index.some((e) => ['about', 'contact', 'colophon'].includes(e.slug)), 'pages are not posts: not in the index, feed, archive or tags');
  assert.ok(!files['feed.xml'].includes('/about/') && !/<li><time[^>]*>[^<]*<\/time> <a href="\.\.\/about\//.test(files['archive/index.html']));
  assert.ok(files['sitemap.xml'].includes('https://example.test/about/') && files['sitemap.xml'].includes('https://example.test/colophon/'));
  assert.deepEqual(JSON.parse(files['index/posts.json']).pages.map((p) => p.slug).sort(), ['about', 'colophon', 'contact'], 'the index records the pages so a renderer can rebuild the menu');
});

test('pages: refusals', () => {
  const codes = (posts, blog = {}) => buildSite({ blog: blogJson(blog), posts, lock: {} }).errors.map((e) => e.code);
  assert.deepEqual(codes([post('same'), page('same')]), ['slug-collision'], 'posts and pages share one address space');
  for (const slug of ['tags', 'authors', 'archive', 'search', 'page']) assert.deepEqual(codes([post(slug)]), ['slug-collision'], slug);
  assert.deepEqual(codes([page('about', { tags: ['x'] })]), ['bad-frontmatter']);
  assert.deepEqual(codes([page('about', { menu: 'first' })]), ['bad-frontmatter']);
  assert.deepEqual(codes([{ path: 'pages/wrong.md', text: page('about').text }]), ['slug-mismatch']);
  assert.deepEqual(codes([{ ...page('about'), text: page('about').text.replace('\n', '\r\n') }]), ['lossy-round-trip']);
  assert.deepEqual(codes([page('about', { image: 'asset:images/x.png' })], { assets: { base: 'https://i.test/{sha}/{path}', repos: { images: 'me/images' } } }), ['unresolved-asset']);
});

// ---------- determinism and the live renderer ----------
test('the same blog regenerates byte for byte, whatever order its files arrive in', () => {
  const blog = { search: true, pagination: { size: 2 }, comments: { src: 'https://c.test/c.js' }, subscribe: { action: 'https://n.test/s' } };
  const posts = [...POSTS, post('delta', { date: '2026-03-01', tags: ['Video', 'git'], author: 'Bob' }), page('about', { menu: 1 })];
  const a = ok(blog, posts).files;
  const b = ok(blog, [...posts].reverse()).files;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const k of Object.keys(a)) assert.equal(a[k], b[k], k);
  const c = ok(blog, posts).files;
  for (const k of Object.keys(a)) assert.equal(a[k], c[k], `${k} (second run)`);
});

test('L5 with every feature on: rebuilding a post from the live files is byte-identical to the generator', async () => {
  const blog = blogJson({ repo: 'me/blog', content: { base: 'https://content.test/{owner}/{repo}/{ref}/{path}' }, search: true, comments: { src: 'https://c.test/c.js', attrs: { 'data-x': 'y' } }, subscribe: { action: 'https://n.test/s' }, analytics: { src: 'https://s.test/a.js' }, seo: { twitter: '@ada' }, pagination: { size: 2 } });
  const posts = [post('alpha', { date: '2026-03-01', tags: ['video'], author: 'Bob', seo_title: 'Custom', noindex: 'true' }), post('beta', { date: '2026-02-01', tags: ['git', 'video'] }), post('gamma', { date: '2025-12-01' }), page('about', { menu: 1 }), page('team', { menu: 2 })];
  const r = ok(blog, posts);
  const map = new Map(Object.entries(r.files));
  map.set('blog.json', JSON.stringify(blog));
  map.set('assets.lock.json', '{}');
  const site = await loadSite(async (p) => (map.has(p) ? enc.encode(map.get(p)) : null));
  for (const p of posts.filter((x) => x.path.startsWith('posts/'))) {
    const slug = p.path.replace(/^posts\/|\.md$/g, '');
    assert.equal(renderFromSite(site, { slug, text: p.text }).html, r.files[`${slug}/index.html`], slug);
  }
});

test('generated pages never name a provider and every internal link in a listing resolves to a file', () => {
  const { files } = ok({ search: true, pagination: { size: 1 } }, [...POSTS, page('about', { menu: 1 })]);
  const dirs = new Set(Object.keys(files).filter((f) => f.endsWith('/index.html')).map((f) => f.slice(0, -'index.html'.length)));
  dirs.add('');
  for (const [f, html] of Object.entries(files)) {
    if (!f.endsWith('.html')) continue;
    const here = f.slice(0, -'index.html'.length);
    for (const m of html.matchAll(/<a (?:class="[^"]*" )?(?:rel="[^"]*" )?href="((?:\.\.?\/)[^"#]*)"/g)) {
      const target = new URL(m[1], `https://x.test/${here}`).pathname.slice(1);
      if (/\.[a-z]+$/.test(target)) assert.ok(target in files, `${f}: ${m[1]}`);
      else assert.ok(dirs.has(target), `${f}: ${m[1]} -> ${target}`);
    }
  }
});

// ---------- responsive ----------
import { indexBody } from '../lib/contracts.js';
import { THEME_RESPONSIVE, THEMES } from '../lib/theme.js';
import { themeCss } from '../lib/customize.js';

test('responsive: the default theme and, after every pinned theme, a layer that keeps any page inside the screen', () => {
  assert.match(THEMES.default, /@media \(max-width:640px\)/);
  assert.match(THEMES.default, /table\{display:block;max-width:100%;overflow-x:auto/);
  const pinned = themeCss({ customize: { css: 'p{margin:0}' } }, { css: '.theme-rule{color:red}' });
  const at = (s) => pinned.indexOf(s);
  assert.ok(at('.theme-rule{color:red}') < at('@media (max-width:782px)') && at('@media (max-width:782px)') < at('p{margin:0}'), 'after the theme, before the blog\'s own css');
  assert.ok(pinned.includes(THEME_RESPONSIVE));
  for (const need of ['img,svg,canvas,video,iframe,embed,object{max-width:100%}', 'overflow-wrap:break-word', '.page-title,h1.entry-title{font-size:clamp(', '--global--font-size-page-title:2.25rem', '.nav-links,.post-nav,.pagination .nav-links{flex-wrap:wrap']) assert.ok(THEME_RESPONSIVE.includes(need), need);
  assert.ok(!/\.alignwide/.test(THEME_RESPONSIVE), 'a classic theme\'s own margins are left to it');
});

test('responsive: a listing page under the classic contract has the heading, the column and the content classes a classic theme styles', () => {
  const blog = { title: 'T', description: 'D', author: 'A', domain: 'https://x.test' };
  const d = { blog, entries: [], hrefFor: (s) => s, home: '../', feed: '../feed.xml', heading: 'Archive', intro: '2 posts', prose: true, indexHtml: '<h2 id="y2026">2026</h2>' };
  const html = indexBody('wordpress-classic', d).html;
  assert.match(html, /<header class="page-header alignwide"><h1 class="page-title">Archive<\/h1><div class="archive-description"><p>2 posts<\/p><\/div><\/header>/);
  assert.match(html, /<div class="entry-content">\n<h2 id="y2026">2026<\/h2>\n<\/div>/);
  assert.match(html, /<p class="site-title">/, 'the page title is the one h1, so the site title is not');
  assert.match(indexBody('wordpress-classic', { ...d, heading: undefined, indexHtml: undefined }).html, /<h1 class="site-title">/, 'the home page keeps its site title as the h1');
  assert.ok(!indexBody('blog-webcli-v1', d).html.includes('entry-content'));
  const { files } = buildSite({ blog: blogJson({ pagination: { size: 1 } }), posts: [post('a', { date: '2026-02-01' }), post('b', { date: '2026-01-01' })], lock: {} });
  assert.match(files['index.html'], /<nav class="navigation pagination" aria-label="Pages"><div class="nav-links"><span class="page-of">Page 1 of 2<\/span><a rel="next" href="page\/2\/">Next page →<\/a><\/div><\/nav>/);
});
