// End to end, in real Chrome, against an in-memory GitHub: the Cover field takes an uploaded image or
// "auto". An uploaded cover is staged and committed to the images folder at publish, with the post
// naming it by a logical asset reference; "auto" is stored as the word, and the generated page gets
// a share preview from the post itself.
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
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-cover-'));
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
  // a file chooser that answers immediately with a tiny PNG
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], 'Cat Pic.PNG', { type: 'image/png' }));
    this.files = dt.files;
    this.dispatchEvent(new Event('change'));
  };
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}\n--- page says:\n${await page.evaluate("(document.querySelector('.toast.error') || document.querySelector('.toast.success') || {}).innerText || '(nothing)'")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const coverValue = (page) => page.evaluate("document.querySelector('#view input[placeholder^=\"asset:images/cover.png\"]').value");
const setValue = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); })()`);

async function open(page) {
  await until(page, "document.querySelector('#top button')");
  await page.evaluate(`(async () => { ${INSTALL} })()`);
  await clickText(page, '#top button', 'Sign in');
  await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
  await clickText(page, 'dialog button', 'Sign in');
  await until(page, "document.querySelector('#top').innerText.includes('Signed in as tester')");
  await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
  await until(page, "document.querySelector('.ql-editor')");
}

test('cover: upload an image for it, or choose auto; both are saved as the post says', { skip, timeout: 120000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await open(page);

    // the field explains itself
    const text = await page.evaluate("document.querySelector('#view').innerText");
    assert.match(text, /Upload an image, or auto: the post's first image, else the poster of its first video, else the blog's cover/);

    // Date, Tags and Status sit below the content, directly above the Save/Publish button
    const order = await page.evaluate(`(() => {
      const kids = [...document.querySelector('#view > div').children];
      const at = (pred) => kids.findIndex(pred);
      const editor = at((e) => e.querySelector && (e.id === 'editor' || e.querySelector('.ql-editor')));
      const row = at((e) => e.classList.contains('row') && /Date/.test(e.innerText) && /Status/.test(e.innerText));
      const buttons = at((e) => e.classList.contains('actions') && /Save draft|Publish/.test(e.innerText));
      return { editor, row, buttons, rows: kids.length };
    })()`);
    assert.ok(order.editor >= 0 && order.row > order.editor && order.buttons === order.row + 1, JSON.stringify(order));

    // Auto writes the word
    await clickText(page, '#view button', 'Auto');
    assert.equal(await coverValue(page), 'auto');

    // Upload stages the image under a logical reference: the hash, the lower-cased name
    await clickText(page, '#view button', 'Upload');
    await until(page, "document.querySelector('#view input[placeholder^=\"asset:images/cover.png\"]').value.startsWith('asset:images/')");
    const ref = await coverValue(page);
    assert.match(ref, /^asset:images\/[0-9a-f]{10}-cat-pic\.png$/);
    assert.equal(await page.evaluate("document.querySelector('.toast.error')"), null);

    // saving commits the image to the images folder and the post to the blog, naming it logically
    await setValue(page, '#view input[placeholder=Title]', 'Covered');
    await setValue(page, '#view input[placeholder^="set once"]', 'covered');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    const review = await page.evaluate("document.querySelector('dialog[open]').innerText");
    assert.match(review, new RegExp(`add\\s+example/blog/${ref.slice('asset:'.length).replace(/[./]/g, '\\$&')}`), 'the image is in the files to send');
    assert.ok(!/\bnull\b/.test(review), 'no stray "null" in the pre-flight');
    assert.match(review, /posts\/covered\.md/);
    await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0"); // so the next toast is this commit's
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "!document.querySelector('dialog[open]')", 30000);
    await until(page, "document.querySelector('.toast.success')");

    const saved = await page.evaluate("window.__fake.files('example/blog')");
    assert.ok(saved[ref.slice('asset:'.length)], 'the image is in the repository');
    assert.match(saved['posts/covered.md'], new RegExp(`\\ncover: ${ref.replace(/[./]/g, '\\$&')}\\n`));
    assert.ok(!/jsdelivr/.test(saved['posts/covered.md']), 'no provider in the source');

    // and now auto, on a published post: the share preview comes from the post itself
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor') && !document.querySelector('#view input[placeholder=Title]').value");
    await clickText(page, '#view button', 'Upload'); // an image in the body, then the cover is the word auto
    await setValue(page, '#view input[placeholder^="asset:images/cover.png"]', 'auto');
    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('.ql-editor img')");
    await setValue(page, '#view input[placeholder=Title]', 'Automatic');
    await setValue(page, '#view input[placeholder^="set once"]', 'automatic');
    await page.evaluate("(() => { const s = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === 'published')); s.value = 'published'; s.dispatchEvent(new Event('change')); })()");
    await clickText(page, '#view button', 'Publish');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0"); // so the next toast is this commit's
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "!document.querySelector('dialog[open]')", 30000);
    await until(page, "document.querySelector('.toast.success')");
    const after = await page.evaluate("window.__fake.files('example/blog')");
    assert.match(after['posts/automatic.md'], /\ncover: auto\n/);
    const og = /<meta property="og:image" content="([^"]*)"/.exec(after['automatic/index.html']);
    assert.ok(og && /^https:\/\/cdn\.jsdelivr\.net\/gh\/example\/blog@[0-9a-f]{40}\/images\/[0-9a-f]{10}-cat-pic\.png$/.test(og[1]), `og:image ${og && og[1]}`);
    assert.ok(!after['automatic/index.html'].includes('class="cover"'), 'not drawn on the page');
  } finally {
    chrome.close();
    web.close();
  }
});
