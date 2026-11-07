// End to end, in real Chrome: the WordPress import wizard, from the home page to a commit in an in-memory GitHub. The "old
// site" is a local server that allows cross-origin reads (as a site with a CDN in front often does) and logs every request, so
// the test can say what the page asked it for: pictures, no cookie, no token, no referrer.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { PNG, WXR } from '../wp-fixtures.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72]);

async function oldSite({ cors = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: decodeURIComponent(req.url), cookie: req.headers.cookie, auth: req.headers.authorization, referer: req.headers.referer });
    const p = decodeURIComponent(req.url);
    const headers = cors ? { 'access-control-allow-origin': '*' } : {};
    if (p.endsWith('/dog.jpg')) return res.writeHead(200, headers).end(Buffer.from(JPG));
    if (p.endsWith('/paper.pdf')) return res.writeHead(200, headers).end(Buffer.from('%PDF-1.4 a paper'));
    if (p.endsWith('/cat.jpg') || p.endsWith('/My Unused Photo.JPG')) return res.writeHead(200, headers).end(Buffer.from(PNG));
    res.writeHead(404, headers).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}

async function appSite() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-import-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'me/site': { 'README.md': Buffer.from('hello').toString('base64') } })};\n`);
  return copy;
}

// only GitHub is the fake; the old site is really fetched, over the real network stack, with the page's real CSP
const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  const fake = m.fakeGitHub(repos);
  await fake.ready;
  window.__fake = fake;
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (/^https:\\/\\/(api\\.github\\.com|raw\\.githubusercontent\\.com)\\//.test(String(u)) ? fake.fetch(u, o) : real(u, o));
`;

const until = async (page, expr, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await page.evaluate(`Boolean(${expr})`);
    } catch {
      /* navigating */
    }
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}\n--- page says:\n${await page.evaluate("(document.querySelector('.toast.error') || document.querySelector('.toast.success') || {}).innerText || document.querySelector('#view').innerText.slice(0, 600)").catch(() => '?')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);

test('import wizard: an export file and its pictures become a blog in a repository, from the home page', { skip, timeout: 180000 }, async () => {
  const old = await oldSite();
  const web = await serve(await appSite());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);

    // the home page offers it
    assert.match(await page.evaluate("document.querySelector('#view').innerText"), /Coming from WordPress\?/i);
    await clickText(page, '#view button', 'Import from WordPress');
    await until(page, "document.querySelector('.steps')");
    assert.equal(await page.evaluate('location.hash'), '#import');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.steps li')].map((l) => l.textContent.trim())"), ['1 Sources', '2 Blogs', '3 Pictures', '4 Commit']);
    assert.equal(await page.evaluate("document.querySelector('.actions button').disabled"), true, 'nothing to import yet');

    // step 1: an export file (chosen the way a person would: through the file input)
    const xml = WXR.replaceAll('https://old.example.org', old.origin);
    await page.evaluate(`(() => { const i = document.querySelector('input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(xml)}], 'export.xml', { type: 'text/xml' })); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
    await until(page, "document.querySelector('ul.src li')");
    assert.match(await page.evaluate("document.querySelector('ul.src').innerText"), /Ada & Friends\s*· 4 posts, 2 pages, 4 media files/);
    await clickText(page, '#view button', 'Review step by step');

    // step 2: what was found, and what to call it
    await until(page, "document.querySelector('.steps .active').textContent.includes('Blogs')");
    assert.match(await page.evaluate("document.querySelector('#view').innerText"), /2 published posts, 2 drafts, 2 pages, 4 media files; not imported: 1 product/);
    assert.equal(await page.evaluate("[...document.querySelectorAll('#view input')].some((i) => i.value === 'Ada Example')"), true, 'the author is the one who wrote most posts');
    await clickText(page, '#view button', 'Next: bring the pictures across');

    // step 3: the pictures come from the old site, and the page says what could not be kept
    await until(page, "[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim().startsWith('Next: choose where'))");
    const text = await page.evaluate("document.querySelector('#view').innerText");
    assert.match(text, /2 posts, 2 drafts, 2 pages converted to markdown with 2 comments; 3 pictures and 1 file/);
    assert.match(text, /things? to know about/);
    assert.equal(old.seen.filter((s) => /\.(jpg|JPG)$/.test(s.url)).length, 3);
    for (const s of old.seen) assert.ok(!s.cookie && !s.auth, `nothing identifying went to the old site: ${JSON.stringify(s)}`);
    assert.ok(old.seen.every((s) => !s.referer), 'no referrer');
    await clickText(page, '#view button', 'Next: choose where');

    // step 4: sign in, name the repository, see the pre-flight, commit
    await until(page, "document.querySelector('#view input[aria-label=Repository]')");
    await page.evaluate("(() => { const i = document.querySelector('#view input[aria-label=Repository]'); i.value = 'me/site'; i.dispatchEvent(new Event('input')); })()");
    await clickText(page, '#view button', 'Sign in to commit');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim() === 'Review and commit…')");
    await clickText(page, '#view button', 'Review and commit…');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    const review = await page.evaluate("document.querySelector('dialog[open]').innerText");
    assert.match(review, /4 files, .* to github\.com\/me\/site \(main\)/, 'the pictures');
    assert.match(review, /1 blog: 4 posts\/drafts, 2 pages, 4 images and files/);
    assert.match(review, /add\s+me\/site\/images\/wp\/2024\/05\/cat\.jpg/);
    assert.match(review, /add\s+me\/site\/posts\/hello-welcome\.md/);
    assert.equal((await page.evaluate("window.__fake.files('me/site')"))['blog.json'], undefined, 'nothing is sent before the button');
    await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, '!document.querySelector("dialog[open]")', 40000);
    await until(page, "document.querySelector('.toast.success')");

    const files = await page.evaluate("window.__fake.files('me/site')");
    assert.equal(files['README.md'], 'hello');
    for (const f of ['blog.json', 'index.html', 'feed.xml', 'posts/hello-welcome.md', 'pages/about-us.md', 'hello-welcome/index.html', 'about-us/index.html', 'images/wp/2024/05/cat.jpg', 'images/wp/2024/06/dog.jpg', 'images/wp/2022/01/paper.pdf', 'search/index.html']) assert.ok(f in files, f);
    assert.match(files['hello-welcome/index.html'], /cdn\.jsdelivr\.net\/gh\/me\/site@[0-9a-f]{40}\/images\/wp\/2024\/05\/cat\.jpg/, 'a picture is pinned to the commit that holds it');
    assert.match(files['hello-welcome/index.html'], /<a href="\.\.\/second-post\/">the second post<\/a>/, 'links between imported posts work');
    assert.ok(!/not-ready\/index\.html|secret\/index\.html/.test(Object.keys(files).join('\n')), 'drafts have no page');
    assert.match(await page.evaluate("document.querySelector('#view').innerText"), /Open in the editor/);
  } finally {
    chrome.close();
    web.close();
    old.server.close();
  }
});

test('import wizard: a site that does not allow cross-origin reads is found out after a handful of pictures, and the person is told what to do', { skip, timeout: 120000 }, async () => {
  const old = await oldSite({ cors: false });
  const web = await serve(await appSite());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html#import`);
    await until(page, "document.querySelector('.steps')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    const media = Array.from({ length: 80 }, (_, i) => `<item><title>p${i}</title><wp:post_id>${200 + i}</wp:post_id><wp:post_date>2024-05-02 00:00:00</wp:post_date><wp:status>inherit</wp:status><wp:post_type>attachment</wp:post_type><wp:attachment_url>${old.origin}/wp-content/uploads/2024/05/p${i}.jpg</wp:attachment_url></item>`).join('\n');
    const xml = WXR.replaceAll('https://old.example.org', old.origin).replace('</channel>', `${media}</channel>`);
    await page.evaluate(`(() => { const i = document.querySelector('input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(xml)}], 'export.xml', { type: 'text/xml' })); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
    await until(page, "document.querySelector('ul.src li')");
    await clickText(page, '#view button', 'Review step by step');
    await until(page, "document.querySelector('.steps .active').textContent.includes('Blogs')");
    await clickText(page, '#view button', 'Next: bring the pictures across');
    await until(page, "document.querySelector('#view').innerText.toLowerCase().includes('does not let this page read its pictures')");
    const text = await page.evaluate("document.querySelector('#view').innerText");
    assert.match(text, /The first 30 of 8\d pictures were all refused/);
    assert.match(text, /node cli\/blog\.js import wp/);
    assert.ok(old.seen.filter((r) => r.url.includes('/uploads/')).length < 45, `only a handful were asked for: ${old.seen.length}`);

    // keep them linked and carry on: the text is imported, every picture left where it is
    await clickText(page, '#view button', 'Keep the pictures linked and continue');
    await until(page, "[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim().startsWith('Next: choose where'))");
    assert.match(await page.evaluate("document.querySelector('#view').innerText"), /2 posts, 2 drafts, 2 pages converted to markdown/);
  } finally {
    chrome.close();
    web.close();
    old.server.close();
  }
});
