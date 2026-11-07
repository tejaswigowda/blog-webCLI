// End to end, in real Chrome, against an in-memory GitHub with latency: a blog of 300 posts. Saving a setting reads every post, and
// the activity line says how far it has got and offers Stop; Stop changes nothing; saving again goes through, the send is reported
// the same way, and what is on GitHub afterwards is the regenerated site.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { buildSite } from '../../lib/blog.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const COUNT = 300;
const post = (n) => `---\nslug: p${n}\ntitle: Post number ${n}\ndate: 2025-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}\nstatus: published\n---\n\nWords of post ${n}.\n`;

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-bulk-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  const blog = { title: 'Big Blog', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default', pageSize: 25 };
  const posts = Array.from({ length: COUNT }, (_, n) => ({ path: `posts/p${n}.md`, text: post(n) }));
  const built = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(built.errors, []);
  const files = { ...built.files, 'blog.json': JSON.stringify(blog), ...Object.fromEntries(posts.map((p) => [p.path, p.text])) };
  const data = { 'example/blog': Object.fromEntries(Object.entries(files).map(([p, t]) => [p, Buffer.from(t).toString('base64')])), 'example/images': { 'README.md': Buffer.from('i').toString('base64') } };
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
  // GitHub takes time: enough that a person could see the job going, and press Stop
  window.fetch = async (u, o) => {
    if (new URL(u, location.href).origin === location.origin) return real(u, o);
    if (/graphql|git\\/trees/.test(String(u))) await new Promise((r) => setTimeout(r, 250));
    return fake.fetch(u, o);
  };
`;
const until = async (page, expr, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}\n--- the page says: ${await page.evaluate("(document.querySelector('.activity') || {}).innerText + ' | ' + ((document.querySelector('.toast') || {}).innerText || '')")}`);
    await new Promise((r) => setTimeout(r, 60));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(text)}); el.click(); })()`);
const fill = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const activity = (page) => page.evaluate("document.querySelector('.activity') && !document.querySelector('.activity').hidden ? document.querySelector('.activity').innerText : ''");

test('a big blog: saving settings reports the reading and the sending, offers Stop, and Stop changes nothing', { skip, timeout: 240000 }, async () => {
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
    await page.evaluate("location.hash = '#repo=example/blog&settings'; 0");
    await until(page, "[...document.querySelectorAll('#view label')].find((l) => l.textContent === 'Title')");
    const title = "[...document.querySelectorAll('#view label')].find((l) => l.textContent === 'Title').nextElementSibling";
    await page.evaluate(`(() => { const i = ${title}; i.value = 'A Changed Title'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    // the first try is stopped part way through reading
    await clickText(page, '#view button', 'Save settings');
    await until(page, "/Preparing the changes · reading [\\d,]+ of 300/.test(document.querySelector('.activity').innerText)");
    assert.ok(await page.evaluate("document.querySelector('.activity .activity-stop')"), 'there is a Stop button');
    await page.evaluate("document.querySelector('.activity .activity-stop').click(); 0");
    await until(page, "document.querySelector('.toast.error')");
    assert.match(await page.evaluate("document.querySelector('.toast.error').innerText"), /Stopped\. Nothing was changed/);
    const unchanged = await page.evaluate("JSON.parse(window.__fake.files('example/blog')['blog.json']).title");
    assert.equal(unchanged, 'Big Blog', 'nothing was written');
    assert.equal(await page.evaluate("window.__fake.state['example/blog'].log.filter((l) => /^(POST|PATCH) (git|refs)/.test(l)).length"), 0);
    await until(page, "!document.querySelector('.activity') || document.querySelector('.activity').hidden");

    // the second goes through: the posts read so far are not read again, the pre-flight is shown, the send is reported
    await page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove()); 0");
    await clickText(page, '#view button', 'Save settings');
    await until(page, "document.querySelector('dialog[open] .preflight')", 40000);
    assert.match(await page.evaluate("document.querySelector('dialog[open] .preflight').innerText"), /files?, .* to github\.com\/example\/blog \(main\)/);
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "/Committing · sending [\\d,]+ of [\\d,]+/.test(document.querySelector('.activity').innerText)", 40000);
    await until(page, "document.querySelector('.toast.success')", 60000);
    const now = await page.evaluate("window.__fake.files('example/blog')");
    assert.equal(JSON.parse(now['blog.json']).title, 'A Changed Title');
    assert.match(now['index.html'], /A Changed Title/);
    assert.match(now['p299/index.html'], /A Changed Title/, 'every page of every post was regenerated');
    const log = await page.evaluate("window.__fake.state['example/blog'].log");
    assert.equal(log.filter((l) => /^GET contents\/posts\//.test(l)).length, 0, 'not one request per post');
    assert.ok(log.filter((l) => l === 'POST graphql 100').length >= 3);
  } finally {
    chrome.close();
    web.close();
  }
});
