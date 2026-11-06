// A minimal Chrome DevTools driver for end-to-end tests: launch headless Chrome, open a page,
// evaluate async expressions in it. No dependencies. Tests skip when Chrome is not installed.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
export const chromePath = () => CANDIDATES.find((p) => existsSync(p)) || null;

// Chrome picks its own free debugging port (--remote-debugging-port=0) and says which in
// DevToolsActivePort: test files run in parallel, and a fixed or random port can be taken by another.
export async function launch() {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'blog-e2e-'));
  const proc = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const close = () => proc.kill();
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (port && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { proc, port, close };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  close();
  throw new Error('Chrome did not start (no DevTools port after 20 s)');
}

export async function openPage({ port }, url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not open the DevTools socket'));
    setTimeout(() => reject(new Error('timed out opening the DevTools socket')), 20000);
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  ws.onclose = () => { for (const f of pending.values()) f({ result: { exceptionDetails: { exception: { description: 'the page closed' } } } }); pending.clear(); };
  // a call that never answers fails the test instead of hanging the run
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`DevTools ${method} gave no answer in 90 s`)); }, 90000);
    pending.set(i, (d) => { clearTimeout(t); res(d); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    return r.result.result.value;
  };
  return { evaluate, close: () => ws.close() };
}
