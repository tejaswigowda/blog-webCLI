// End to end, in real Chrome, against an in-memory GitHub: the editor shows where a publish is on its way to
// readers (committed -> building -> live with a clock), withholds "Copy link" until GitHub says the build is
// live, shows a failed build's own error, and warns about GitHub Pages' build limit before it is reached.
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
const BLOG = (extra = {}) => JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default', content: { base: 'https://raw.example/{owner}/{repo}/{ref}/{path}' }, ...extra });

async function site(blog = BLOG()) {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-deploy-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': Buffer.from(blog).toString('base64') } })};\n`);
  return copy;
}

// window.__build is the Pages build GitHub "reports": the test moves it from state to state
const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  window.__build = null;
  window.__deployment = 'forbidden'; // the deployment of the commit: a status, null (none yet) or 'forbidden' (cannot be read)
  const fake = m.fakeGitHub(repos, { pages: { 'example/blog': 'https://example.github.io/blog/' }, builds: { 'example/blog': () => window.__build }, deployments: { 'example/blog': () => window.__deployment } });
  await fake.ready;
  window.__fake = fake;
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (new URL(u, location.href).origin === location.origin ? real(u, o) : fake.fetch(u, o));
`;

const until = async (page, expr, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 120));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const setValue = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); })()`);
const text = (page, sel) => page.evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);

async function signedIn(web, seed = '') {
  const chrome = await launch();
  const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
  await until(page, "document.querySelector('#top button')");
  if (seed) await page.evaluate(seed);
  await page.evaluate(`(async () => { ${INSTALL} })()`);
  await page.evaluate("[...document.querySelectorAll('#top button')].find((b) => b.textContent.startsWith('Sign in')).click(); 0");
  await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
  await clickText(page, 'dialog button', 'Sign in');
  await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
  return { chrome, page };
}

const iso = (ms) => new Date(ms).toISOString();
const head = (page) => page.evaluate("window.__fake.state['example/blog'].branches.main");

test('deploy: committed -> building -> live, with the link withheld until it is live; a failed build says why', { skip, timeout: 180000 }, async () => {
  const web = await serve(await site());
  const { chrome, page } = await signedIn(web);
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await setValue(page, '#view input[placeholder=Title]', 'Fast one');
    await setValue(page, '#view input[placeholder^="set once"]', 'fast-one');
    await page.evaluate("(() => { const s = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === 'published')); s.value = 'published'; s.dispatchEvent(new Event('change')); })()");
    await clickText(page, '#view button', 'Publish');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.deploy:not([hidden])')");

    // committed: no build yet. The panel says what readers can already do, and the link is not offered yet.
    assert.match(await text(page, '.deploy .steps'), /Committed/);
    assert.equal(await page.evaluate("document.querySelector('.deploy .step.done').textContent"), 'Committed');
    assert.match(await text(page, '.deploy'), /Readers can already open this link and see the current text/);
    assert.match(await text(page, '.deploy'), /Link previews .* wait for the build/);
    assert.equal(await page.evaluate("document.querySelector('.deploy button[title]').disabled"), true, 'Copy link is withheld');
    assert.equal(await page.evaluate("document.querySelector('.deploy .step.active')"), null);

    // GitHub starts a build for our commit
    const sha = await head(page);
    await page.evaluate(`window.__build = { status: 'building', commit: ${JSON.stringify(sha)}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; 0`);
    await until(page, "document.querySelector('.deploy .step.active')");
    assert.match(await page.evaluate("document.querySelector('.deploy .step.active').textContent"), /^Building \(\d+:\d\d\)$/);
    assert.equal(await page.evaluate("document.querySelector('.deploy button[title]').disabled"), true, 'still withheld while building');

    // it finishes: live, with the time it took, and now the link is offered
    await page.evaluate(`window.__build = { status: 'built', commit: ${JSON.stringify(sha)}, created_at: new Date(Date.now() - 20000).toISOString(), updated_at: new Date().toISOString() }; 0`);
    await until(page, "[...document.querySelectorAll('.deploy .step')].some((s) => /^Live \\(\\d+:\\d\\d\\)$/.test(s.textContent))");
    assert.equal(await page.evaluate("document.querySelector('.deploy button[title]').disabled"), false, 'Copy link is available once live');
    assert.equal(await page.evaluate("document.querySelector('.deploy button[title]').title"), 'https://example.github.io/blog/fast-one/');
    assert.match(await text(page, '.deploy'), /Link previews will now show this post too/);

    // an edit whose build fails: GitHub's own message, no share
    await setValue(page, '#view input[placeholder=Title]', 'Fast one, edited');
    await clickText(page, '#view button', 'Publish');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.deploy .step') && !document.querySelector('.deploy .step.done + .step.done + .step.done')");
    const sha2 = await head(page);
    assert.notEqual(sha2, sha);
    await page.evaluate(`window.__build = { status: 'errored', commit: ${JSON.stringify(sha2)}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: { message: 'Page build failed: tag not closed in index.html' } }; 0`);
    await until(page, "document.querySelector('.deploy .step.failed')");
    assert.match(await text(page, '.deploy .err'), /GitHub Pages could not build the site: Page build failed: tag not closed in index\.html/);
    assert.match(await text(page, '.deploy .err'), /Readers still see the current text/);
    assert.equal(await page.evaluate("document.querySelector('.deploy button[title]').disabled"), true, 'no link to share from a failed build');

    // the build record says errored but the deployment of the commit succeeds (the record is wrong): never shown as a failure
    await setValue(page, '#view input[placeholder=Title]', 'Fast one, edited again');
    await clickText(page, '#view button', 'Publish');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await page.evaluate("window.__deployment = null; 0");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.deploy .step') && !document.querySelector('.deploy .step.done + .step.done + .step.done') && !document.querySelector('.deploy .step.failed')");
    const sha3 = await head(page);
    await page.evaluate(`window.__build = { status: 'errored', commit: ${JSON.stringify(sha3)}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: { message: 'Page build failed.' } }; 0`);
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(await page.evaluate("Boolean(document.querySelector('.deploy .step.failed, .deploy .err'))"), false, 'no deployment yet: still building, not failed');
    await page.evaluate("window.__deployment = 'success'; 0");
    await until(page, "[...document.querySelectorAll('.deploy .step')].some((s) => /^Live \\(\\d+:\\d\\d\\)$/.test(s.textContent))");
    assert.equal(await page.evaluate("Boolean(document.querySelector('.deploy .err'))"), false);
  } finally {
    chrome.close();
    web.close();
  }
});

test('deploy: a draft has states but no link; a token that cannot read Pages is told so, and nothing is guessed', { skip, timeout: 120000 }, async () => {
  const web = await serve(await site());
  const { chrome, page } = await signedIn(web);
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await setValue(page, '#view input[placeholder=Title]', 'Draft one');
    await setValue(page, '#view input[placeholder^="set once"]', 'draft-one');
    await page.evaluate("window.__build = 'forbidden'; 0");
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.deploy .caution')");
    assert.match(await text(page, '.deploy .caution'), /Pages: Read-only/);
    assert.equal(await page.evaluate("document.querySelector('.deploy button')"), null, 'a draft has no link to copy');
  } finally {
    chrome.close();
    web.close();
  }
});

test('L10: the pre-flight warns before the limit (from build 8) and says so plainly at it', { skip, timeout: 120000 }, async () => {
  const web = await serve(await site());
  const stamps = (n) => `localStorage.setItem('blog.webcli.builds:example/blog', JSON.stringify(Array.from({ length: ${n} }, (_, i) => Date.now() - (i + 1) * 60000))); 0`;
  const { chrome, page } = await signedIn(web);
  try {
    const preflight = async () => {
      await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
      await until(page, "document.querySelector('.ql-editor')");
      await setValue(page, '#view input[placeholder=Title]', 'Rate');
      await setValue(page, '#view input[placeholder^="set once"]', 'rate');
      await clickText(page, '#view button', 'Save draft');
      await until(page, "document.querySelector('dialog[open] .preflight')");
      const t = await text(page, 'dialog');
      const cls = await page.evaluate("document.querySelector('dialog .caution') ? 'caution' : document.querySelector('dialog .err') ? 'err' : 'none'");
      await clickText(page, 'dialog button', 'Cancel');
      await until(page, "!document.querySelector('dialog[open]')");
      return { t, cls };
    };
    await page.evaluate(stamps(3));
    assert.equal((await preflight()).cls, 'none', 'three builds: nothing to say');
    await page.evaluate(stamps(6));
    assert.equal((await preflight()).cls, 'none', 'the seventh build is still fine');
    await page.evaluate(stamps(7));
    const warn = await preflight();
    assert.equal(warn.cls, 'caution', 'the eighth is where it speaks, with two to spare');
    assert.match(warn.t, /build 8 in the last hour/);
    assert.match(warn.t, /Readers still see what you publish/, 'this blog renders fresh content itself, so readers lose nothing');
    await page.evaluate(stamps(10));
    const limit = await preflight();
    assert.equal(limit.cls, 'err');
    assert.match(limit.t, /10 builds in the last hour: GitHub Pages has probably stopped building/);
  } finally {
    chrome.close();
    web.close();
  }
});
