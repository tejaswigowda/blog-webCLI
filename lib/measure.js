// Theming by measurement. What a page *looks like* (the colours a reader sees, the nearest of five type stacks, the width of the text, whether
// the posts are cards) is a fact about a rendered page, and it can be read off any page. It becomes a `customize` block: a closed grammar
// of colours, one of five font stacks, a width, a size and a list layout, which cannot carry a stylesheet.
//
// THE RULE (docs/theming-rules.md): measuring and extracting are different acts.
//   Measuring reads computed values off a rendered page and may be pointed at any site.
//   Extracting lifts declarations or downloads font files. That is a derivative work, so it stays directory-only, where GPL compatibility
//   *including assets* is a listing requirement (cli/wp-import.js). Nothing in the measuring path reads a stylesheet, a font file or the
//   page's text, and nothing it writes can hold CSS: `css` is not an output field, and assertMeasured refuses it.
// A measured typeface is classified into the nearest of the five stacks; it will not match the reference's webfont. The grammar forces that.
import { validateCustomize } from './customize.js';

// The only fields a measurement may write. Not `css` (16,000 characters of anything), and not the links and logos (those are content).
export const MEASURED_FIELDS = Object.freeze(['colors', 'font', 'headingFont', 'width', 'fontSize', 'list']);
export const MEASURE_UA = 'blog-webcli-measure/0.5 (+https://github.com/tejaswigowda/blog-webCLI)';
const AGENT_TOKEN = 'blog-webcli-measure';

export function assertMeasured(customize) {
  if (!customize || typeof customize !== 'object' || Array.isArray(customize)) throw new Error('a measured look is an object');
  for (const k of Object.keys(customize)) {
    if (!MEASURED_FIELDS.includes(k)) throw new Error(k === 'css' ? 'a measured look never carries css' : `a measured look has only ${MEASURED_FIELDS.join(', ')}; "${k}" is not one`);
  }
  validateCustomize(customize);
  return customize;
}

// What someone pastes into the Theme screen (or reads from `node cli/measure.mjs`): a customize block, or { customize } around one.
export function lookFromText(text) {
  let v;
  try { v = JSON.parse(text); } catch { throw new Error('that is not JSON; paste what `node cli/measure.mjs <address>` printed'); }
  const look = v && typeof v === 'object' && !Array.isArray(v) && v.customize && typeof v.customize === 'object' ? v.customize : v;
  return assertMeasured(look);
}

// ---------- fonts: the nearest of the five stacks ----------
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

// ---------- colour ----------
const HEX = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// measured values -> a customize block of only MEASURED_FIELDS. m: { bg, text, link, muted: {r,g,b}, font, headingFont, size, width, cards }
export function customizeFromMeasure(m) {
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
  return assertMeasured(customize);
}

// ---------- robots.txt (RFC 9309) ----------
// Does robots.txt allow `agent` to fetch `path`? The group for our token wins over `*`; the longest matching rule wins; Allow wins a tie.
export function robotsAllows(text, path = '/', agent = AGENT_TOKEN) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', pattern: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
  const matches = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`).test(path);
  let best = null;
  for (const r of rules) {
    if (!matches(r.pattern)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

