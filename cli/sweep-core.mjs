// The measuring half of the layout sweep, shared by cli/wp-sweep.mjs (every imported theme) and cli/theme-check.mjs (one theme, as
// accepted or not): the corpus, the pages a theme is judged on, what is measured in them, the signatures, and the verdict.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/blog.js';
import { EXAMPLE_BLOG } from '../lib/sample.js';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
import zlib from 'node:zlib';
import os from 'node:os';
export const WIDE = process.env.WIDE_IMAGE || path.join(os.tmpdir(), 'blog-webcli-wide.png');

// the picture a post's remote images are swapped for, wider than any column (2400x600): written once, so the sweep needs nothing else on disk
export async function ensureWide() {
  try { await fs.access(WIDE); return; } catch { /* make it */ }
  const w = 2400, h = 600;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = 200; row[2 + x * 3] = 120; row[3 + x * 3] = 40; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  await fs.writeFile(WIDE, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Themes whose verdict got worse than the baseline's. A verdict has a rank: usable and usable (soft) are both fine, degraded is worse,
// unportable? worse still, an error the worst. It is the change that fails, not the count: a theme that was already degraded is not news.
export const VERDICT_RANK = Object.freeze({ usable: 0, 'usable (soft)': 0, degraded: 1, 'unportable?': 2, error: 3 });
export function regressions(baseline, verdicts) {
  const out = [];
  for (const [slug, now] of Object.entries(verdicts)) {
    const before = baseline[slug];
    if (before === undefined) continue; // a theme added since: no baseline to regress from
    if ((VERDICT_RANK[now] ?? 3) > (VERDICT_RANK[before] ?? 3)) out.push({ slug, before, now });
  }
  return out;
}
export const SIZES = { desktop: { width: 1280, height: 900, mobile: false }, phone: { width: 390, height: 844, mobile: true } };

export const readDir = async (dir) => {
  const out = {};
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(p)); } };
  await walk(dir);
  return out;
};

// The corpus: the example posts, the golden and corpus files, the layout stress posts, and a standalone page; whatever the build refuses is left out.
export async function loadCorpus(repo = REPO) {
  await ensureWide();
  const ex = JSON.parse(await fs.readFile(path.join(repo, 'examples/blog/blog.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(repo, 'examples/blog/assets.lock.json'), 'utf8'));
  const blog0 = { ...JSON.parse(JSON.stringify(EXAMPLE_BLOG)), assets: ex.assets, video: ex.video, pagination: { size: 3 } };
  const inputs = [];
  for (const dir of ['examples/blog/posts', 'test/golden', 'test/corpus', 'test/layout']) {
    for (const f of (await fs.readdir(path.join(repo, dir))).filter((n) => n.endsWith('.md')).sort()) {
      const p = { path: `posts/${f.replace(/[^\w.-]/g, '-')}`, text: await fs.readFile(path.join(repo, dir, f), 'utf8') };
      if (!buildSite({ blog: JSON.stringify(blog0), posts: [p], lock }).errors.length) inputs.push(p);
    }
  }
  inputs.push({ path: 'pages/about.md', text: '---\nslug: about\ntitle: About\nstatus: published\n---\n\nA standalone page.\n' });
  return { blog0, lock, inputs };
}

// The pages every theme is judged on: the index in both layouts, a second page, a tag page, the tag list, the archive, a standalone page,
// and the posts that stress a layout. (404.html and author pages are not generated yet; see docs/contract-gap.md.)
export const POSTS = ['markdown-is-the-format', 'wide-table', 'long-code', 'html-block', 'long-title', 'forty-tags', 'rtl', 'cjk', 'no-cover', 'wide-image', 'lists-and-blocks'];
export const PAGES = [['index', 'index.html'], ['index-cards', 'cards:index.html'], ['page2', 'page/2/index.html'], ['tag', 'tags/git/index.html'], ['tags', 'tags/index.html'], ['archive', 'archive/index.html'], ['about', 'about/index.html'], ...POSTS.map((s) => [s, `${s}/index.html`])];


// Evaluated in the page: what a reader would see.
export const MEASURE = `(() => {
  const vw = innerWidth, de = document.documentElement;
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return { t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right), hidden: cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 }; };
  const num = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage !== 'none') return null; const c = num(cs.backgroundColor); if (c && c.a > .5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const contrast = (el) => { if (!el) return null; const fg = num(getComputedStyle(el).color), bg = bgOf(el); if (!fg || !bg) return null; const a = lum(fg), b = lum(bg); return Math.round(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)) * 10) / 10; };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
  const scrolls = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible') return true; } return false; };
  let offenders = [];
  if (de.scrollWidth > vw + 1) for (const e of document.body.querySelectorAll('*')) { if (offenders.length >= 4) break; const r = e.getBoundingClientRect(); if (r.width && r.right > vw + 1 && !scrolls(e) && getComputedStyle(e).position !== 'fixed') offenders.push(name(e) + ' ' + Math.round(r.right)); }
  const first = (...sels) => { for (const x of sels) { const e = q(x); if (e) return e; } return null; };
  const shown = (e) => { const b = box(e); return b && !b.hidden && b.h > 0 && b.w > 0 && (!e.checkVisibility || e.checkVisibility({ contentVisibilityAuto: true })); }; // not in a closed <details> either
  // the first element of the selectors that a reader can see (and, for text, that has some)
  const seen = (sels, minText = 0) => { let any = null, visible = null; for (const x of sels) for (const e of document.querySelectorAll(x)) { any = any || e; if (!shown(e)) continue; visible = visible || e; if (e.textContent.trim().length >= minText) return e; } return visible || any; };
  const main = first('main', '#content', 'article') || document.body;
  const title = seen(['main .entry-title', 'article .entry-title', '.entry-title', 'main h1', 'article h1', 'h1', 'main h2']);
  const para = seen(['main .entry-content p', 'article .entry-content p', 'article p', 'main p'], 40);
  const col = para && shown(para) ? para : null;
  const header = q('#masthead, .site-header, header');
  const nav = q('nav');
  // something painted over the title or the text (a preloader, a full-page overlay): the element on top at their centre is not theirs
  const covered = (el) => { if (!el || !shown(el)) return false; const r = el.getBoundingClientRect(); const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1), y = Math.min(Math.max(r.top + Math.min(r.height / 2, 20), 1), innerHeight - 1); if (r.bottom < 0 || r.top > innerHeight) return false; const t = document.elementFromPoint(x, y); return !!t && !el.contains(t) && !t.contains(el); };
  return { vh: innerHeight, titleCovered: covered(title) || covered(para), vw, scrollWidth: de.scrollWidth, offenders, header: box(header), nav: box(nav), main: box(main), title: box(title), col: box(col), titleBox: box(title), titleContrast: contrast(title), bodyContrast: contrast(para), height: de.scrollHeight };
})()`;

// signatures from a measurement; a signature is a string
export function signatures(m, size) {
  const s = [];
  const phone = size === 'phone';
  if (m.scrollWidth > m.vw + 1) s.push('overflow');
  if (m.header && (m.header.h === 0 || m.header.hidden)) s.push('header-zero');
  if (!m.main || m.main.h === 0 || m.main.hidden) s.push('main-zero');
  if (!m.title || m.title.h === 0 || m.title.hidden) s.push('title-hidden');
  if (m.col) {
    if (phone ? m.col.w < m.vw * 0.55 : m.col.w < 320) s.push('column-narrow');
    if (!phone && m.col.w > 1180) s.push('column-wide');
    if (!phone && Math.abs((m.col.l + m.col.r) / 2 - m.vw / 2) > m.vw * 0.15) s.push('off-centre');
  }
  if (m.titleBox && !m.titleBox.hidden && m.titleBox.h > 0 && m.titleBox.t > m.vh * 0.7) s.push('title-below-fold');
  if (m.titleCovered) s.push('covered');
  if (m.bodyContrast !== null && m.bodyContrast < 3) s.push('contrast-body');
  if (m.titleContrast !== null && m.titleContrast < 3) s.push('contrast-title');
  return s;
}

// VERDICTS_ONLY=1 re-reads <out>/sweep.json and redoes the verdicts and the contact sheet without rendering anything

// A theme is judged on its post page and on every page: BROKEN signatures hide or lose the content, SOFT ones are a measure that is
// too wide or a column off to one side. A theme that targets a region the generator does not emit AND shows a hole signature on the post
// is a candidate for "unportable"; the contact sheet confirms it by eye. No pixel distance anywhere.
export const POST_ONLY = new Set(['title-below-fold', 'covered']);
export const BROKEN = new Set(['title-below-fold', 'covered', 'main-zero', 'title-hidden', 'header-zero', 'contrast-body', 'contrast-title', 'overflow', 'column-narrow']);
export const HOLE = new Set(['off-centre', 'column-narrow', 'main-zero', 'title-hidden', 'title-below-fold']);

export function verdictOf(t, wantsRegion = false) {
  const post = t.pages['markdown-is-the-format'];
  const seen = new Map();
  for (const [key, v] of Object.entries(t.pages)) for (const sz of ['desktop', 'phone']) for (const g of v[sz].sig) { const k = `${g}@${sz}`; seen.set(k, [...(seen.get(k) || []), key]); }
  const onPost = (set) => ['desktop', 'phone'].flatMap((sz) => post[sz].sig.filter((g) => set.has(g)).map((g) => `${g}@${sz}`));
  const broken = onPost(BROKEN), hole = onPost(HOLE);
  const soft = [...seen.keys()].filter((k) => !BROKEN.has(k.split('@')[0]));
  const stressBroken = [...seen.keys()].filter((k) => BROKEN.has(k.split('@')[0]) && !POST_ONLY.has(k.split('@')[0]) && !broken.includes(k));
  let verdict = 'usable';
  if (hole.length && wantsRegion) verdict = 'unportable?';
  else if (broken.length || stressBroken.length) verdict = 'degraded';
  else if (soft.length) verdict = 'usable (soft)';
  return { name: t.name, verdict, wantsRegion, onPost: [...new Set([...broken, ...hole])], stress: stressBroken, soft: soft.filter((k) => !onPost(new Set(['off-centre'])).includes(k)) };
}

// Build a loaded theme over the corpus (list and cards), write the pages under `dir`, open each at both widths in `page` (a cdp page), measure.
// shots: where to write the post page's two screenshots as <slug>-<size>.jpg (a contact sheet), or null.
export async function renderAndMeasure(page, { slug, name, theme, pin, corpus, dir, shots = null }) {
  const { blog0, lock, inputs } = corpus;
  const built = {};
  for (const layout of ['list', 'cards']) {
    const out = buildSite({ blog: JSON.stringify({ ...blog0, theme: pin, customize: { list: { layout } } }), posts: inputs, lock, theme });
    if (out.errors.length) throw new Error(out.errors[0].message);
    built[layout] = out.files;
  }
  const local = (h) => h.replace(/<img([^>]*?)src="https:\/\/cdn\.jsdelivr\.net[^"]*"/g, `<img$1src="file://${WIDE}"`);
  const pages = {};
  for (const [key, f] of PAGES) {
    const cards = f.startsWith('cards:');
    const rel = cards ? f.slice(6) : f;
    const html = (cards ? built.cards : built.list)[rel];
    if (html === undefined) { pages[key] = null; continue; }
    const file = path.join(dir, `${key}.html`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, local(html));
    pages[key] = file;
  }
  const res = { name, pages: {}, missing: Object.entries(pages).filter(([, v]) => !v).map(([k]) => k) };
  for (const [sizeName, size] of Object.entries(SIZES)) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
    for (const [key, file] of Object.entries(pages)) {
      if (!file) continue;
      await page.send('Page.navigate', { url: `file://${file}` });
      for (let i = 0; i < 50 && (await page.evaluate('document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 700)); // entrance animations settle
      const m = await page.evaluate(MEASURE);
      const sig = signatures(m, sizeName);
      (res.pages[key] ||= {})[sizeName] = { sig, offenders: m.offenders, col: m.col && { w: m.col.w, l: m.col.l }, bodyContrast: m.bodyContrast, titleContrast: m.titleContrast };
      if (shots && key === 'markdown-is-the-format') {
        const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: sizeName === 'phone' ? 0.3 : 0.28 } });
        await fs.writeFile(path.join(shots, `${slug}-${sizeName}.jpg`), Buffer.from(shot.result.data, 'base64'));
      }
    }
  }
  return res;
}

// Every class and id a contract emits over the corpus (list and cards): the vocabulary a theme's CSS can rely on.
export function emittedNames(corpus, contract = 'wordpress-classic-2') {
  const { blog0, lock, inputs } = corpus;
  const pin = { repo: 'a/b', ref: 'v1.0.0', sha256: 'a'.repeat(64), name: 'bare', version: '1', licence: 'MIT', contract };
  const theme = { pin, manifest: {}, contract, contractSpec: contract, skeleton: null, css: '', digest: pin.sha256 };
  const classes = new Set(), ids = new Set();
  for (const layout of ['list', 'cards']) {
    const out = buildSite({ blog: JSON.stringify({ ...blog0, theme: pin, customize: { list: { layout } } }), posts: inputs, lock, theme });
    if (out.errors.length) throw new Error(out.errors[0].message);
    for (const [k, html] of Object.entries(out.files)) {
      if (!k.endsWith('.html')) continue;
      const h = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
      for (const m of h.matchAll(/\sclass\s*=\s*"([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
      for (const m of h.matchAll(/\sid\s*=\s*"([^"]*)"/g)) if (m[1]) ids.add(m[1]);
    }
  }
  return { classes: [...classes].sort(), ids: [...ids].sort() };
}
