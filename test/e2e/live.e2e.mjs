// End to end, in real Chrome: a published blog whose Pages build has not caught up with the repository.
// Two local servers stand in for the two places that matter: the site as it was last deployed (a static
// server that answers a missing path with its own 404.html and a 404 status, as GitHub Pages does) and
// the live copy of the repository (every request logged). The gates here are the ones a unit test cannot
// see: what a human visitor's page actually shows, and what it asks for to get there.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from '../../lib/blog.js';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const post = (slug, title, body, status = 'published') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: ${title}\ndate: 2026-11-06\nstatus: ${status}\n---\n\n${body}\n` });
const many = Array.from({ length: 10 }, (_, i) => post(`page-${i + 1}`, `Page ${i + 1}`, `Body of page ${i + 1}.`));

// the live copy of a repository: files by path, with CORS as raw.githubusercontent.com has, and a log
function contentHost() {
  const files = new Map();
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, raw: url.pathname, path: decodeURIComponent(url.pathname), query: url.search, headers: req.headers });
    const body = files.get(decodeURIComponent(url.pathname).replace(/^\/example\/blog\/HEAD\//, ''));
    res.setHeader('access-control-allow-origin', '*');
    if (body === undefined) {
      res.writeHead(404);
      return res.end('404: Not Found');
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, files, log, port: server.address().port })));
}

async function world() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blog-live-'));
  const pages = await serve(dir);
  const content = await contentHost();
  const origin = `http://127.0.0.1:${pages.address().port}`;
  const blog = { title: 'Live Blog', description: 'd', author: 'A', domain: origin, repo: 'example/blog', theme: 'default', content: { base: `http://127.0.0.1:${content.port}/{owner}/{repo}/{ref}/{path}` } };
  const write = async (files) => {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
  };
  // what is deployed, and what the repository holds now
  const old = [post('edited', 'Edited post', 'The text as it was deployed.'), ...many];
  const now = [post('edited', 'Edited post', 'The text as it was just republished.'), ...many, post('brand-new', 'Brand new post', 'Committed a minute ago, not deployed yet.'), post('secret-draft', 'Secret draft', 'Nobody may see this.', 'draft')];
  const deployed = buildSite({ blog, posts: old, lock: {} });
  assert.deepEqual(deployed.errors, []);
  await write(deployed.files);
  const latest = buildSite({ blog, posts: now, lock: {} });
  assert.deepEqual(latest.errors, []);
  for (const [p, c] of Object.entries({ ...latest.files, 'blog.json': JSON.stringify(blog), 'assets.lock.json': '{}' })) content.files.set(p, c);
  for (const p of now) content.files.set(p.path, p.text);
  const close = () => {
    pages.close();
    content.server.close();
  };
  return { origin, content, close, latest };
}

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await page.evaluate(`Boolean(${expr})`);
    } catch {
      /* the page is navigating */
    }
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 80));
  }
};
const go = async (page, url, settle = true) => {
  await page.evaluate(`location.href = ${JSON.stringify(url)}; 0`).catch(() => {});
  const p = new URL(url).pathname;
  await until(page, `location.pathname === ${JSON.stringify(p)} && document.readyState !== 'loading'`);
  if (settle) await until(page, 'document.documentElement.dataset.webcliLive');
};
const state = (page) => page.evaluate('document.documentElement.dataset.webcliLive');

test('live: an edited post, a brand-new post and a draft, before the Pages build has caught up', { skip, timeout: 120000 }, async () => {
  const w = await world();
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${w.origin}/`);
    // what the build left: the old text, and a real 404 for the post it has not built yet
    assert.match(await (await fetch(`${w.origin}/edited/`)).text(), /as it was deployed/);
    assert.equal((await fetch(`${w.origin}/brand-new/`)).status, 404);

    // ---- L1: the edited post shows the current text within one page load, quietly ----
    await go(page, `${w.origin}/edited/`);
    assert.equal(await state(page), 'rebuilt');
    const text = await page.evaluate('document.body.innerText');
    assert.match(text, /The text as it was just republished\./);
    assert.ok(!/as it was deployed/.test(text));
    assert.ok(!/updating|refresh|reload|new version/i.test(text), 'a silent re-render: no banner');
    assert.equal(await page.evaluate("document.querySelectorAll('script[src*=\"webcli-live\"]').length"), 1, 'the script is still there once, and did not run twice');
    assert.equal(await page.evaluate("document.querySelector('meta[name=\"x-content-sha256\"]').content.length"), 64);
    assert.equal(await page.evaluate('document.title'), 'Edited post · Live Blog');

    // ---- L2: a post whose page does not exist yet renders at its final address ----
    await go(page, `${w.origin}/brand-new/`);
    assert.equal(await state(page), 'rebuilt');
    assert.match(await page.evaluate('document.body.innerText'), /Committed a minute ago, not deployed yet\./);
    assert.equal(await page.evaluate('document.title'), 'Brand new post · Live Blog');
    assert.equal(await page.evaluate('location.pathname'), '/brand-new/', 'the address did not change');

    // ---- L4: the soft-rendered page says noindex; the page that settles will not ----
    assert.equal(await page.evaluate("document.querySelector('meta[name=\"robots\"]').content"), 'noindex');
    assert.ok(!/name="robots"/.test(w.latest.files['brand-new/index.html']));

    // ---- L3: a draft is not-found, here exactly as in the generated site; so is anything unknown ----
    await go(page, `${w.origin}/secret-draft/`);
    assert.equal(await state(page), 'missing');
    const hidden = await page.evaluate('document.body.innerText');
    assert.match(hidden, /Page not found/);
    assert.ok(!/Secret draft|Nobody may see this/.test(hidden));
    assert.ok(!JSON.parse(w.content.files.get('index/posts.json')).posts.some((e) => e.slug === 'secret-draft'), 'and it is in no index');
    await go(page, `${w.origin}/never-written/`);
    assert.equal(await state(page), 'missing');
    assert.match(await page.evaluate('document.body.innerText'), /Page not found/);
    await go(page, `${w.origin}/a/b/c/`);
    assert.equal(await state(page), 'missing');

    // ---- L6: only plain, anonymous GETs of files, from the content base, nothing from the API ----
    const reqs = w.content.log;
    assert.ok(reqs.length > 3);
    for (const r of reqs) {
      assert.equal(r.method, 'GET');
      assert.ok(!('authorization' in r.headers) && !('cookie' in r.headers), `${r.path} carried credentials`);
      assert.match(r.query, /^\?t=\d+$/, `${r.path} is cache-busted`);
      assert.ok(!r.headers.authorization);
      assert.ok(r.path.startsWith('/example/blog/HEAD/'));
    }
    const spellings = new Set(reqs.filter((r) => /index\/posts\.json$/.test(r.path)).map((r) => r.raw));
    assert.ok(reqs.some((r) => /%[0-9A-F]{2}/.test(r.raw)), 'the path is asked for in an encoded spelling too, which is what steps around a CDN cache');
    assert.ok(spellings.size >= 1);
    const hosts = await page.evaluate("[...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).host))]");
    assert.ok(hosts.every((h) => h.startsWith('127.0.0.1')), `only the two local hosts were contacted: ${hosts}`);
  } finally {
    chrome.close();
    w.close();
  }
});

test('live: L7 a ten-page browse makes one check per page, and a second pass makes none', { skip, timeout: 120000 }, async () => {
  const w = await world();
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${w.origin}/`);
    const checks = () => w.content.log.filter((r) => /\/posts\/page-\d+\.md$/.test(r.path)).length;
    const others = () => w.content.log.filter((r) => !/\/posts\/page-\d+\.md$/.test(r.path));
    for (let i = 1; i <= 10; i++) {
      await go(page, `${w.origin}/page-${i}/`);
      assert.equal(await state(page), 'current', `page ${i} is current`);
    }
    assert.equal(checks(), 10, 'one request per page');
    assert.deepEqual(others(), [], 'the rest of the site was not asked for: nothing differed');
    for (let i = 1; i <= 10; i++) {
      await go(page, `${w.origin}/page-${i}/`);
      assert.equal(await state(page), 'skipped', `page ${i} again`);
    }
    assert.equal(checks(), 10, 'revisiting asked for nothing');
  } finally {
    chrome.close();
    w.close();
  }
});

test('live: a blog that is not reachable on its content base leaves every page as the build wrote it', { skip, timeout: 120000 }, async () => {
  const w = await world();
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${w.origin}/`);
    w.content.server.close();
    await go(page, `${w.origin}/edited/`);
    assert.equal(await state(page), 'left');
    assert.match(await page.evaluate('document.body.innerText'), /as it was deployed/);
    await go(page, `${w.origin}/brand-new/`);
    assert.equal(await state(page), 'missing');
    assert.match(await page.evaluate('document.body.innerText'), /Page not found/);
  } finally {
    chrome.close();
    w.close();
  }
});
