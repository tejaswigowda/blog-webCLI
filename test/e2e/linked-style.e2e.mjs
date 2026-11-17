// End to end, in real Chrome: a blog whose pages link style.css has no <style> in them, and the /blog/ reader still shows it styled
// (it applies the blog's CSS itself), on the front page and on a post.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../lib/blog.js';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const POSTS = [1, 2].map((n) => ({ path: `posts/p${n}.md`, text: `---\nslug: p${n}\ntitle: Post ${n}\ndate: 2026-01-0${n}\nstatus: published\n---\n\nBody ${n}.\n` }));
const BLOG = JSON.stringify({ title: 'Linked', description: 'd', author: 'A', domain: 'https://example.github.io/linked', repo: 'example/linked', theme: 'default', stylesheet: 'linked', customize: { css: 'article h1{color:rgb(1,2,3)} h1{letter-spacing:7px}' } });
const b64 = (t) => Buffer.from(t).toString('base64');
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
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('linked stylesheet: the reader shows a blog whose pages carry no <style>, styled by its CSS', { skip, timeout: 120000 }, async () => {
  const built = buildSite({ blog: BLOG, posts: POSTS, lock: {} });
  assert.deepEqual(built.errors, []);
  assert.ok(!built.files['index.html'].includes('<style>') && built.files['style.css']);
  const files = Object.fromEntries(Object.entries({ ...built.files, 'blog.json': BLOG, ...Object.fromEntries(POSTS.map((p) => [p.path, p.text])) }).map(([p, t]) => [p, b64(t)]));
  const web = await serve(root);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/blog/`);
    await until(page, "document.querySelector('#reader')");
    await page.evaluate(`(async () => {
      const m = await import('/test/fake-github.js');
      const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const files = Object.fromEntries(Object.entries(JSON.parse(atob(${JSON.stringify(b64(JSON.stringify(files)))}))).map(([p, b]) => [p, dec(b)]));
      const fake = m.fakeGitHub({ 'example/linked': files });
      await fake.ready;
      window.fetch = (u, o) => fake.fetch(u, o);
      location.hash = '#repo=example/linked';
    })()`);
    await until(page, "document.querySelector('.posts li h2 a, .posts li a')");
    assert.match(await page.evaluate("document.querySelector('#theme').textContent"), /letter-spacing:7px/, 'the reader has the blog\'s CSS although the page links it');
    await page.evaluate("location.hash = '#repo=example/linked&post=p1'; 0");
    await until(page, "document.querySelector('article h1')");
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('article h1')).color"), 'rgb(1, 2, 3)');
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('article h1')).letterSpacing"), '7px');
  } finally {
    chrome.close();
    web.close();
  }
});

test('reader resolves page images against the site and opens unindexed paths on the published site', { skip, timeout: 120000 }, async () => {
  const home = { path: 'pages/home.md', text: '---\nslug: home\ntitle: Home\nstatus: published\n---\n\n<div>\n<img src="/media/root.jpg" alt="root">\n<img src="photos/relative.jpg" alt="relative">\n<a href="/linked/about/">About</a>\n<a href="/linked/films/clip/">Film</a>\n<a href="/outside/">Outside</a>\n</div>\n' };
  const about = { path: 'pages/about.md', text: '---\nslug: about\ntitle: About\nstatus: published\n---\n\n![Nested](photos/about.jpg)\n' };
  const inputs = [...POSTS, home, about];
  const built = buildSite({ blog: BLOG, posts: inputs, lock: {} });
  assert.deepEqual(built.errors, []);
  const files = Object.fromEntries(Object.entries({ ...built.files, 'blog.json': BLOG, ...Object.fromEntries(inputs.map((p) => [p.path, p.text])) }).map(([p, t]) => [p, b64(t)]));
  const web = await serve(root);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/blog/`);
    await until(page, "document.querySelector('#reader')");
    await page.evaluate(`(async () => {
      window.__cspBlocks = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__cspBlocks.push(e.blockedURI));
      const m = await import('/test/fake-github.js');
      const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const files = Object.fromEntries(Object.entries(JSON.parse(atob(${JSON.stringify(b64(JSON.stringify(files)))}))).map(([p, b]) => [p, dec(b)]));
      const fake = m.fakeGitHub({ 'example/linked': files });
      await fake.ready;
      window.fetch = (u, o) => fake.fetch(u, o);
      location.hash = '#repo=example/linked';
    })()`);
    await until(page, "document.querySelector('#reader img[alt=root]')");
    const result = await page.evaluate(`(() => ({
      images: [...document.querySelectorAll('#reader img')].map((i) => i.getAttribute('src')),
      links: [...document.querySelectorAll('#reader .home a')].map((a) => [a.textContent, a.getAttribute('href')]),
      blocked: window.__cspBlocks
    }))()`);
    assert.deepEqual(result.images, ['https://example.github.io/media/root.jpg', 'https://example.github.io/linked/photos/relative.jpg']);
    assert.deepEqual(result.links, [
      ['About', '#repo=example/linked&post=about'],
      ['Film', 'https://example.github.io/linked/films/clip/'],
      ['Outside', 'https://example.github.io/outside/'],
    ]);
    assert.ok(!result.blocked.some((uri) => uri.includes('/media/root.jpg') && uri.startsWith('http:')), 'no image request is made against the reader origin');
    const footerOffset = await page.evaluate(`(() => {
      const footer = document.querySelector('#reader footer.site');
      const text = footer.querySelector('.foot-text').getBoundingClientRect();
      const bounds = footer.getBoundingClientRect();
      return (text.left + text.width / 2) - (bounds.left + bounds.width / 2);
    })()`);
    assert.ok(Math.abs(footerOffset) < 1, 'footer text is centered');
    await page.evaluate("location.hash = '#repo=example/linked&post=about'; 0");
    await until(page, "document.querySelector('#reader img[alt=Nested]')");
    assert.equal(await page.evaluate("document.querySelector('#reader img[alt=Nested]').getAttribute('src')"), 'https://example.github.io/linked/about/photos/about.jpg');
    const linkOffset = await page.evaluate(`(() => {
      const link = document.querySelector('#tools a').getBoundingClientRect();
      const midpoint = (rect) => rect.left + rect.width / 2;
      return midpoint(link) - midpoint(document.querySelector('#tools').getBoundingClientRect());
    })()`);
    assert.ok(Math.abs(linkOffset) < 1, 'published-page link is centered');
  } finally {
    chrome.close();
    web.close();
  }
});
