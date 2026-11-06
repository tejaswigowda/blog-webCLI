// End to end, in real Chrome, against an in-memory GitHub: a blog whose blog.json names no images
// repository. If it says where it lives ("repo"), images go to an images folder of that repository
// with nothing to configure. If it does not, choosing an image must say what to do about it (not
// dead-end), must not lose the post being written, and must pick up a repository saved in another
// tab without a reload.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';

async function site(blogJson) {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-img-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': Buffer.from(blogJson).toString('base64') }, 'example/images': { 'README.md': Buffer.from('i').toString('base64') } })};\n`);
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
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'Cat Pic.png', { type: 'image/png' }));
    this.files = dt.files;
    this.dispatchEvent(new Event('change'));
  };
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

async function signedIn(blogJson) {
  const copy = await site(blogJson);
  const web = await serve(copy);
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  const page = await openPage(chrome, `${base}/index.html`);
  await until(page, "document.querySelector('#top button')");
  await page.evaluate(`(async () => { ${INSTALL} })()`);
  await page.evaluate("[...document.querySelectorAll('#top button')].find((b) => b.textContent.trim().startsWith('Sign in')).click(); 0");
  await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
  await page.evaluate("[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim().startsWith('Sign in')).click(); 0");
  await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
  return { page, close: () => { chrome.close(); web.close(); } };
}
const blogJson = (extra = {}) => JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', theme: 'default', ...extra });

test('images: a blog that says where it lives needs nothing configured; the Settings fields show the default', { skip, timeout: 120000 }, async () => {
  const { page, close } = await signedIn(blogJson({ repo: 'example/blog' }));
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('.ql-editor img')");
    assert.equal(await page.evaluate("document.querySelector('.toast.error')"), null, 'no complaint: images default to this repository');

    await page.evaluate("location.hash = '#repo=example/blog&settings'; 0");
    await until(page, "document.querySelector('#view input[placeholder^=\"blank:\"]')");
    const fields = await page.evaluate("[...document.querySelectorAll('#view input[placeholder^=\"blank:\"]')].map((i) => [i.value, i.placeholder])");
    assert.deepEqual(fields, [['', 'blank: example/blog/images'], ['', 'blank: example/blog/videos']], 'blank, with the default shown as the placeholder');
  } finally {
    close();
  }
});

test('images: a blog that does not say where it lives explains what to do, keeps the post, and notices the fix', { skip, timeout: 120000 }, async () => {
  const { page, close } = await signedIn(blogJson());
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('.ql-editor').focus(); document.execCommand('insertText', false, 'words I have written'); 0");

    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('.toast.error')");
    const msg = await page.evaluate("document.querySelector('.toast.error .toast-body').innerText");
    assert.match(msg, /no images repository yet/);
    assert.match(msg, /me\/images/);
    assert.match(msg, /example\/blog\/images/, 'it suggests keeping them in this repository, as a folder');
    const settings = await page.evaluate("(() => { const a = document.querySelector('.toast.error button[data-href]'); return [a.dataset.href, a.tagName]; })()");
    assert.deepEqual(settings, ['#repo=example/blog&settings', 'BUTTON']);
    assert.equal(await page.evaluate("document.querySelector('.ql-editor img')"), null, 'nothing was inserted');
    assert.match(await page.evaluate("document.querySelector('.ql-editor').innerText"), /words I have written/, 'the post is still there');

    // "saved in Settings, in another tab": blog.json on GitHub now names an images repository
    await page.evaluate(`(() => {
      const S = window.__fake.state['example/blog'];
      const tree = S.trees[S.commits[S.branches.main].tree];
      const b = JSON.parse(new TextDecoder().decode(tree.get('blog.json').bytes));
      b.assets = { base: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}', repos: { images: 'example/images' } };
      tree.set('blog.json', { bytes: new TextEncoder().encode(JSON.stringify(b)), sha: 'f'.repeat(40) });
    })()`);
    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('.ql-editor img')");
    assert.match(await page.evaluate("document.querySelector('#view').innerText"), /words I have written/);
    await until(page, "!document.querySelector('.toast.error')"); // it fades out
  } finally {
    close();
  }
});
