// End to end, in real Chrome, against an in-memory GitHub: tables and raw HTML blocks in the editor. They are inserted from the
// toolbar, edited in a dialog, drawn without ever becoming markup in the editor (which holds the token), refused when they
// could run anything, and saved as markdown the generator reads back.
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
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-blocks-'));
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
  window.__alerts = [];
  window.addEventListener('unhandledrejection', (e) => window.__alerts.push('rejection: ' + (e.reason && e.reason.stack || e.reason)));
  window.addEventListener('error', (e) => window.__alerts.push('error: ' + e.message));
  window.alert = (m) => window.__alerts.push(String(m));
`;
const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(text)}); el.click(); })()`);
const fill = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

test('tables and HTML blocks: inserted, edited, drawn as data, refused when unsafe, saved as readable markdown', { skip, timeout: 180000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    assert.equal(await page.evaluate("document.querySelector('.ql-mdtable').title + ' / ' + document.querySelector('.ql-htmlblock').title"), 'Insert a table / Insert an HTML block');

    // a table: the dialog starts with a 2 x 2 grid
    await page.evaluate("document.querySelector('.ql-editor').focus(); document.execCommand('insertText', false, 'Before.'); document.querySelector('button.ql-mdtable').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelectorAll('dialog.blk-dialog input[data-r]').length"), 6);
    await fill(page, 'dialog input[data-r="-1"][data-c="0"]', 'Name');
    await fill(page, 'dialog input[data-r="-1"][data-c="1"]', 'Price');
    await fill(page, 'dialog input[data-r="0"][data-c="0"]', '**Apple** | pie');
    await fill(page, 'dialog input[data-r="0"][data-c="1"]', '3');
    await page.evaluate("(() => { const s = document.querySelector('dialog select[data-c=\"1\"]'); s.value = 'right'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await clickText(page, 'dialog button', '+ Row');
    await fill(page, 'dialog input[data-r="2"][data-c="0"]', '<script>alert(1)</script>');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    // drawn as a table made of text, not markup
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-mdtable table th').length"), 2);
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-mdtable tbody td strong').textContent"), 'Apple');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor script').length"), 0, 'a cell is text');
    assert.match(await page.evaluate("document.querySelector('.ql-editor .ql-mdtable').innerText"), /<script>alert\(1\)<\/script>/);

    // an HTML block that could run anything cannot be applied, and says why
    await page.evaluate("document.querySelector('.ql-editor').focus(); document.querySelector('button.ql-htmlblock').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open] textarea')");
    for (const [src, why] of [['<img src=x onerror=alert(1)>', /onerror/], ['<script>alert(1)</script>', /script/], ['<a href="javascript:alert(1)">x</a>', /scheme/], ['<div><p>x</p>', /never closed/]]) {
      await fill(page, 'dialog textarea', src);
      assert.equal(await page.evaluate("[...document.querySelectorAll('dialog.blk-dialog button')].find((b) => b.textContent === 'Apply').disabled"), true, src);
      assert.match(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), why, src);
    }
    await fill(page, 'dialog textarea', '<div class="note">\n\n  <p>Hello <b>there</b></p>\n\n</div>\n');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), '');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock pre').textContent"), '<div class="note">\n  <p>Hello <b>there</b></p>\n</div>', 'blank lines removed, shown as source');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-htmlblock b, .ql-editor .ql-htmlblock p').length"), 0, 'an HTML block is shown as its source, never as markup');

    // edit the table again from its button
    await page.evaluate("document.querySelector('.ql-editor .ql-mdtable .blk-edit').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog input[data-r=\"0\"][data-c=\"0\"]').value"), '**Apple** | pie');
    await fill(page, 'dialog input[data-r="2"][data-c="0"]', 'plain');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-mdtable').length"), 1, 'edited in place, not duplicated');

    // save: readable markdown, no Delta
    await fill(page, '#view input[placeholder=Title]', 'With blocks');
    await fill(page, '#view input[placeholder^="set once"]', 'with-blocks');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "!document.querySelector('dialog[open]')", 30000);
    await until(page, "document.querySelector('.toast.success')");
    const saved = (await page.evaluate("window.__fake.files('example/blog')"))['posts/with-blocks.md'];
    // (the second block went in where the cursor was, which is before the first)
    assert.match(saved, /\n\nBefore\.\n\n<div class="note">\n  <p>Hello <b>there<\/b><\/p>\n<\/div>\n\n\| Name \| Price \|\n\| --- \| ---: \|\n\| \*\*Apple\*\* \\\| pie \| 3 \|\n\|  \|  \|\n\| plain \|  \|\n$/);
    assert.doesNotMatch(saved, /mdtable|htmlblock|"ops"/);
    assert.deepEqual(await page.evaluate('window.__alerts'), []);

    // and it reads back: reopening the post draws the same blocks
    await page.evaluate("location.hash = '#repo=example/blog&edit=with-blocks'; 0");
    await until(page, "document.querySelector('.ql-editor .ql-mdtable') && document.querySelector('.ql-editor .ql-htmlblock')");
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-mdtable tbody tr').length"), 3);
  } finally {
    chrome.close();
    web.close();
  }
});
