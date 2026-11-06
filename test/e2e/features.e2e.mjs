// End to end, in real Chrome. Two things a unit test cannot see:
//   1. a generated site with search, tags, an archive and pagination, served as GitHub Pages would: the search page
//      really finds posts, writes its results as text (a post's words are never markup), and no page makes a request
//      to a third party that blog.json did not name;
//   2. the editor, against an in-memory GitHub: a standalone page can be written and published, a post has its search
//      and sharing fields, and the settings screen turns the features on.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../lib/blog.js';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const post = (slug, title, body, o = {}) => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: ${title}\ndate: ${o.date || '2026-11-06'}\n${o.tags ? `tags: [${o.tags}]\n` : ''}status: published\n---\n\n${body}\n` });

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await page.evaluate(`Boolean(${expr})`);
    } catch {
      /* navigating */
    }
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}\n--- page says:\n${await page.evaluate("(document.querySelector('.toast.error') || document.querySelector('.toast.success') || {}).innerText || '(nothing)'").catch(() => '?')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const go = async (page, url) => {
  await page.evaluate(`location.href = ${JSON.stringify(url)}; 0`).catch(() => {});
  const u = new URL(url);
  await until(page, `location.pathname === ${JSON.stringify(u.pathname)} && document.readyState === 'complete'`);
};

// ---------- 1. the generated site ----------
test('search: the page finds posts in the browser, writes results as text, and nothing else is requested', { skip, timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blog-features-'));
  const server = await serve(dir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const blog = { title: 'Found', description: 'd', author: 'A', domain: origin, theme: 'default', search: true, pagination: { size: 2 } };
  const posts = [
    post('hls', 'Static HLS in git', 'Segments are static files, so git can hold them.', { date: '2026-11-03', tags: 'video, git' }),
    post('markdown', 'Markdown is the format', 'Plain text with \\<img src=x onerror=window.pwned=1> in it.', { date: '2026-11-02', tags: 'writing' }),
    post('feeds', 'A feed is a site, part of the web', 'RSS and Atom, and why a blog without one is not part of it.', { date: '2026-11-01', tags: 'writing' }),
  ];
  const built = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(built.errors, []);
  for (const [rel, text] of Object.entries(built.files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${origin}/`);
    await until(page, 'document.readyState === "complete"');

    // the home page is paged, links forward, and its header leads to the archive, the tags and search
    assert.match(await page.evaluate('document.body.innerText'), /Page 1 of 2/);
    assert.equal(await page.evaluate("document.querySelectorAll('ul.posts li').length"), 2);
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('header.site nav a')].map((a) => a.textContent)"), ['Archive', 'Tags', 'Search', 'Feed']);
    await go(page, `${origin}/page/2/`);
    assert.match(await page.evaluate('document.body.innerText'), /A feed is a site/);
    assert.equal(await page.evaluate("document.querySelector('link[rel=prev]').href"), `${origin}/`);

    // search by a word in the body, with the query in the address
    await go(page, `${origin}/search/?q=segments`);
    await until(page, "document.querySelectorAll('[data-results] li').length === 1");
    assert.equal(await page.evaluate("document.querySelector('[data-results] a').textContent"), 'Static HLS in git');
    assert.equal(await page.evaluate("document.querySelector('[data-results] a').pathname"), '/hls/');
    assert.equal(await page.evaluate("document.querySelector('[data-nojs]')"), null, 'the no-script note goes once the script runs');
    assert.match(await page.evaluate("document.querySelector('[data-status]').textContent"), /1 result/);

    // typing a query and submitting it; a post's words are text, never markup
    await page.evaluate("(() => { const i = document.querySelector('input[type=search]'); i.value = 'plain text'; i.form.requestSubmit(); })()");
    await until(page, "document.querySelector('[data-results] a') && document.querySelector('[data-results] a').pathname === '/markdown/'");
    assert.match(await page.evaluate("document.querySelector('[data-results]').innerText"), /<img src=x onerror=window\.pwned=1>/, 'shown as the words they are');
    assert.equal(await page.evaluate("document.querySelector('[data-results] img')"), null);
    assert.equal(await page.evaluate('window.pwned'), undefined);
    assert.match(await page.evaluate('location.search'), /q=plain/, 'the query is kept in the address');

    // nothing found, and a query with no letters
    await page.evaluate("(() => { const i = document.querySelector('input[type=search]'); i.value = 'zzzz'; i.form.requestSubmit(); })()");
    await until(page, "document.querySelector('[data-status]').textContent === 'Nothing found.'");
    assert.equal(await page.evaluate("document.querySelectorAll('[data-results] li').length"), 0);

    // tag and archive pages exist and agree with the posts
    await go(page, `${origin}/tags/writing/`);
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('ul.posts h2 a')].map((a) => a.textContent)"), ['Markdown is the format', 'A feed is a site, part of the web']);
    await go(page, `${origin}/archive/`);
    assert.equal(await page.evaluate("document.querySelectorAll('ul.archive li').length"), 3);

    // every script any page of the site loaded was the search script, and only the search page loaded it
    await go(page, `${origin}/hls/`);
    assert.equal(await page.evaluate("document.querySelectorAll('script[src]').length"), 0);
    assert.equal(await page.evaluate("JSON.parse(document.querySelector('script[type=\"application/ld+json\"]').textContent)['@type']"), 'BlogPosting');
    const requested = await page.evaluate("performance.getEntriesByType('resource').map((e) => new URL(e.name).origin)");
    assert.deepEqual([...new Set(requested)].filter((o) => o !== origin), [], 'no request left this origin');
  } finally {
    chrome.close();
    server.close();
  }
});

// ---------- 2. the editor ----------
const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default' });

async function appSite() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-features-app-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': Buffer.from(BLOG).toString('base64') } })};\n`);
  return copy;
}
const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  const fake = m.fakeGitHub(repos);
  await fake.ready;
  window.__fake = fake;
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (new URL(u, location.href).origin === location.origin ? real(u, o) : fake.fetch(u, o));
`;
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const setValue = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); })()`);
const commit = async (page) => {
  await until(page, "document.querySelector('dialog[open] .preflight')");
  await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0");
  await clickText(page, 'dialog button', 'Commit and push');
  await until(page, '!document.querySelector("dialog[open]")', 30000);
  await until(page, "document.querySelector('.toast.success')");
};

test('editor: a standalone page is written and published; a post has search and sharing fields; settings turn the features on', { skip, timeout: 180000 }, async () => {
  const web = await serve(await appSite());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");

    // a post: the search and sharing fields, and an author, are there and are saved only when filled in
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('details.more').open = true; 0");
    const text = await page.evaluate("document.querySelector('#view').innerText");
    for (const label of ['Search and sharing', 'Search title', 'Share image', 'Canonical address', 'Keep out of search', 'Author']) assert.ok(text.includes(label), label);
    assert.ok(!text.includes('Menu position'), 'that is for pages');
    await setValue(page, '#view input[placeholder=Title]', 'Hello');
    await setValue(page, '#view input[placeholder^="set once"]', 'hello');
    await setValue(page, '#view input[placeholder="Optional; defaults to the title"]', 'Hello, search engines');
    await page.evaluate("document.querySelector('details.more input[type=checkbox]').click(); 0");
    await page.evaluate("(() => { const s = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === 'published')); s.value = 'published'; s.dispatchEvent(new Event('change')); })()");
    await clickText(page, '#view button', 'Publish');
    await commit(page);
    const saved = await page.evaluate("window.__fake.files('example/blog')");
    assert.match(saved['posts/hello.md'], /\nseo_title: Hello, search engines\n/);
    assert.match(saved['posts/hello.md'], /\nnoindex: true\n/);
    assert.match(saved['hello/index.html'], /<meta name="robots" content="noindex">/);
    assert.ok(!saved['sitemap.xml'].includes('/hello/'), 'noindex keeps it out of the sitemap');

    // a page: no date, tags or author; a menu position
    await page.evaluate("location.hash = '#repo=example/blog&newpage'; 0");
    await until(page, "document.querySelector('.ql-editor') && !document.querySelector('#view input[placeholder=Title]').value");
    const pageText = await page.evaluate("document.querySelector('#view').innerText");
    assert.match(pageText, /New page/);
    assert.ok(pageText.includes('Menu position') && !/\bTags\b/.test(pageText) && !/\bDate\b/.test(pageText));
    await setValue(page, '#view input[placeholder=Title]', 'About');
    assert.equal(await page.evaluate("document.querySelector('#view input[placeholder^=\"set once\"]').value"), 'about', 'the slug follows the title until it is touched');
    await page.evaluate("document.querySelector('#view input[type=number]').value = '1'; 0");
    await page.evaluate("(() => { const s = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === 'published')); s.value = 'published'; s.dispatchEvent(new Event('change')); })()");
    await page.evaluate("document.querySelector('.ql-editor').innerHTML = '<p>Who writes this.</p>'; document.querySelector('.ql-editor').dispatchEvent(new Event('input', { bubbles: true })); 0");
    await clickText(page, '#view button', 'Publish');
    await commit(page);
    const after = await page.evaluate("window.__fake.files('example/blog')");
    assert.match(after['pages/about.md'], /^---\nslug: about\ntitle: About\nstatus: published\nmenu: "?1"?\n---\n\nWho writes this\.\n$/);
    assert.ok(!/\ndate:/.test(after['pages/about.md']));
    assert.match(after['about/index.html'], /<h1>About<\/h1>/);
    assert.match(after['hello/index.html'], /<a href="\.\.\/about\/">About<\/a>/, 'a menu page is in every header');
    assert.ok(!JSON.parse(after['index/posts.json']).posts.some((p) => p.slug === 'about'));
    assert.equal(await page.evaluate('location.hash'), '#repo=example/blog&editpage=about', 'it reopens as a page');

    // the page list
    await page.evaluate("location.hash = '#repo=example/blog'; 0");
    await until(page, "[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim() === 'Pages')");
    await clickText(page, '#view button', 'Pages');
    await until(page, "[...document.querySelectorAll('#view h3')].some((h) => h.textContent.trim() === 'About')");
    assert.ok((await page.evaluate("document.querySelector('#view').innerText")).includes('In the menu, position 1'));

    // settings: the new sections, and turning search and pagination on
    await page.evaluate("location.hash = '#repo=example/blog&settings'; 0");
    await until(page, "document.querySelector('#view fieldset')");
    const settings = await page.evaluate("[...document.querySelectorAll('#view legend')].map((l) => l.textContent)");
    for (const s of ['Readers', 'Search engines', 'Comments and analytics']) assert.ok(settings.includes(s), s);
    await page.evaluate("[...document.querySelectorAll('#view label.check')].find((l) => l.textContent.includes('Add a search page')).querySelector('input').click(); 0");
    await setValue(page, '#view input[type=number][max="100"]', '5');
    await clickText(page, '#view button', 'Save settings');
    await commit(page);
    const done = await page.evaluate("window.__fake.files('example/blog')");
    assert.equal(JSON.parse(done['blog.json']).search, true);
    assert.deepEqual(JSON.parse(done['blog.json']).pagination, { size: 5 });
    for (const f of ['search/index.html', 'search.json', 'webcli-search.js']) assert.ok(f in done, f);
    assert.ok(!JSON.parse(done['search.json']).posts.some((p) => p.slug === 'about'), 'pages are not in the post search');
  } finally {
    chrome.close();
    web.close();
  }
});
