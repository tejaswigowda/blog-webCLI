// End to end, in real Chrome, against an in-memory GitHub made slow on purpose: slow work shows an
// activity indicator (and marks the pressed button) before the pre-flight appears; results arrive as
// toasts (success, info, error); and a toast raised while the modal dialog is open can still be seen
// and dismissed, because a modal makes everything outside it inert.
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
const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default' });

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-notices-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': Buffer.from(BLOG).toString('base64') } })};\n`);
  return copy;
}

// Every call to GitHub takes 400 ms.
const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  const fake = m.fakeGitHub(repos);
  await fake.ready;
  window.__fake = fake;
  const real = window.fetch.bind(window);
  window.fetch = async (u, o) => {
    if (new URL(u, location.href).origin === location.origin) return real(u, o);
    await new Promise((r) => setTimeout(r, 400));
    return fake.fetch(u, o);
  };
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const setValue = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); })()`);
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0; })()`;

test('notices: an indicator while it works, toasts for the result, readable above the dialog', { skip, timeout: 120000 }, async () => {
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
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");

    // a refusal is an error toast: titled with the code, and it stays until dismissed
    await setValue(page, '#view input[placeholder=Title]', 'Notices');
    await setValue(page, '#view input[placeholder^="set once"]', 'Not A Slug');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('.toast.error')");
    assert.match(await page.evaluate("document.querySelector('.toast.error .toast-title').innerText"), /^Refused: bad-frontmatter$/);
    assert.equal(await page.evaluate("document.querySelector('.toast.error').getAttribute('role')"), 'alert');
    await page.evaluate("document.querySelector('.toast.error .toast-close').click(); 0");
    await until(page, "!document.querySelector('.toast.error')");

    // slow work: the indicator is up before the pre-flight, the button is marked, then both go
    await setValue(page, '#view input[placeholder^="set once"]', 'notices');
    await clickText(page, '#view button', 'Save draft');
    await until(page, visible('.activity'));
    assert.match(await page.evaluate("document.querySelector('.activity').innerText"), /Preparing/);
    assert.equal(await page.evaluate("[...document.querySelectorAll('#view button')].some((b) => b.classList.contains('busy') && b.getAttribute('aria-busy') === 'true')"), true, 'the pressed button shows it is working');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    assert.equal(await page.evaluate("!!document.querySelector('.activity') && document.querySelector('.activity').hidden"), true, 'the indicator is gone once the pre-flight is up');

    // a modal makes the page inert, so a toast raised now lives inside the dialog and is clickable
    await page.evaluate(`(async () => { const ui = await import('/app/ui.js'); window.__t = ui.toast({ kind: 'info', title: 'Over the dialog', timeout: 0 }); })()`);
    await until(page, "document.querySelector('dialog[open] .toast.info')");
    const top = await page.evaluate(`(() => { const b = document.querySelector('.toast.info .toast-close').getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && e.classList.contains('toast-close'); })()`);
    assert.equal(top, true, 'the toast is on top, not behind the dialog');
    await page.evaluate("document.querySelector('.toast.info .toast-close').click(); 0");
    await until(page, "!document.querySelector('.toast.info')");

    // committing: a spinner, then a success toast with the commit, and the toast outlives the dialog
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, visible('.activity'));
    assert.match(await page.evaluate("document.querySelector('.activity').innerText"), /Committing/);
    await until(page, "document.querySelector('.toast.success')");
    assert.match(await page.evaluate("document.querySelector('.toast.success .toast-title').innerText"), /^Draft saved$/);
    assert.equal(await page.evaluate("document.querySelector('.toast.success').closest('dialog')"), null, 'with the dialog closed it is back in the page');
    assert.ok(await page.evaluate("document.querySelector('.toast.success a').href.includes('/commit/') || document.querySelector('.toast.success a').textContent.includes('example/blog@')"), 'it names the commit');
    assert.equal(await page.evaluate("document.querySelector('.activity').hidden"), true);
    assert.ok(Object.keys(await page.evaluate("window.__fake.files('example/blog')")).includes('posts/notices.md'));

    // saving what is already saved says so, as a toast, and sends nothing
    await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0");
    await until(page, "[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim() === 'Save draft' && !b.disabled)");
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('.toast.info')");
    assert.match(await page.evaluate("document.querySelector('.toast.info').innerText"), /Nothing to publish/);
    assert.equal(await page.evaluate("!!document.querySelector('dialog[open]')"), false);
  } finally {
    chrome.close();
    web.close();
  }
});
