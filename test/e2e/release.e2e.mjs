// End to end, in real Chrome, against an in-memory GitHub: the "Embed a video" dialog is a searchable
// dropdown with the Embed button beside it. A render folder that is in the repository but has no tag
// is offered too, and embedding it publishes it first (the tag is made under the hood, after a
// pre-flight). There is no "create a release" step to find.
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
const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default' });

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-rel-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  const data = { 'example/blog': { 'blog.json': b64(BLOG), 'videos/clip/master.m3u8': b64('#EXTM3U\n'), 'videos/clip/render.json': b64('{}') } };
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify(data)};\n`);
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
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}\n--- dialog:\n${await page.evaluate("document.querySelector('dialog')?.innerText || '(none)'")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const dialogText = (page) => page.evaluate("document.querySelector('dialog[open]')?.innerText || ''");
const typeInto = (page, value) => page.evaluate(`(() => { const i = document.querySelector('dialog[open] .combo-input'); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const key = (page, k) => page.evaluate(`document.querySelector('dialog[open] .combo-input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
const options = (page) => page.evaluate("[...document.querySelectorAll('dialog[open] .combo-list li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim())");
const lastEmbed = (page) => page.evaluate("[...document.querySelectorAll('.ql-editor iframe[data-video]')].pop()?.getAttribute('data-video') || null");
const openEmbed = async (page) => {
  await page.evaluate("document.querySelector('.ql-video').click(); 0");
  await until(page, "document.querySelector('dialog[open] .combo-input')");
};

test('embed: a searchable dropdown with Embed beside it; an unpublished render folder is published under the hood', { skip, timeout: 120000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");

    // ---- the dialog: dropdown and Embed on one row, nothing about "creating a release" ----
    await openEmbed(page);
    const layout = await page.evaluate(`(() => {
      const row = document.querySelector('dialog[open] .combo-row');
      const [combo, btn] = row.children;
      const a = combo.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return { sameRow: Math.abs(a.top - b.top) < 4 && b.left >= a.right - 1, btn: btn.textContent };
    })()`);
    assert.equal(layout.sameRow, true, 'the Embed button is beside the dropdown');
    const text = await dialogText(page);
    assert.ok(!/Create a release/.test(text), 'releases are not something you ask for');
    assert.ok(!/Upload a video/.test(text), 'the blog app does not encode or upload video: a render is made elsewhere');

    // ---- an untagged render folder is found and offered; Embed says it will publish it ----
    await until(page, "document.querySelector('dialog[open] .combo-input').value === 'clip'");
    assert.equal(await page.evaluate("[...document.querySelectorAll('dialog[open] .combo-row button.primary')].map((b) => b.textContent).join()"), 'Publish and embed');
    assert.match(await dialogText(page), /Not published yet: Embed will publish it first, as clip\/v1/);

    // Back from the review returns to the dropdown, nothing sent
    await clickText(page, 'dialog button', 'Publish and embed');
    await until(page, "document.querySelector('dialog[open]').innerText.includes('Ready to create clip/v1')");
    const review = await dialogText(page);
    assert.match(review, /Tag clip\/v1 on github\.com\/example\/blog \(main\)/);
    assert.match(review, /Nothing has been uploaded\. The tag is created and never moved/);
    assert.ok(!/\bnull\b/.test(review), 'no stray "null"');
    await clickText(page, 'dialog button', 'Back');
    await until(page, "document.querySelector('dialog[open] .combo-input')");
    assert.equal(await page.evaluate("Object.keys(window.__fake.state['example/blog'].tagRefs).length"), 0);

    // publish and embed
    await clickText(page, 'dialog button', 'Publish and embed');
    await until(page, "document.querySelector('dialog[open]').innerText.includes('Ready to create clip/v1')");
    await clickText(page, 'dialog button', 'Create tag clip/v1');
    await until(page, "!document.querySelector('dialog[open]')");
    await until(page, "document.querySelector('.ql-editor iframe[data-video]')");
    assert.equal(await lastEmbed(page), 'video:videos/clip@v1');
    assert.match(await page.evaluate("document.querySelector('.toast.success .toast-title').innerText"), /^Created clip\/v1/);
    assert.deepEqual(await page.evaluate("Object.keys(window.__fake.state['example/blog'].tagRefs)"), ['clip/v1']);

    // ---- more videos: versions, and another untagged folder ----
    await page.evaluate(`(() => {
      const S = window.__fake.state['example/blog'];
      S.tagRefs['clip/v2'] = S.branches.main;
      const tree = S.trees[S.commits[S.branches.main].tree];
      tree.set('videos/harbour-walk/master.m3u8', tree.get('videos/clip/master.m3u8'));
    })()`);
    await openEmbed(page);
    await until(page, "document.querySelector('dialog[open] .combo-input').value === 'clip v2'");
    assert.equal(await page.evaluate("document.querySelector('dialog[open] .combo-row button.primary').textContent"), 'Embed', 'a published release embeds directly');
    await page.evaluate("document.querySelector('dialog[open] .combo-toggle').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); 0");
    await until(page, "!document.querySelector('dialog[open] .combo-list').hidden");
    assert.deepEqual(await options(page), ['clip example/blog/videos v2', 'clip example/blog/videos v1', 'harbour-walk example/blog/videos not published yet']);

    // ---- search ----
    await typeInto(page, 'v1');
    assert.deepEqual(await options(page), ['clip example/blog/videos v1']);
    await typeInto(page, 'harb');
    assert.deepEqual(await options(page), ['harbour-walk example/blog/videos not published yet']);
    await typeInto(page, 'not published');
    assert.deepEqual((await options(page)).length, 1, 'the badge is searchable too');
    await typeInto(page, 'BLOG/videos clip');
    assert.deepEqual(await options(page), ['clip example/blog/videos v2', 'clip example/blog/videos v1'], 'case-insensitive, any order, the repository counts');
    await typeInto(page, 'zzz');
    assert.deepEqual(await options(page), ['No video matches']);
    assert.equal(await page.evaluate("document.querySelector('dialog[open] .combo-row button.primary').disabled"), true, 'nothing chosen: nothing to embed');

    // ---- keyboard: filter, arrows, Enter chooses, Enter again embeds ----
    await typeInto(page, 'clip');
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    assert.equal(await page.evaluate("document.querySelector('dialog[open] .combo-input').value"), 'clip v1', 'ArrowDown moved to the second match; Enter chose it');
    assert.equal(await page.evaluate("document.querySelector('dialog[open] .combo-list').hidden"), true);
    // Escape closes an open list and leaves the dialog alone
    await key(page, 'ArrowDown');
    assert.equal(await page.evaluate("document.querySelector('dialog[open] .combo-list').hidden"), false);
    await key(page, 'Escape');
    assert.equal(await page.evaluate("document.querySelector('dialog[open] .combo-list').hidden"), true);
    assert.ok(await page.evaluate("!!document.querySelector('dialog[open]')"), 'the dialog is still there');
    await key(page, 'Enter');
    await until(page, "!document.querySelector('dialog[open]')");
    assert.equal(await lastEmbed(page), 'video:videos/clip@v1');

    // ---- the Embed button embeds the chosen entry ----
    await openEmbed(page);
    await page.evaluate("document.querySelector('dialog[open] .combo-input').focus(); 0");
    await clickText(page, 'dialog button', 'Embed');
    await until(page, "!document.querySelector('dialog[open]')");
    assert.equal(await lastEmbed(page), 'video:videos/clip@v2');
  } finally {
    chrome.close();
    web.close();
  }
});
