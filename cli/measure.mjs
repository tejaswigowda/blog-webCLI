#!/usr/bin/env node
// Make a blog look like an existing site by MEASURING it: open one page in headless Chrome, read the computed colours, type, width and list
// layout a reader sees, and print a `customize` block (colours, one of five font stacks, width, size, list layout). Never a stylesheet.
//
//   node cli/measure.mjs <address> [--out look.json]
//
// The primary case is your own old site. Pointed at someone else's, it is still one page load, it identifies itself (blog-webcli-measure,
// with this repository's address), and it obeys robots.txt: a site that disallows it is not measured. It reads values the browser computed
// for what is on screen. It does not read stylesheets, fonts or the page's text, and it writes nothing that can hold CSS. That is the line
// between measuring and extracting (docs/theming-rules.md); extracting stays directory-only.
//
// The typeface will not match: a webfont measures to the nearest of five system stacks (serif, sans, humanist, slab, mono) and renders in it.
import { promises as fs } from 'node:fs';
import { launch, openPage } from '../test/e2e/cdp.mjs';
import { MEASURE_UA, customizeFromMeasure, robotsAllows } from '../lib/measure.js';

// Evaluated in the page. Only getComputedStyle and element boxes; nothing here reads a stylesheet or the text of the page.
const MEASURE_LOOK = `(async () => {
  const toRgb = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const solid = (c) => { const v = toRgb(c); return v && v.a > 0.5 ? v : null; };
  const effectiveBg = (el) => { for (let e = el; e; e = e.parentElement) { const v = solid(getComputedStyle(e).backgroundColor); if (v) return v; } return { r: 255, g: 255, b: 255 }; };
  const q = (sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const first = (...sels) => { for (const s of sels) { const e = q(s)[0]; if (e) return e; } return null; };
  await new Promise((r) => setTimeout(r, 1500));
  const body = document.body;
  const main = first('main', 'article', '#primary', '#content', '.site-content') || body;
  const para = first('main p', 'article p', '#primary p', 'p') || body;
  const link = first('main h2 a', 'article h2 a', 'article a', 'main a', 'a') || body;
  const meta = first('time', '.meta', '.entry-meta', 'article small', 'small') || para;
  const heading = first('main h1', 'main h2', 'article h1', 'h1', 'h2') || para;
  const arts = q('main article, article, .post').slice(0, 6);
  const tops = arts.map((a) => Math.round(a.getBoundingClientRect().top));
  const cards = arts.length >= 2 && tops.filter((t) => t === tops[0]).length >= 2;
  // the brand colour: what the biggest visible buttons and links are filled with, if it is a colour and not a grey
  const sat = (c) => { const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return mx ? (mx - mn) / mx : 0; };
  const weight = new Map();
  for (const e of q('a, button, [role=button], input[type=submit]')) {
    const r = e.getBoundingClientRect();
    if (r.top > 1000 || r.width < 40 || r.height < 20) continue;
    const cs = getComputedStyle(e);
    const fill = solid(cs.backgroundColor);
    if (!fill || sat(fill) < 0.35) continue;
    const key = [fill.r, fill.g, fill.b].map(Math.round).join(',');
    weight.set(key, (weight.get(key) || 0) + r.width * r.height);
  }
  const top = [...weight].sort((a, b) => b[1] - a[1])[0];
  const accent = top ? (([r, g, b]) => ({ r, g, b }))(top[0].split(',').map(Number)) : null;
  const mw = main.getBoundingClientRect();
  const aw = (arts[0] || para).getBoundingClientRect();
  return JSON.stringify({
    accent, bg: effectiveBg(main), text: toRgb(getComputedStyle(para).color), link: toRgb(getComputedStyle(link).color), muted: toRgb(getComputedStyle(meta).color),
    font: getComputedStyle(para).fontFamily, headingFont: getComputedStyle(heading).fontFamily, size: parseFloat(getComputedStyle(para).fontSize),
    width: Math.round(cards ? mw.width : Math.min(mw.width, aw.width > 300 ? aw.width : mw.width)), cards,
  });
})()`;

async function allowedByRobots(u) {
  let r;
  try { r = await fetch(new URL('/robots.txt', u), { headers: { 'user-agent': MEASURE_UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) }); } catch { return { ok: true, why: 'robots.txt could not be fetched' }; }
  if (r.status >= 500) return { ok: false, why: `robots.txt answered ${r.status}; read as "do not fetch" (RFC 9309)` };
  if (r.status >= 400) return { ok: true, why: `no robots.txt (${r.status})` };
  const text = (await r.text()).slice(0, 500_000);
  const ok = robotsAllows(text, u.pathname + u.search);
  return { ok, why: ok ? 'allowed by robots.txt' : 'robots.txt disallows this address for this tool' };
}

async function main() {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const address = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!address) throw new Error('usage: node cli/measure.mjs <address> [--out look.json]');
  const u = new URL(address);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the address must be http or https');
  const robots = await allowedByRobots(u);
  if (!robots.ok) { console.error(`not measured: ${robots.why}`); process.exit(3); }
  const chrome = await launch();
  try {
    const page = await openPage(chrome, 'about:blank');
    await page.send('Emulation.setUserAgentOverride', { userAgent: MEASURE_UA });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); // the default look, not the dark variant
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: u.href });
    for (let i = 0; i < 100 && (await page.evaluate('document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 200));
    const raw = await page.evaluate(MEASURE_LOOK);
    page.close();
    const customize = customizeFromMeasure(JSON.parse(raw));
    const text = JSON.stringify(customize, null, 2) + '\n';
    if (out) await fs.writeFile(out, text);
    else process.stdout.write(text);
    console.error(`measured ${u.origin}${u.pathname}: ${robots.why}. The typeface is the nearest of five system stacks (${customize.font}); it will not match the original.`);
  } finally { chrome.close(); }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
