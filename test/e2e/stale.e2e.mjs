// End to end, in real Chrome: a tab that was opened before the editor was updated sends nothing. app-build.json (made from every
// script of app/ and lib/) is compared with the one the tab started with before a pre-flight is offered and before a commit is made.
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

export async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-stale-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await cp(path.join(root, 'app-build.json'), path.join(copy, 'app-build.json'));
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

test('stale tab: after an update the editor offers no pre-flight and sends nothing; unchanged, it works', { skip, timeout: 180000 }, async () => {
  const copy = await site();
  const web = await serve(copy);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&post=gone'; 0");
    await until(page, "document.querySelector('article.post')");

    // the build is the one the tab started with: the pre-flight opens
    await clickText(page, '#view button', 'Delete');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Cancel');
    await until(page, "!document.querySelector('dialog[open]')");

    // the editor is updated while the tab stays open
    await writeFile(path.join(copy, 'app-build.json'), '{"id":"0000000000000000","version":"9.9.9"}\n');
    const writes = () => page.evaluate("window.__fake.state['example/blog'].log.filter((l) => /^(POST|PATCH|PUT|DELETE) /.test(l)).length");
    const before = await writes();
    await clickText(page, '#view button', 'Delete');
    await until(page, "document.querySelector('.toast.error')");
    assert.match(await page.evaluate("document.querySelector('.toast.error').innerText"), /stale-app[\s\S]*Reload the page/);
    assert.equal(await page.evaluate("Boolean(document.querySelector('dialog[open] .preflight'))"), false, 'no pre-flight is offered');
    assert.equal(await writes(), before, 'nothing was sent');
    assert.ok('posts/gone.md' in (await page.evaluate("window.__fake.files('example/blog')")));
  } finally {
    chrome.close();
    web.close();
  }
});
