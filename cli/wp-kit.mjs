#!/usr/bin/env node
// Derive each imported WordPress theme's bootstrap kit from the theme as WordPress draws it: its demo page (wp-themes.com/<slug>/) is
// opened in headless Chrome and measured: the page and text colours, the link and muted colours, the fonts, the width of the content, the
// list layout, a header picture (and where it came from), and the heading and text of the demo's hero. What it finds becomes `kit` in
// theme.json (see lib/theme-pack.js checkKit): the settings, a short home page and a header picture with its credit.
//
//   node cli/wp-kit.mjs <themes-repo> [slug …]       (needs Chrome; reads <themes-repo>/wp/<slug>/theme.json and writes it back)
//
// A header picture is the theme's own file when the demo uses one from the theme; otherwise one from <themes-repo>/kit-images/ (photographs
// from Unsplash, each with its photographer in credits.json), chosen by theme so the same theme always gets the same one.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launch, openPage } from '../test/e2e/cdp.mjs';
import { FONTS, validateCustomize } from '../lib/customize.js';
import { validateThemeManifest } from '../lib/theme-pack.js';

const HEX = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// evaluated in the demo page
const MEASURE = `(async () => {
  const toRgb = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const solid = (c) => { const v = toRgb(c); return v && v.a > 0.5 ? v : null; };
  const effectiveBg = (el) => { for (let e = el; e; e = e.parentElement) { const v = solid(getComputedStyle(e).backgroundColor); if (v) return v; } return { r: 255, g: 255, b: 255 }; };
  const q = (sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const first = (...sels) => { for (const s of sels) { const e = q(s)[0]; if (e) return e; } return null; };
  await new Promise((r) => setTimeout(r, 1500));
  const body = document.body;
  const main = first('main', '#primary', '#content', '.site-content') || body;
  const para = first('main p', '.entry-content p', 'article p', '#primary p', 'p') || body;
  const link = first('main .entry-title a', 'article h2 a', 'article a', 'main a', '.entry-title a', 'a') || body;
  const meta = first('.entry-meta', 'time', '.posted-on', '.meta', 'article small') || para;
  const heading = first('main h1', 'main h2', '.entry-title', 'h1', 'h2') || para;
  const bg = effectiveBg(main);
  const arts = q('main article, article.post, article.hentry, .post').slice(0, 6);
  const tops = arts.map((a) => Math.round(a.getBoundingClientRect().top));
  const cards = arts.length >= 2 && tops.filter((t) => t === tops[0]).length >= 2;
  // a header picture: the largest wide image or background picture near the top that is not a logo
  let hero = null;
  const wide = innerWidth * 0.55;
  for (const e of q('img, header, section, div, figure')) {
    const r = e.getBoundingClientRect();
    if (r.top > 900 || r.width < wide || r.height < 200) continue;
    let url = null;
    if (e.tagName === 'IMG') url = e.currentSrc || e.src;
    else { const bi = getComputedStyle(e).backgroundImage; const m = /url\\(["']?([^"')]+)["']?\\)/.exec(bi); if (m) url = m[1]; }
    if (!url || /^data:/.test(url) || /logo|avatar|gravatar/i.test(url)) continue;
    const area = r.width * r.height;
    if (!hero || area > hero.area) hero = { url, area, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
  }
  // the demo's hero text: the first heading and paragraph near the top, if there is a hero
  let hero_text = null;
  if (hero) {
    const hs = q('h1, h2').filter((e) => e.getBoundingClientRect().top < 900 && e.textContent.trim().length > 2 && e.textContent.trim().length < 90);
    const h = hs[0];
    if (h) { const p = [...document.querySelectorAll('p')].find((x) => h.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING && x.textContent.trim().length > 20 && x.textContent.trim().length < 240); hero_text = { heading: h.textContent.trim(), text: p ? p.textContent.trim() : '' }; }
  }
  const mw = main.getBoundingClientRect();
  const art = arts[0] || para;
  const aw = art.getBoundingClientRect();
  return JSON.stringify({
    bg, text: toRgb(getComputedStyle(para).color), link: toRgb(getComputedStyle(link).color), muted: toRgb(getComputedStyle(meta).color),
    font: getComputedStyle(para).fontFamily, headingFont: getComputedStyle(heading).fontFamily, size: parseFloat(getComputedStyle(para).fontSize),
    width: Math.round(cards ? mw.width : Math.min(mw.width, aw.width > 300 ? aw.width : mw.width)), viewport: innerWidth, cards, hero, hero_text,
  });
})()`;

const SERIF = /georgia|times|playfair|merriweather|lora|garamond|cambria|baskerville|source serif|libre|crimson|pt serif|noto serif|spectral|cormorant|bitter|dm serif|(^|[ ,"'])serif/;
const SLAB = /roboto slab|rockwell|arvo|zilla|slab|museo/;
const MONO = /mono|courier|consolas|menlo|fira code/;
const HUMANIST = /seravek|gill sans|ubuntu|calibri|candara|source sans|nunito|fira sans/;
export function fontKey(family) {
  const f = String(family || '').toLowerCase();
  if (MONO.test(f)) return 'mono';
  if (SLAB.test(f)) return 'slab';
  const first = f.split(',')[0];
  if (SERIF.test(first) && !/sans/.test(first)) return 'serif';
  if (HUMANIST.test(first)) return 'humanist';
  return 'sans';
}

const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// measured -> { customize, hero? (the demo's picture: url, size, text) }
export function kitFromMeasure(m) {
  const bg = m.bg || { r: 255, g: 255, b: 255 };
  let text = m.text || { r: 26, g: 26, b: 26 };
  if (contrast(text, bg) < 4.5) text = lum(bg) > 0.4 ? { r: 26, g: 26, b: 26 } : { r: 236, g: 238, b: 241 };
  let link = m.link || text;
  if (contrast(link, bg) < 3) link = text;
  let muted = m.muted || text;
  if (contrast(muted, bg) < 3) muted = { r: (text.r + bg.r) / 2, g: (text.g + bg.g) / 2, b: (text.b + bg.b) / 2 };
  const font = fontKey(m.font);
  const headingFont = fontKey(m.headingFont);
  const width = Math.max(400, Math.min(1280, Math.round((m.width || 720) / 10) * 10));
  const customize = {
    colors: { accent: HEX(link.r, link.g, link.b), text: HEX(text.r, text.g, text.b), background: HEX(bg.r, bg.g, bg.b), muted: HEX(muted.r, muted.g, muted.b) },
    font,
    ...(headingFont !== font ? { headingFont } : {}),
    width: `${width}px`,
    ...(m.size >= 14 && m.size <= 24 ? { fontSize: `${Math.round(m.size)}px` } : {}),
    list: { layout: m.cards ? 'cards' : 'list' },
  };
  validateCustomize(customize);
  return customize;
}

const plainText = (s, max) => String(s || '').replace(/[<>\r\n*_`~#\[\]\\|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); // text a markdown page keeps as it is

async function main() {
  const [repo, ...only] = process.argv.slice(2);
  if (!repo) throw new Error('usage: node cli/wp-kit.mjs <themes-repo> [slug …]');
  const wp = path.join(repo, 'wp');
  const pool = [];
  try {
    const credits = JSON.parse(await fs.readFile(path.join(repo, 'kit-images', 'credits.json'), 'utf8'));
    for (const [file, c] of Object.entries(credits)) pool.push({ file, credit: c });
  } catch {
    /* no pictures: a theme whose demo has a header picture gets none */
  }
  const chrome = await launch();
  const report = [];
  try {
    for (const slug of (await fs.readdir(wp)).filter((n) => !n.includes('.')).sort()) {
      if (only.length && !only.includes(slug)) continue;
      const dir = path.join(wp, slug);
      const manifestFile = path.join(dir, 'theme.json');
      const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
      let m;
      try {
        const pageHandle = await openPage(chrome, `https://wp-themes.com/${slug}/`);
        await new Promise((r) => setTimeout(r, 6000)); // the demo page and its stylesheets
        const ans = await pageHandle.send('Runtime.evaluate', { expression: MEASURE, awaitPromise: true, returnByValue: true });
        pageHandle.close();
        if (!ans.result || !ans.result.result || typeof ans.result.result.value !== 'string') throw new Error(JSON.stringify(ans).slice(0, 150));
        m = JSON.parse(ans.result.result.value);
      } catch (e) {
        report.push(`${slug}: could not be measured (${String(e.message).slice(0, 80)})`);
        continue;
      }
      const customize = kitFromMeasure(m);
      const kit = { customize };
      let heroNote = 'no header picture';
      if (m.hero) {
        // the picture is the theme's own when the demo uses one of its files; otherwise a credited photograph
        const own = new RegExp(`/wp-content/themes/${slug}/(.+?)(?:\\?.*)?$`).exec(m.hero.url);
        let chosen = null;
        if (own && /\.(jpe?g|png|webp)$/i.test(own[1])) {
          // a theme's own picture would need its attribution too: not used, the pool is
        }
        if (pool.length) {
          const pick = pool[crypto.createHash('sha256').update(slug).digest()[0] % pool.length];
          chosen = pick;
        }
        if (chosen) {
          await fs.mkdir(path.join(dir, 'kit'), { recursive: true });
          await fs.copyFile(path.join(repo, 'kit-images', chosen.file), path.join(dir, 'kit', 'hero.jpg'));
          manifest.assets = [...new Set([...(manifest.assets || []), 'kit/hero.jpg'])].sort();
          kit.hero = { image: 'kit/hero.jpg', alt: chosen.credit.alt || 'A photograph', credit: { name: chosen.credit.name, profile: chosen.credit.profile, source: chosen.credit.source } };
          heroNote = `header picture ${chosen.file} by ${chosen.credit.name}`;
        } else heroNote = 'the demo has a header picture; none in kit-images/';
        if (m.hero_text && m.hero_text.heading) kit.home = `## ${plainText(m.hero_text.heading, 80)}\n\n${plainText(m.hero_text.text, 240) || 'Welcome. The latest posts are below.'}`;
      }
      if (!kit.home) kit.home = 'Welcome. The latest posts are below.';
      manifest.kit = kit;
      validateThemeManifest(manifest);
      await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
      report.push(`${slug}: ${customize.font}/${customize.headingFont || customize.font} ${customize.colors.background} on ${customize.colors.text}, accent ${customize.colors.accent}, ${customize.width}, ${customize.list.layout}; ${heroNote}`);
    }
  } finally {
    chrome.close();
  }
  console.log(report.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message || e); process.exit(1); });
