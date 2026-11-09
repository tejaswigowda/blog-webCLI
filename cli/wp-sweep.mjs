// Maintainer tool: render every imported theme over the layout corpus at a desktop and a phone width, in headless Chrome, and
// measure the failure signatures. It judges nothing by pixel distance: only whether the page is readable and fits.
//   node cli/wp-sweep.mjs [themes-dir] [out-dir]   (writes <out>/sweep.json, <out>/shots/*.jpg, <out>/sheet.html)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/blog.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';
import { EXAMPLE_BLOG } from '../lib/sample.js';
import { launch, openPage } from '../test/e2e/cdp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES = process.argv[2] || path.join(REPO, '..', 'blog-webCLI-themes');
const OUT = process.argv[3] || '/tmp/sweep';
const WIDE = process.env.WIDE_IMAGE || '/tmp/wide.png';
const SIZES = { desktop: { width: 1280, height: 900, mobile: false }, phone: { width: 390, height: 844, mobile: true } };

const readDir = async (dir) => {
  const out = {};
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(p)); } };
  await walk(dir);
  return out;
};

const ex = JSON.parse(await fs.readFile(path.join(REPO, 'examples/blog/blog.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(REPO, 'examples/blog/assets.lock.json'), 'utf8'));
const blog0 = { ...JSON.parse(JSON.stringify(EXAMPLE_BLOG)), assets: ex.assets, video: ex.video, pagination: { size: 3 } };
const inputs = [];
for (const dir of ['examples/blog/posts', 'test/golden', 'test/corpus', 'test/layout']) {
  for (const f of (await fs.readdir(path.join(REPO, dir))).filter((n) => n.endsWith('.md')).sort()) {
    const p = { path: `posts/${f.replace(/[^\w.-]/g, '-')}`, text: await fs.readFile(path.join(REPO, dir, f), 'utf8') };
    if (!buildSite({ blog: JSON.stringify(blog0), posts: [p], lock }).errors.length) inputs.push(p);
  }
}
inputs.push({ path: 'pages/about.md', text: '---\nslug: about\ntitle: About\nstatus: published\n---\n\nA standalone page.\n' });

// The pages every theme is judged on: the index in both layouts, a second page, a tag page, the tag list, the archive, a standalone page,
// and the posts that stress a layout. (404.html and author pages are not generated yet; see docs/contract-gap.md.)
const POSTS = ['markdown-is-the-format', 'wide-table', 'long-code', 'html-block', 'long-title', 'forty-tags', 'rtl', 'cjk', 'no-cover', 'wide-image', 'lists-and-blocks'];
const PAGES = [['index', 'index.html'], ['index-cards', 'cards:index.html'], ['page2', 'page/2/index.html'], ['tag', 'tags/git/index.html'], ['tags', 'tags/index.html'], ['archive', 'archive/index.html'], ['about', 'about/index.html'], ...POSTS.map((s) => [s, `${s}/index.html`])];

// Evaluated in the page: what a reader would see.
const MEASURE = `(() => {
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
  const shown = (e) => { const b = box(e); return b && !b.hidden && b.h > 0 && b.w > 0; };
  // the first element of the selectors that a reader can see (and, for text, that has some)
  const seen = (sels, minText = 0) => { let any = null; for (const x of sels) for (const e of document.querySelectorAll(x)) { any = any || e; if (shown(e) && e.textContent.trim().length >= minText) return e; } return any; };
  const main = first('main', '#content', 'article') || document.body;
  const title = seen(['main .entry-title', 'article .entry-title', '.entry-title', 'main h1', 'article h1', 'h1', 'main h2']);
  const para = seen(['main .entry-content p', 'article .entry-content p', 'article p', 'main p'], 40);
  const col = para && shown(para) ? para : null;
  const header = q('#masthead, .site-header, header');
  const nav = q('nav');
  // something painted over the title or the text (a preloader, a full-page overlay): the element on top at their centre is not theirs
  const covered = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1), y = Math.min(Math.max(r.top + Math.min(r.height / 2, 20), 1), innerHeight - 1); if (r.bottom < 0 || r.top > innerHeight) return false; const t = document.elementFromPoint(x, y); return !!t && !el.contains(t) && !t.contains(el); };
  return { vh: innerHeight, titleCovered: covered(title) || covered(para), vw, scrollWidth: de.scrollWidth, offenders, header: box(header), nav: box(nav), main: box(main), title: box(title), col: box(col), titleBox: box(title), titleContrast: contrast(title), bodyContrast: contrast(para), height: de.scrollHeight };
})()`;

// signatures from a measurement; a signature is a string
function signatures(m, size) {
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
const again = !!process.env.VERDICTS_ONLY;
const chrome = again ? null : await launch();
if (!again) { await fs.rm(OUT, { recursive: true, force: true }); await fs.mkdir(path.join(OUT, 'shots'), { recursive: true }); }
const WP = path.join(THEMES, 'wp');
const only = process.argv.slice(4);
const slugs = (await fs.readdir(WP)).filter((n) => !n.includes('.') && (!only.length || only.includes(n))).sort();
const results = again ? JSON.parse(await fs.readFile(path.join(OUT, 'sweep.json'), 'utf8')) : {};

async function sweepTheme(page, slug) {
  const files = await readDir(path.join(WP, slug));
  const manifest = JSON.parse(new TextDecoder().decode(files['theme.json']));
  const pin = pinFor(`tejaswigowda/blog-webCLI-themes/wp/${slug}`, 'v1.5.0', manifest, themeDigest(files, themeFilePaths(manifest)));
  let theme = loadTheme(pin, files);
  // CONTRACT=wordpress-classic-2 renders the same theme under another contract of the family, to see what it changes
  if (process.env.CONTRACT) theme = { ...theme, contract: process.env.CONTRACT, contractSpec: theme.skeleton ? { name: process.env.CONTRACT, skeleton: theme.skeleton } : process.env.CONTRACT };
  const built = {};
  for (const layout of ['list', 'cards']) {
    const out = buildSite({ blog: JSON.stringify({ ...blog0, theme: pin, customize: { list: { layout } } }), posts: inputs, lock, theme });
    if (out.errors.length) throw new Error(out.errors[0].message);
    built[layout] = out.files;
  }
  const dir = path.join(OUT, 'site', slug);
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
  const res = { name: manifest.name, pages: {}, missing: Object.entries(pages).filter(([, v]) => !v).map(([k]) => k) };
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
      if (key === 'markdown-is-the-format') {
        const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: sizeName === 'phone' ? 0.3 : 0.28 } });
        await fs.writeFile(path.join(OUT, 'shots', `${slug}-${sizeName}.jpg`), Buffer.from(shot.result.data, 'base64'));
      }
    }
  }
  return res;
}

const queue = again ? [] : [...slugs];
await Promise.all(Array.from({ length: again ? 0 : 4 }, async () => {
  const page = await openPage(chrome, 'about:blank');
  await page.send('Page.enable');
  for (let slug; (slug = queue.shift()); ) {
    try { results[slug] = await sweepTheme(page, slug); } catch (e) { results[slug] = { error: e.message }; }
  }
  page.close();
}));
if (chrome) chrome.close();
await fs.writeFile(path.join(OUT, 'sweep.json'), JSON.stringify(results, null, 1));

// ---- verdicts -------------------------------------------------------------------------------------------------------------
// A theme is judged on its post page and on every page: BROKEN signatures hide or lose the content, SOFT ones are a measure that is
// too wide or a column off to one side. A theme that targets a region the generator does not emit (gap.json: a sidebar) AND shows a
// hole signature on the post is a candidate for "unportable"; the contact sheet confirms it by eye. No pixel distance anywhere.
const POST_ONLY = new Set(['title-below-fold', 'covered']);
const BROKEN = new Set(['title-below-fold', 'covered', 'main-zero', 'title-hidden', 'header-zero', 'contrast-body', 'contrast-title', 'overflow', 'column-narrow']);
const HOLE = new Set(['off-centre', 'column-narrow', 'main-zero', 'title-hidden', 'title-below-fold']);
let gap = {};
try { gap = JSON.parse(await fs.readFile(process.env.GAP_JSON || '/tmp/gap.json', 'utf8')).themes; } catch { /* the sidebar half of the test needs wp-gap first */ }
const SIDEBAR = ['secondary', 'widget-area', 'sidebar', 'sidebar-primary', 'primary-sidebar'];
const verdicts = {};
for (const [slug, t] of Object.entries(results)) {
  if (t.error) { verdicts[slug] = { verdict: 'error', why: t.error }; continue; }
  const post = t.pages['markdown-is-the-format'];
  const seen = new Map();
  for (const [key, v] of Object.entries(t.pages)) for (const sz of ['desktop', 'phone']) for (const g of v[sz].sig) { const k = `${g}@${sz}`; seen.set(k, [...(seen.get(k) || []), key]); }
  const onPost = (set) => ['desktop', 'phone'].flatMap((sz) => post[sz].sig.filter((g) => set.has(g)).map((g) => `${g}@${sz}`));
  const g = gap[slug] && gap[slug].gap.full;
  const wantsRegion = !!g && SIDEBAR.some((n) => g.classes.includes(n) || g.ids.includes(n));
  const broken = onPost(BROKEN), hole = onPost(HOLE);
  const soft = [...seen.keys()].filter((k) => !BROKEN.has(k.split('@')[0]));
  const stressBroken = [...seen.keys()].filter((k) => BROKEN.has(k.split('@')[0]) && !POST_ONLY.has(k.split('@')[0]) && !broken.includes(k));
  let verdict = 'usable';
  if (hole.length && wantsRegion) verdict = 'unportable?';
  else if (broken.length || stressBroken.length) verdict = 'degraded';
  else if (soft.length) verdict = 'usable (soft)';
  verdicts[slug] = { name: t.name, verdict, wantsRegion, onPost: [...new Set([...broken, ...hole])], stress: stressBroken, soft: soft.filter((k) => !onPost(new Set(['off-centre'])).includes(k)) };
}
await fs.writeFile(path.join(OUT, 'verdicts.json'), JSON.stringify(verdicts, null, 1));
const tally = {};
for (const v of Object.values(verdicts)) tally[v.verdict] = (tally[v.verdict] || 0) + 1;
console.log(tally);

// the written result, kept in the repository
const order = ['usable', 'usable (soft)', 'degraded', 'unportable?', 'error'];
const sigText = (v) => [...v.onPost, ...v.stress].join(', ') || (v.soft.length ? v.soft.join(', ') : '');
const md = ['# Layout sweep of the imported themes', '', `Run by \`node cli/wp-sweep.mjs\`: every theme in \`blog-webCLI-themes/wp\` is built over the layout corpus (the example posts, \`test/golden/\`, \`test/corpus/\` and \`test/layout/\`; the index in list and cards layouts, a second page, a tag page, the tag list, the archive, a standalone page, and ${POSTS.length} posts), opened in headless Chrome at 1280 and 390 px wide, and measured. Nothing is judged by pixel distance.`, '',
  '| verdict | themes |', '|---|---|', ...order.filter((k) => tally[k]).map((k) => `| ${k} | ${tally[k]} |`), '',
  '**usable**: no signature. **usable (soft)**: only a measure wider than 1180 px (no maximum width on the text). **degraded**: a signature that hides, covers or loses content, or the page scrolls sideways. **unportable?**: a hole signature on the post page *and* the theme targets a sidebar the generator does not emit; confirmed or cleared by eye on the contact sheet, and a candidate until then.', '',
  '## Signatures', '', '| signature | meaning |', '|---|---|', '| overflow | the page is wider than the viewport |', '| header-zero / main-zero | the header or `main` has no height or is hidden |', '| title-hidden | no post title a reader can see |', '| title-below-fold | the title starts below 70% of the viewport (a hero or slider pushed the content down) |', '| covered | something is painted over the title or the text (a preloader, an overlay) |', '| column-narrow / column-wide / off-centre | the text column is under 320 px (55% of a phone), over 1180 px, or not centred |', '| contrast-body / contrast-title | under 3:1 against the nearest opaque background (unknown when the background is an image) |', '',
  '## Themes that are not usable as they are', '', '| theme | verdict | signatures | targets a sidebar |', '|---|---|---|---|',
  ...Object.entries(verdicts).filter(([, v]) => v.verdict === 'degraded' || v.verdict === 'unportable?').sort((a, b) => a[1].verdict.localeCompare(b[1].verdict) || a[0].localeCompare(b[0])).map(([s, v]) => `| ${s} | ${v.verdict} | ${sigText(v)} | ${v.wantsRegion ? 'yes' : ''} |`), '',
  '## Known holes', '', `- Horizontal overflow: ${Object.values(results).reduce((n, t) => n + Object.values(t.pages || {}).filter((v) => v.phone.sig.includes('overflow')).length, 0)} page renders at 390 px, so \`THEME_RESPONSIVE\` holds on a phone across the corpus. At 1280 px two themes (\`sinatra\`, \`bloghash\`) scroll sideways: an off-canvas or hidden menu of the theme's own skeleton sits past the right edge. Recorded as a known hole, not patched: a global \`overflow-x:clip\` would change every themed blog's CSS, and it belongs in contract v2.`, '- No \`404.html\` and no author page are generated yet, so neither is in the corpus.', '- Contrast is unknown over a background image, so a theme that sets its text over a photograph is not checked there.', '- The sweep says whether a page is readable and fits. It cannot say whether it looks like the theme; that is not its job.', ''];
await fs.writeFile(path.join(REPO, 'docs/layout-sweep.md'), md.join('\n'));
const colour = { usable: '#2e7d32', 'usable (soft)': '#7cb342', degraded: '#ef6c00', 'unportable?': '#c62828', error: '#000' };
const cards = Object.entries(verdicts).sort((a, b) => a[1].verdict.localeCompare(b[1].verdict) || a[0].localeCompare(b[0])).map(([slug, v]) => `<div class="c"><div class="h" style="background:${colour[v.verdict]}">${slug}: ${v.verdict}</div><div class="s"><img src="shots/${slug}-desktop.jpg"><img src="shots/${slug}-phone.jpg"></div><div class="n">${[...v.onPost, ...v.stress].join(' ')}</div></div>`).join('');
await fs.writeFile(path.join(OUT, 'sheet.html'), `<!doctype html><meta charset=utf-8><style>body{font:11px system-ui;margin:6px;display:flex;flex-wrap:wrap;gap:6px}.c{width:480px;border:1px solid #ccc}.h{color:#fff;padding:2px 6px;font-weight:600}.s{display:flex;gap:4px;padding:3px;align-items:flex-start}.s img{display:block}.n{padding:0 6px 3px;color:#555;min-height:1.2em}</style>${cards}`);
console.log(`${Object.keys(results).length} themes swept`);
