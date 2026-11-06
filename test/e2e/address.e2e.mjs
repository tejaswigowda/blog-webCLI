// End to end, in real Chrome, against an in-memory GitHub: "Address the blog is served at" is shown,
// never typed. Read-only in Settings and in the create form; GitHub's own address when Pages says
// one; a clear warning, with the step to fix it, when Pages is off.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const b64 = (t) => Buffer.from(t).toString('base64');
const BLOG = (domain) => JSON.stringify({ title: 'T', description: 'd', author: 'A', domain, repo: 'example/blog', theme: 'default' });

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-addr-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  const data = { 'example/blog': { 'blog.json': b64(BLOG('https://example.github.io/guess')) }, 'example/fresh': { 'README.md': b64('x') }, 'example/live': { 'blog.json': b64(BLOG('https://example.github.io/guess')) }, 'example/locked': { 'blog.json': b64(BLOG('https://example.github.io/locked')) } };
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify(data)};\n`);
  return copy;
}

const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  const fake = m.fakeGitHub(repos, { pages: { 'example/live': 'https://notes.example.com/', 'example/locked': 'forbidden' } });
  await fake.ready;
  window.__fake = fake;
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (new URL(u, location.href).origin === location.origin ? real(u, o) : fake.fetch(u, o));
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const addressField = (page) => page.evaluate(`(() => {
  const label = [...document.querySelectorAll('#view label')].find((l) => l.textContent.startsWith('Address the blog is served at'));
  const box = label.parentElement;
  const input = box.querySelector('input');
  return { value: input.value, readOnly: input.readOnly, editedByTyping: null, note: box.innerText.replace(label.textContent, '').trim(), hasWarning: !!box.querySelector('.err'), links: [...box.querySelectorAll('a')].map((a) => a.getAttribute('href')) };
})()`);
const open = (page, hash, ready) => page.evaluate(`location.hash = ${JSON.stringify(hash)}; 0`).then(() => until(page, ready));

test('address: read-only, GitHub\'s when it says one, a clear warning when Pages is off', { skip, timeout: 120000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "document.querySelector('#top').innerText.includes('Signed in as tester')");

    // ---- Pages off: shown, not editable, and said plainly ----
    await open(page, '#repo=example/blog&settings', "document.querySelector('#view form')");
    const off = await addressField(page);
    assert.equal(off.value, 'https://example.github.io/guess');
    assert.equal(off.readOnly, true, 'not editable');
    assert.equal(off.hasWarning, true);
    assert.match(off.note, /GitHub Pages is not enabled for this repository/);
    assert.match(off.note, /Nothing is served at this address yet \(example\/blog\)/);
    assert.deepEqual(off.links, ['https://github.com/example/blog/settings/pages', 'blog/#repo=example/blog'], 'where to turn it on, and where the blog can be read meanwhile');
    // typing does nothing: the field refuses edits
    await page.evaluate("(() => { const i = [...document.querySelectorAll('#view label')].find((l) => l.textContent.startsWith('Address')).parentElement.querySelector('input'); i.focus(); i.value = 'https://typed.example/'; })()");
    assert.equal(await page.evaluate("document.querySelector('#view input[readonly]').readOnly"), true);

    // ---- Pages on and readable: GitHub's own address, even a custom domain ----
    await open(page, '#repo=example/live&settings', "document.querySelector('#view form') && [...document.querySelectorAll('#view label')].some((l) => l.textContent.startsWith('Address'))");
    const on = await addressField(page);
    assert.equal(on.value, 'https://notes.example.com');
    assert.equal(on.readOnly, true);
    assert.equal(on.hasWarning, false);
    assert.match(on.note, /From this repository's GitHub Pages settings, so it is not edited here/);
    assert.deepEqual(on.links, ['https://github.com/example/live/settings/pages']);

    // ---- Pages on, but the token cannot read it: what is saved, and how to get it read ----
    await open(page, '#repo=example/locked&settings', "document.querySelector('#view form') && [...document.querySelectorAll('#view label')].some((l) => l.textContent.startsWith('Address'))");
    const locked = await addressField(page);
    assert.equal(locked.value, 'https://example.github.io/locked');
    assert.match(locked.note, /GitHub Pages is on, but this token cannot read its address/);
    assert.match(locked.note, /Pages: Read-only/);

    // ---- View blog: the GitHub Pages site when GitHub is serving one, else the reader ----
    const viewBlog = (repo) => open(page, `#repo=${repo}`, "[...document.querySelectorAll('#view a.btn')].some((a) => a.textContent === 'View blog')").then(async () => {
      await new Promise((r) => setTimeout(r, 600)); // the address is asked for after the page is drawn
      return page.evaluate("(() => { const a = [...document.querySelectorAll('#view a.btn')].find((x) => x.textContent === 'View blog'); return { href: a.getAttribute('href'), title: a.title, target: a.target }; })()");
    });
    const live = await viewBlog('example/live');
    assert.deepEqual([live.href, live.target, live.title], ['https://notes.example.com/', '_blank', 'Opens the GitHub Pages site'], 'Pages is on and built: its link, a custom domain included');
    const off2 = await viewBlog('example/blog');
    assert.equal(off2.href, 'blog/#repo=example/blog', 'Pages off: the reader');
    assert.match(off2.title, /reader/);
    const locked2 = await viewBlog('example/locked');
    assert.equal(locked2.href, 'blog/#repo=example/locked', 'on but unreadable: not guessed, the reader');

    // ---- the create form: the same, and nothing to type ----
    await open(page, '#repo=example/fresh/journal', "document.querySelector('#view') && [...document.querySelectorAll('#view label')].some((l) => l.textContent.startsWith('Address'))");
    const created = await addressField(page);
    assert.equal(created.value, 'https://example.github.io/fresh/journal');
    assert.equal(created.readOnly, true);
    assert.match(created.note, /GitHub Pages is not enabled/);
  } finally {
    chrome.close();
    web.close();
  }
});
