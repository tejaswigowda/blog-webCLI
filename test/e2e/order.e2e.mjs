// End to end, in real Chrome: a blog ordered by hand. The /blog/ reader lists posts in the blog's own order (drafts
// left out), a reader's sort reorders the list and nothing else (no address, no previous/next), and the editor
// says, before anything is sent, that a published post is in no list and will be appended.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../lib/blog.js';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const post = (slug, title, date, status = 'published') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: ${title}\ndate: ${date}\nstatus: ${status}\n---\n\nBody of ${title}.\n` });
const POSTS = [post('lesson-1', 'Lesson one', '2026-01-01'), post('lesson-2', 'Lesson two', '2026-02-01'), post('lesson-3', 'Lesson three', '2026-03-01'), post('secret-draft', 'Secret draft', '2026-04-01', 'draft')];
const LIST = JSON.stringify({ order: ['lesson-3', 'lesson-1', 'secret-draft', 'lesson-2'] });
const BLOG = JSON.stringify({ title: 'Course', description: 'd', author: 'A', domain: 'https://example.github.io/course', repo: 'example/course', theme: 'default', order: { by: 'manual' } });
const b64 = (t) => Buffer.from(t).toString('base64');

function courseFiles() {
  const built = buildSite({ blog: BLOG, posts: POSTS, lock: {}, orderList: LIST });
  assert.deepEqual(built.errors, []);
  return { ...built.files, 'blog.json': BLOG, 'order.json': LIST, ...Object.fromEntries(POSTS.map((p) => [p.path, p.text])) };
}

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
const titles = (page) => page.evaluate("[...document.querySelectorAll('.posts li h2 a')].map((a) => a.textContent)");

test('reader: the blog\'s own order, a reader sort that changes only the list, and previous/next from the sequence', { skip, timeout: 120000 }, async () => {
  const web = await serve(root);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/blog/`);
    await until(page, "document.querySelector('#reader')");
    const files = Object.fromEntries(Object.entries(courseFiles()).map(([p, t]) => [p, b64(t)]));
    await page.evaluate(`(async () => {
      const m = await import('/test/fake-github.js');
      const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const files = Object.fromEntries(Object.entries(JSON.parse(atob(${JSON.stringify(b64(JSON.stringify(files)))}))).map(([p, b]) => [p, dec(b)]));
      const fake = m.fakeGitHub({ 'example/course': files });
      await fake.ready;
      window.fetch = (u, o) => fake.fetch(u, o);
      location.hash = '#repo=example/course';
    })()`);
    await until(page, "document.querySelector('#reader-sort')");

    // O1/O2/O4: the blog's order, as the index records it, with the draft left out
    assert.deepEqual(await titles(page), ['Lesson three', 'Lesson one', 'Lesson two']);
    assert.ok(!(await page.evaluate('document.body.innerText')).includes('Secret draft'));
    assert.equal(await page.evaluate("document.querySelector('#reader-sort').value"), 'order');

    // O6: a reader's sort reorders the list, and the address stays exactly as it was
    await page.evaluate("(() => { const s = document.querySelector('#reader-sort'); s.value = 'newest'; s.dispatchEvent(new Event('change')); })()");
    await until(page, "document.querySelector('.posts li h2 a').textContent === 'Lesson three' && document.querySelectorAll('.posts li h2 a')[1].textContent === 'Lesson two'");
    assert.deepEqual(await titles(page), ['Lesson three', 'Lesson two', 'Lesson one']);
    assert.equal(await page.evaluate('location.hash'), '#repo=example/course', 'a sort changes no URL');
    assert.equal(await page.evaluate("location.search + location.pathname"), '/blog/');
    await page.evaluate("(() => { const s = document.querySelector('#reader-sort'); s.value = 'title'; s.dispatchEvent(new Event('change')); })()");
    await until(page, "document.querySelector('.posts li h2 a').textContent === 'Lesson one'");
    assert.deepEqual(await titles(page), ['Lesson one', 'Lesson three', 'Lesson two']);
    assert.equal(await page.evaluate('location.hash'), '#repo=example/course');

    // O4/O6: a post's previous/next are the blog's sequence (three, one, two), whatever the list was sorted by
    await page.evaluate("location.hash = '#repo=example/course&post=lesson-1'; 0");
    await until(page, "document.querySelector('nav.post-nav')");
    assert.equal(await page.evaluate("document.querySelector('nav.post-nav a.prev').textContent"), '← Lesson three');
    assert.equal(await page.evaluate("document.querySelector('nav.post-nav a.next').textContent"), 'Lesson two →');
    assert.equal(await page.evaluate("document.querySelector('nav.post-nav a.prev').getAttribute('href')"), '#repo=example/course&post=lesson-3');
    // the first post: a next and no previous at all
    await page.evaluate("location.hash = '#repo=example/course&post=lesson-3'; 0");
    await until(page, "document.querySelector('nav.post-nav a.next')");
    assert.equal(await page.evaluate("document.querySelector('nav.post-nav a.prev')"), null, 'absent, not disabled');
    // the last post: a previous and no next
    await page.evaluate("location.hash = '#repo=example/course&post=lesson-2'; 0");
    await until(page, "document.querySelector('nav.post-nav a.prev') && !document.querySelector('nav.post-nav a.next')");
    assert.equal(await page.evaluate("document.querySelector('nav.post-nav a.prev').textContent"), '← Lesson one');

    // the choice is the reader's for the session
    await page.evaluate("location.hash = '#repo=example/course'; 0");
    await until(page, "document.querySelector('#reader-sort')");
    assert.equal(await page.evaluate("document.querySelector('#reader-sort').value"), 'title');
    assert.deepEqual(await titles(page), ['Lesson one', 'Lesson three', 'Lesson two']);
  } finally {
    chrome.close();
    web.close();
  }
});

async function editorSite(blog, files) {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-order-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/course': Object.fromEntries(Object.entries({ 'blog.json': blog, ...files }).map(([p, t]) => [p, b64(t)])) })};\n`);
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
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const setValue = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); })()`);

test('editor: the list shows the blog\'s order; a post that is in no list is announced in the pre-flight, then appended', { skip, timeout: 120000 }, async () => {
  const web = await serve(await editorSite(BLOG, { 'order.json': LIST, ...Object.fromEntries(POSTS.map((p) => [p.path, p.text])) }));
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await page.evaluate("[...document.querySelectorAll('#top button')].find((b) => b.textContent.startsWith('Sign in')).click(); 0");
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");

    // a new post that the list does not name
    await page.evaluate("location.hash = '#repo=example/course&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await setValue(page, '#view input[placeholder=Title]', 'Lesson four');
    await setValue(page, '#view input[placeholder^="set once"]', 'lesson-4');
    await page.evaluate("(() => { const s = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === 'published')); s.value = 'published'; s.dispatchEvent(new Event('change')); })()");
    await clickText(page, '#view button', 'Publish');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    const note = await page.evaluate("(document.querySelector('dialog .caution') || {}).innerText || ''");
    assert.match(note, /This post is not in order\.json, so it will be added at the end, by date: lesson-4\./);
    assert.match(note, /Add it to order\.json to place it\./);
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.toast.success')");

    // appended, with its page, and the sequence recorded; order.json itself was not touched
    const out = await page.evaluate("window.__fake.files('example/course')");
    assert.deepEqual(JSON.parse(out['index/posts.json']).sequence, ['lesson-3', 'lesson-1', 'lesson-2', 'lesson-4']);
    assert.equal(out['order.json'], LIST, 'the authored list is never rewritten by a publish');
    assert.ok(out['lesson-4/index.html'].includes('<link rel="prev" href="../lesson-2/">'));
    assert.ok(!out['lesson-4/index.html'].includes('rel="next"'));
    assert.ok(out['lesson-2/index.html'].includes('<link rel="next" href="../lesson-4/">'), 'the post before it gained a next');
    assert.ok(!out['lesson-2/index.html'].includes('secret-draft'));

    // the editor's list is in the blog's order, with a sort of its own
    await page.evaluate("location.hash = '#repo=example/course'; 0");
    await until(page, "document.querySelectorAll('#view ul.posts li').length === 4");
    const list = () => page.evaluate("[...document.querySelectorAll('#view ul.posts li h3 button')].map((b) => b.textContent)");
    assert.deepEqual(await list(), ['Lesson three', 'Lesson one', 'Lesson two', 'Lesson four']);
    await page.evaluate("(() => { const s = document.querySelector('.sortbar select'); s.value = 'oldest'; s.dispatchEvent(new Event('change')); })()");
    await until(page, "document.querySelector('#view ul.posts li h3 button').textContent === 'Lesson one'");
    assert.deepEqual(await list(), ['Lesson one', 'Lesson two', 'Lesson three', 'Lesson four']);
    assert.equal(await page.evaluate('location.hash'), '#repo=example/course', 'a sort changes no URL');
  } finally {
    chrome.close();
    web.close();
  }
});
