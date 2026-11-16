import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildSite } from '../../lib/blog.js';
import { EXAMPLE_BLOG } from '../../lib/sample.js';
import { MATH_ID } from '../../lib/math-syntax.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const skip = chromePath() ? false : 'Chrome is not installed';
const source = await readFile(new URL('../corpus/math.md', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('\n---\n') + 6);
const post = (slug, text) => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: ${slug}\ndate: 2026-11-16\nstatus: published\n---\n\n${text}` });
const wait = async (page, expression) => {
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate('document.documentElement.dataset.webcliWhy || document.body.innerText')}`);
};

async function world({ live = false } = {}) {
  let built, latest, origin, unavailable = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    requests.push(path);
    if (path === '/editor.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><div id="editor"></div>');
    if (/^\/(?:app|lib|vendor)\/[\w/.-]+$/.test(path) && !path.includes('..')) {
      try {
        const file = await readFile(new URL(`../..${path}`, import.meta.url));
        return res.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(file);
      } catch (e) {
        if (e.code !== 'ENOENT') return res.writeHead(500).end(e.message);
        return res.writeHead(404).end('Missing fixture');
      }
    }
    const content = path.startsWith('/content/me/blog/HEAD/');
    let key = content ? path.slice('/content/me/blog/HEAD/'.length) : path.slice(1);
    if (!content && (!key || key.endsWith('/'))) key += 'index.html';
    const files = content ? latest : built.files;
    const value = unavailable && key === 'webcli-math.js' ? undefined : files[key];
    if (value === undefined) return res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(built.files['404.html'] || 'Missing');
    res.writeHead(200, { 'content-type': key.endsWith('.js') ? 'text/javascript' : key.endsWith('.json') ? 'application/json' : key.endsWith('.md') ? 'text/plain' : 'text/html', 'cache-control': 'no-store' }).end(value);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const blog = { ...EXAMPLE_BLOG, repo: 'me/blog', domain: origin, ...(live ? { content: { base: `${origin}/content/{owner}/{repo}/{ref}/{path}` } } : {}) };
  const old = [post('plain', 'Old prose.\n'), post('math', live ? 'Old math page.\n' : body), post('current', body)];
  built = buildSite({ blog, posts: old, lock: {} });
  assert.deepEqual(built.errors, []);
  const posts = [post('plain', 'Updated prose.\n'), post('math', body), post('current', body), post('added', body)];
  const next = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(next.errors, []);
  latest = { ...next.files, 'blog.json': JSON.stringify(blog), ...Object.fromEntries(posts.map((p) => [p.path, p.text])) };
  return { origin, requests, built, latest, unavailable: (value) => { unavailable = value; }, close: () => server.close() };
}

test('V1/V14: MathML renders without scripts, fonts or math CSS at desktop and phone widths', { skip, timeout: 60000 }, async (t) => {
  const w = await world();
  const chrome = await launch();
  try {
    const page = await openPage(chrome, 'about:blank');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
    await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    for (const width of [1280, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.send('Page.navigate', { url: `${w.origin}/math/?width=${width}` });
      await wait(page, `location.search === '?width=${width}' && document.readyState === 'complete' && document.querySelectorAll('math').length === 7`);
      const result = await page.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('math')].map(e => { const r = e.getBoundingClientRect(); return {width:r.width,height:r.height,left:r.left,right:r.right}; });
        const rows = [...document.querySelectorAll('mtable mtr')].map(e => { const r = e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; });
        return {boxes,rows,annotations:document.querySelectorAll('annotation').length,scripts:document.scripts.length,overflow:document.documentElement.scrollWidth > innerWidth,resources:performance.getEntriesByType('resource').map(e=>e.name)};
      })()`);
      assert.equal(result.annotations, 7);
      assert.equal(result.scripts, 1, 'only existing structured-data script; no executable script');
      assert.equal(result.overflow, false);
      assert.ok(result.boxes.every((b) => b.width > 0 && b.height > 0 && b.left >= 0 && b.right <= width));
      assert.equal(result.rows.length, 2);
      assert.ok(result.rows[1].top >= result.rows[0].bottom, 'aligned rows have native layout');
      assert.ok(!result.resources.some((r) => /webcli-.*\.js|temml|woff|math.*\.css/i.test(r)));
      t.diagnostic(`${width}px: 7 visible equations, 2 aligned rows, no overflow or math resources`);
    }
  } finally { chrome.close(); w.close(); }
});

test('V10/V11: live checks fetch math only for changed math, including a new post through 404', { skip, timeout: 90000 }, async () => {
  const w = await world({ live: true });
  const chrome = await launch();
  try {
    const blank = await openPage(chrome, 'about:blank');
    await blank.send('Network.enable');
    await blank.send('Network.setBlockedURLs', { urls: ['https://*'] });
    for (const [slug, state, mathRequests] of [['plain', 'rebuilt', 0], ['current', 'current', 0], ['math', 'rebuilt', 1], ['added', 'rebuilt', 1]]) {
      const before = w.requests.filter((p) => p === '/webcli-math.js').length;
      const page = await openPage(chrome, `${w.origin}/${slug}/`);
      await wait(page, `document.documentElement.dataset.webcliLive === '${state}'`);
      assert.equal(w.requests.filter((p) => p === '/webcli-math.js').length - before, mathRequests, slug);
      if (slug === 'math' || slug === 'added') {
        assert.equal(await page.evaluate("document.querySelectorAll('math').length"), 7);
        assert.equal(await page.evaluate("document.querySelector('meta[name=\"x-math\"]').content"), MATH_ID);
        const expected = w.latest[`${slug}/index.html`];
        const same = await page.evaluate(`(() => {
          const expected = new DOMParser().parseFromString(${JSON.stringify(expected)},'text/html');
          return document.querySelector('article').outerHTML === expected.querySelector('article').outerHTML;
        })()`);
        assert.equal(same, true, 'live and generated article DOM match');
      }
      page.close();
    }
    w.unavailable(true);
    const failed = await openPage(chrome, `${w.origin}/math/?failed=1`);
    await wait(failed, "document.documentElement.dataset.webcliLive === 'left'");
    assert.match(await failed.evaluate('document.body.innerText'), /Old math page/);
    assert.match(await failed.evaluate('document.documentElement.dataset.webcliWhy'), /import|module|fetch/i, 'a missing bundle is an explicit live refusal');
  } finally { chrome.close(); w.close(); }
});

test('V4/V5: real Quill preserves inline math and the math fence language on reopen and edit', { skip, timeout: 60000 }, async () => {
  const w = await world();
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${w.origin}/editor.html`);
    const result = await page.evaluate(`(async () => {
      const {createEditor} = await import('/app/editor.js');
      const {mdToDelta,deltaToMarkdownChecked} = await import('/lib/markdown.js');
      const q = await createEditor(document.querySelector('#editor'), {});
      q.setContents(mdToDelta(${JSON.stringify(body)}),'api');
      const before = deltaToMarkdownChecked(q.getContents()).md;
      const math = q.getContents().ops.find(op=>op.attributes?.math);
      let index = 0;
      for (const op of q.getContents().ops) { if(op.attributes?.math) break; index += typeof op.insert === 'string' ? op.insert.length : 1; }
      q.insertText(index+1,'z','user');
      const after = deltaToMarkdownChecked(q.getContents()).md;
      q.setContents(mdToDelta(after),'api');
      return {before,after,reopened:deltaToMarkdownChecked(q.getContents()).md,math};
    })()`);
    assert.equal(result.before, body);
    assert.equal(result.after, body.replace('x_1 + a_{ij}', 'xz_1 + a_{ij}'));
    assert.equal(result.reopened, result.after);
    assert.equal(result.math.attributes.math, true);
  } finally { chrome.close(); w.close(); }
});
