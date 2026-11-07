// End to end, in real Chrome, against an in-memory GitHub: deleting a post from its page. The pre-flight says what is removed, Cancel
// sends nothing, and confirming commits the removal: the source and its generated page are gone, the other post is not.
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
const post = (slug) => `---\nslug: ${slug}\ntitle: Title of ${slug}\ndate: 2026-01-01\nstatus: published\n---\n\nWords of ${slug}.\n`;

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-delete-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': Object.fromEntries(Object.entries({ 'blog.json': BLOG, 'posts/keep.md': post('keep'), 'posts/gone.md': post('gone') }).map(([p, t]) => [p, Buffer.from(t).toString('base64')])) })};\n`);
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

test('delete: from the post page, with a pre-flight, Cancel sending nothing, and the removal committed', { skip, timeout: 180000 }, async () => {
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
    // the activity line says what is going on and nothing else: no stray "null" where a Stop button would be
    await page.evaluate("(async () => { const m = await import('/app/ui.js'); window.__end = m.busy('Committing…'); })()");
    await until(page, "document.querySelector('.activity') && !document.querySelector('.activity').hidden");
    assert.equal(await page.evaluate("document.querySelector('.activity').textContent.trim()"), 'Committing…');
    await page.evaluate('window.__end(); 0');
    await page.evaluate("location.hash = '#repo=example/blog&post=gone'; 0");
    await until(page, "document.querySelector('article.post')");

    await clickText(page, '#view button', 'Delete');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    assert.equal(await page.evaluate("document.querySelector('dialog[open] h2').textContent"), 'Delete this post?');
    const listed = await page.evaluate("document.querySelector('dialog[open] .files').textContent");
    assert.match(listed, /delete\s+example\/blog\/posts\/gone\.md/);
    assert.doesNotMatch(listed, /posts\/keep\.md/);
    await clickText(page, 'dialog button', 'Cancel');
    await until(page, "!document.querySelector('dialog[open]')");
    assert.ok('posts/gone.md' in (await page.evaluate("window.__fake.files('example/blog')")), 'cancelled: nothing was sent');

    await clickText(page, '#view button', 'Delete');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Delete and push');
    await until(page, "!document.querySelector('dialog[open]')", 30000);
    await until(page, "document.querySelector('.toast.success')");
    const after = await page.evaluate("window.__fake.files('example/blog')");
    assert.ok(!('posts/gone.md' in after) && !('gone/index.html' in after), 'the post and its page are gone');
    assert.ok('posts/keep.md' in after && 'keep/index.html' in after, 'the other post is published');
    assert.ok(!after['index/posts.json'].includes('"gone"'), 'and out of the index');
    await until(page, "location.hash === '#repo=example%2Fblog' || location.hash === '#repo=example/blog'");
    assert.deepEqual(await page.evaluate('window.__alerts'), []);

    // the editor has the same button, for a post that exists; a new post has none
    await page.evaluate("location.hash = '#repo=example/blog&edit=keep'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    assert.equal(await page.evaluate("[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim() === 'Delete post')"), true);
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor') && document.querySelector('#view h1').textContent === 'New post'");
    assert.equal(await page.evaluate("[...document.querySelectorAll('#view button')].some((b) => b.textContent.trim().startsWith('Delete'))"), false);
  } finally {
    chrome.close();
    web.close();
  }
});
