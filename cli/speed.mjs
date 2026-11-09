#!/usr/bin/env node
// One page-speed claim, with its method. Loads a published page cold (a fresh browser profile, cache off) in headless Chrome under a throttled
// connection and CPU, N times, and reports the median of each: transfer, requests, JavaScript bytes and files, FCP, LCP, and total blocking time.
//
//   node cli/speed.mjs <address> [--runs 5] [--profile 4g|fast3g] [--json]
//
// Method (the numbers mean nothing without it):
//   network  4g: 1.6 Mbit/s down, 750 kbit/s up, 150 ms round trip (Lighthouse's "Slow 4G" mobile preset); fast3g: 1.6 Mbit/s, 562 ms.
//   cpu      4x slowdown (a mid-range phone), via Emulation.setCPUThrottlingRate.
//   viewport 390x844, mobile, device pixel ratio 2.
//   cold     a new Chrome profile for every run, Network.setCacheDisabled(true): nothing cached, no service worker.
//   FCP, LCP from PerformanceObserver (buffered), read 3 s after load. TBT = sum over long tasks of (duration - 50 ms) from first contentful paint.
//   JS      counted from the network: every response whose resource type is Script, with its encoded (transferred) size.
// Caveats: this is lab data from one machine and one network path; the throttle shapes the connection but a CDN's real latency still adds.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromePath } from '../test/e2e/cdp.mjs';

const args = process.argv.slice(2);
const flagv = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const address = args.find((a, i) => !a.startsWith('--') && !['--runs', '--profile'].includes(args[i - 1]));
if (!address) { console.error('usage: node cli/speed.mjs <address> [--runs 5] [--profile 4g|fast3g] [--json]'); process.exit(2); }
const runs = Number(flagv('--runs', 5));
const PROFILES = { '4g': { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }, fast3g: { latency: 562, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } };
const profile = PROFILES[flagv('--profile', '4g')];
if (!profile) { console.error('profile is 4g or fast3g'); process.exit(2); }

async function once() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'speed-'));
  const proc = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) { try { port = Number(readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (port && !(await fetch(`http://127.0.0.1:${port}/json/version`)).ok) port = 0; } catch { port = 0; } if (!port) await new Promise((r) => setTimeout(r, 200)); }
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const scripts = new Map();
    const reqs = new Map();
    let encoded = 0;
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
      if (d.method === 'Network.requestWillBeSent') reqs.set(d.params.requestId, d.params.type);
      if (d.method === 'Network.loadingFinished') { encoded += d.params.encodedDataLength; if (reqs.get(d.params.requestId) === 'Script') scripts.set(d.params.requestId, d.params.encodedDataLength); }
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Network.emulateNetworkConditions', { offline: false, ...profile });
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.enable');
    await send('Runtime.enable');
    // observers before any script of the page runs
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__m={lcp:0,fcp:0,tasks:[]};new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__m.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver((l)=>{for(const e of l.getEntries())if(e.name==='first-contentful-paint')window.__m.fcp=e.startTime}).observe({type:'paint',buffered:true});try{new PerformanceObserver((l)=>{for(const e of l.getEntries())window.__m.tasks.push([e.startTime,e.duration])}).observe({type:'longtask',buffered:true})}catch(e){}` });
    await send('Page.navigate', { url: address });
    await new Promise((r) => setTimeout(r, 1000));
    for (let i = 0; i < 150; i++) { const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }); if (r.result.result.value === 'complete') break; await new Promise((r2) => setTimeout(r2, 200)); }
    await new Promise((r) => setTimeout(r, 3000));
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({m:window.__m,scripts:document.scripts.length,inline:[...document.scripts].filter(s=>!s.src).length})', returnByValue: true });
    const v = JSON.parse(r.result.result.value);
    const tbt = v.m.tasks.filter(([s]) => s >= v.m.fcp).reduce((a, [, dur]) => a + Math.max(0, dur - 50), 0);
    ws.close();
    return { fcp: v.m.fcp, lcp: v.m.lcp, tbt, kb: encoded / 1024, requests: reqs.size, jsFiles: scripts.size, jsKb: [...scripts.values()].reduce((a, b) => a + b, 0) / 1024, scriptTags: v.scripts, inlineScripts: v.inline };
  } finally { proc.kill(); }
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const all = [];
for (let i = 0; i < runs; i++) all.push(await once());
const result = Object.fromEntries(Object.keys(all[0]).map((k) => [k, Math.round(med(all.map((r) => r[k])) * 10) / 10]));
const out = { address, runs, profile: flagv('--profile', '4g'), when: new Date().toISOString(), median: result, all };
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else console.log(`${address}  (${runs} cold runs, ${out.profile}, 4x CPU, median)\n  FCP ${Math.round(result.fcp)} ms   LCP ${Math.round(result.lcp)} ms   TBT ${Math.round(result.tbt)} ms\n  ${result.kb} KB over ${result.requests} requests; JavaScript: ${result.jsFiles} files, ${result.jsKb} KB; <script> tags ${result.scriptTags} (${result.inlineScripts} inline)`);
