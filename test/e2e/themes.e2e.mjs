// Choose a classic theme by address in real Chrome, then read the result in the token-free
// /blog/ reader without contacting the theme repository (gate X1).
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';

async function readTree(dir, base = dir, out = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await readTree(p, base, out);
    else out[path.relative(base, p).split(path.sep).join('/')] = (await readFile(p)).toString('base64');
  }
  return out;
}

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-ui-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  for (const f of ['index.html']) await cp(path.join(root, f), path.join(copy, f));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  const ex = path.join(root, 'examples');
  const data = {
    'example/blog': await readTree(path.join(ex, 'blog')),
    'me/classic': await readTree(path.join(ex, 'theme-classic')),
    'example/images': { 'README.md': Buffer.from('i').toString('base64') },
  };
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify(data)};\n`);
  return copy;
}

// installed in a page: an in-memory GitHub answers every request to GitHub; the app's own files are real
const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  const tagged = Object.keys(repos).filter((r) => r.startsWith('me/'));
  const fake = m.fakeGitHub(repos, { tags: Object.fromEntries(tagged.map((r) => [r, ['v1.0.0']])), aliases: Object.fromEntries(tagged.map((r) => [r, { 'v1.0.0': 'main' }])) });
  await fake.ready;
  window.__fake = fake;
  window.__urls = [];
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => { window.__urls.push(String(u)); return new URL(u, location.href).origin === location.origin ? real(u, o) : fake.fetch(u, o); };
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const click = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);

test('themes: chosen by address and read without contacting the theme repository', { skip, timeout: 180000 }, async () => {
  const copy = await site();
  const web = await serve(copy);
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    // ---------- the editor ----------
    const page = await openPage(chrome, `${base}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await click(page, '#top button', 'Sign in');
    await page.evaluate(`document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0`);
    await click(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");

    // the theme, by address (it is in no list)
    await page.evaluate("location.hash = '#repo=example/blog&themes'; 0");
    await until(page, "document.querySelector('#view h1')?.textContent === 'Theme'");
    const view = await page.evaluate("document.querySelector('#view').innerText");
    assert.match(view, /Starters/);
    assert.match(view, /bundled with this app/, 'the registry is unreachable here, so the bundled snapshot is shown, and the screen says so');
    for (const name of ['Essay', 'Terminal', 'Wide', 'Cards']) assert.ok(view.includes(name), `${name} is listed`);
    assert.ok(!view.includes('me/classic'), 'the theme used below is in no list');
    await page.evaluate("(() => { document.querySelector('#view input[placeholder^=\"owner/theme-repo\"]').value = 'me/classic@v1.0.0'; })()");
    await click(page, '#view button', 'Use this theme');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    const dialog = await page.evaluate("document.querySelector('dialog[open]').innerText");
    assert.match(dialog, /Licences this blog will depend on/);
    assert.match(dialog, /theme\s+Classic Sample 1\.2\.0\s+GPL-2\.0-or-later\s+me\/classic@v1\.0\.0/);
    await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0"); // so the next toast is this commit's
    await click(page, 'dialog[open] button', 'Commit and push');
    await until(page, "document.querySelector('.toast.success')");
    const state = JSON.parse(await page.evaluate("JSON.stringify(window.__fake.files('example/blog'))"));
    assert.equal(JSON.parse(state['blog.json']).theme.contract, 'wordpress-classic');
    assert.ok(state['index.html'].includes('<body class="home blog">') && state['theme.css'].includes('.entry-title'));

    // CDN links are settings, not executable editor content or part of a theme file.
    await page.evaluate("location.hash = '#repo=example/blog&settings'; 0");
    await until(page, "document.querySelector('textarea[name=cdnScripts]')");
    const integrity = `sha256-${Buffer.alloc(32).toString('base64')}`;
    await page.evaluate(`(() => {
      const input = document.querySelector('textarea[name=cdnScripts]');
      input.value = ${JSON.stringify(`https://unpkg.com/example@1/index.js | ${integrity}`)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(page, '#view button', 'Save settings');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await click(page, 'dialog[open] button', 'Commit and push');
    await until(page, "JSON.parse(window.__fake.files('example/blog')['blog.json']).scripts?.length === 1");
    const publishedState = JSON.parse(await page.evaluate("JSON.stringify(window.__fake.files('example/blog'))"));
    assert.ok(publishedState['index.html'].includes(`integrity="${integrity}"`));
    assert.equal(await page.evaluate("document.querySelectorAll('script[src*=\"unpkg.com\"]').length"), 0);

    // the licences, in one place
    await page.evaluate("location.hash = '#repo=example/blog&licences'; 0");
    await until(page, "document.querySelector('#view h1')?.textContent === 'What is in this site'");
    const table = await page.evaluate("document.querySelector('#view table').innerText");
    assert.match(table, /theme\s+Classic Sample\s+1\.2\.0\s+GPL-2\.0-or-later/);
    page.close();

    // ---------- the reader: a different page that has only the blog repository ----------
    const blogOnly = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(publishedState).map(([p, t]) => [p, Buffer.from(t).toString('base64')])))).toString('base64');
    const reader = await openPage(chrome, `${base}/blog/`);
    await until(reader, "document.querySelector('#reader')");
    await reader.evaluate(`(async () => {
      const m = await import('/test/fake-github.js');
      const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const files = Object.fromEntries(Object.entries(JSON.parse(atob(${JSON.stringify(blogOnly)}))).map(([p, b]) => [p, dec(b)]));
      const fake = m.fakeGitHub({ 'example/blog': files });
      await fake.ready;
      window.__urls = [];
      window.fetch = (u, o) => { window.__urls.push(String(u)); return fake.fetch(u, o); };
      location.hash = '#repo=example/blog';
    })()`);
    await until(reader, "document.body.className === 'home blog'");
    await until(reader, "document.querySelectorAll('article.hentry').length === 2");
    assert.ok(await reader.evaluate("document.querySelector('#theme').textContent.includes('.entry-title')"), "the blog's own theme.css is applied");
    assert.ok(await reader.evaluate("!!document.querySelector('header#masthead.site-header .site-title')"));
    assert.equal(await reader.evaluate("document.querySelectorAll('script').length"), 1, 'the only script is the reader');
    assert.match(await reader.evaluate("document.querySelector('#ledger').innerText"), /uploaded 0 B/);
    // a post
    await reader.evaluate("location.hash = '#repo=example/blog&post=static-hls-in-git'; 0");
    await until(reader, "document.querySelector('article .entry-content')");
    assert.ok(await reader.evaluate("document.body.className.includes('single-post')"));
    // X1: the reader uses the committed CSS, never the theme repository.
    const urls = await reader.evaluate('window.__urls');
    assert.ok(urls.length > 3);
    for (const u of urls) assert.ok(!/me\/(classic|theme)|\/(classic)\//.test(u), `the reader contacted ${u}`);
    for (const u of urls) assert.match(u, /^https:\/\/(raw\.githubusercontent\.com|api\.github\.com)\//, `the reader may only read from GitHub: ${u}`);
    reader.close();
  } finally {
    chrome.close();
    web.close();
  }
});
