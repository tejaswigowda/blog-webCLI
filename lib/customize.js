// blog.json "customize": colours, fonts, size, header, footer, list layout, and a little
// sanitised CSS. Everything is validated against closed sets, so a blog's settings can
// restyle its pages but cannot load anything, run anything, or break out of the <style>.
// The generated pages and the /blog/ reader build their CSS from the same function.
import { Refusal } from './errors.js';
import { isAssetRef, parseAssetRef, resolveAsset } from './assets.js';
import { THEMES, THEME_BASE } from './theme.js';

// System font stacks only: no external font loading, nothing to fetch.
export const FONTS = {
  serif: 'Georgia,"Iowan Old Style","Times New Roman",serif',
  sans: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif',
  humanist: 'Seravek,"Gill Sans Nova",Ubuntu,Calibri,"DejaVu Sans",sans-serif',
  slab: 'Rockwell,"Rockwell Nova","Roboto Slab","DejaVu Serif",serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
};

const COLOR_KEYS = ['accent', 'text', 'background', 'muted'];
const VAR = { accent: '--link', text: '--fg', background: '--bg', muted: '--muted' };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LAYOUTS = ['list', 'cards'];
export const MAX_CSS = 8000;
const MAX_LINKS = 8;

const bad = (m) => new Refusal('bad-blog-json', `customize: ${m}`);

// Custom CSS may restyle; it may not fetch, import, bind, escape or smuggle.
const AT_RULES = new Set(['media', 'supports', 'keyframes']);
const FORBIDDEN = [
  [/url\s*\(/i, 'url() (a stylesheet cannot load anything)'],
  [/image-set\s*\(|image\s*\(|cross-fade\s*\(|element\s*\(|paint\s*\(|src\s*\(/i, 'an image or resource function'],
  [/expression\s*\(|-moz-binding|behavior\s*:/i, 'a scripting hook'],
  [/javascript\s*:|data\s*:|vbscript\s*:/i, 'a script or data URL'],
];

export function checkCss(css) {
  if (typeof css !== 'string') throw bad('"css" must be text');
  if (css.length > MAX_CSS) throw bad(`"css" is ${css.length} characters; the limit is ${MAX_CSS}`);
  if (css.includes('<')) throw bad('"css" may not contain "<"');
  if (css.includes('\\')) throw bad('"css" may not contain backslash escapes');
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (plain.includes('/*')) throw bad('"css" has an unterminated comment');
  for (const m of plain.matchAll(/@([\w-]+)/g)) {
    if (!AT_RULES.has(m[1].toLowerCase())) throw bad(`"css" uses @${m[1]}; only @media, @supports and @keyframes are allowed`);
  }
  for (const [re, what] of FORBIDDEN) if (re.test(plain)) throw bad(`"css" uses ${what}`);
  return css;
}

function checkLinks(list, where) {
  if (!Array.isArray(list) || list.length > MAX_LINKS) throw bad(`${where}.links must be a list of at most ${MAX_LINKS}`);
  for (const l of list) {
    if (!l || typeof l.label !== 'string' || !l.label.trim() || l.label.length > 40) throw bad(`${where}.links need a label of 1-40 characters`);
    if (typeof l.url !== 'string' || !/^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(l.url)) throw bad(`${where}.links "${l.label}": url must be http(s) or mailto`);
    if (Object.keys(l).some((k) => k !== 'label' && k !== 'url')) throw bad(`${where}.links entries take only "label" and "url"`);
  }
}

function checkColors(c, where, allowDark) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad(`${where} must be an object`);
  for (const [k, v] of Object.entries(c)) {
    if (k === 'dark' && allowDark) continue;
    if (!COLOR_KEYS.includes(k)) throw bad(`${where}.${k} is not a colour (${COLOR_KEYS.join(', ')}${allowDark ? ', dark' : ''})`);
    if (typeof v !== 'string' || !HEX.test(v)) throw bad(`${where}.${k} must be a hex colour like #0b5fff`);
  }
  if (allowDark && c.dark !== undefined) checkColors(c.dark, `${where}.dark`, false);
}

function inRange(v, name, ranges) {
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)(px|rem|ch)$/.exec(v) : null;
  if (!m) throw bad(`"${name}" must look like ${Object.keys(ranges).map((u) => `1${u}`).join(', ')} with a number in range`);
  const range = ranges[m[2]];
  if (!range) throw bad(`"${name}" must use ${Object.keys(ranges).join(' or ')}`);
  if (Number(m[1]) < range[0] || Number(m[1]) > range[1]) throw bad(`"${name}" ${v} is outside ${range[0]}-${range[1]}${m[2]}`);
}

const only = (o, keys, where) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`${where}.${k} is not a setting (${keys.join(', ')})`);
};

export function validateCustomize(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('must be an object');
  only(c, ['colors', 'font', 'headingFont', 'width', 'fontSize', 'header', 'footer', 'list', 'css'], 'customize');
  if (c.colors !== undefined) checkColors(c.colors, 'colors', true);
  for (const k of ['font', 'headingFont']) if (c[k] !== undefined && !(c[k] in FONTS)) throw bad(`"${k}" must be one of ${Object.keys(FONTS).join(', ')}`);
  if (c.width !== undefined) inRange(c.width, 'width', { px: [400, 1280], rem: [25, 80], ch: [40, 120] });
  if (c.fontSize !== undefined) inRange(c.fontSize, 'fontSize', { px: [14, 24], rem: [0.875, 1.5] });
  if (c.header !== undefined) {
    only(c.header, ['logo', 'showTitle', 'links'], 'header');
    if (c.header.logo !== undefined) {
      try {
        if (!isAssetRef(c.header.logo)) throw 0;
        parseAssetRef(c.header.logo);
      } catch {
        throw bad('header.logo must be an asset: reference');
      }
    }
    if (c.header.showTitle !== undefined && typeof c.header.showTitle !== 'boolean') throw bad('header.showTitle must be true or false');
    if (c.header.links !== undefined) checkLinks(c.header.links, 'header');
  }
  if (c.footer !== undefined) {
    only(c.footer, ['text', 'links'], 'footer');
    if (c.footer.text !== undefined && (typeof c.footer.text !== 'string' || c.footer.text.length > 200)) throw bad('footer.text must be text of at most 200 characters');
    if (c.footer.links !== undefined) checkLinks(c.footer.links, 'footer');
  }
  if (c.list !== undefined) {
    only(c.list, ['layout', 'excerpts', 'dates', 'tags'], 'list');
    if (c.list.layout !== undefined && !LAYOUTS.includes(c.list.layout)) throw bad(`list.layout must be ${LAYOUTS.join(' or ')}`);
    for (const k of ['excerpts', 'dates', 'tags']) if (c.list[k] !== undefined && typeof c.list[k] !== 'boolean') throw bad(`list.${k} must be true or false`);
  }
  if (c.css !== undefined) checkCss(c.css);
  return c;
}

const decls = (colors) => {
  const out = [];
  for (const k of COLOR_KEYS) if (colors[k]) out.push(`${VAR[k]}:${colors[k]}`);
  // Rules and code backgrounds follow the text and background the author chose.
  if (colors.text || colors.background) out.push('--rule:color-mix(in srgb,var(--fg) 14%,var(--bg))', '--code:color-mix(in srgb,var(--fg) 7%,var(--bg))');
  return out.join(';');
};

// The whole stylesheet of a blog, for the generated pages and for the reader.
// `theme` is a loaded, verified theme pack (lib/theme-pack.js loadTheme) when blog.theme pins one.
export function themeCss(blog, theme = null) {
  const base = theme ? `${THEME_BASE}\n${theme.css}` : THEMES[typeof blog.theme === 'string' ? blog.theme : 'default'];
  const c = blog.customize;
  if (!c) return base;
  const root = [];
  if (c.font) root.push(`--font:${FONTS[c.font]}`);
  if (c.headingFont) root.push(`--heading-font:${FONTS[c.headingFont]}`);
  if (c.width) root.push(`--width:${c.width}`);
  if (c.fontSize) root.push(`--size:${c.fontSize}`);
  const parts = [base];
  if (root.length) parts.push(`:root{${root.join(';')}}`);
  const { dark, ...light } = c.colors || {};
  if (decls(light)) parts.push(`@media not (prefers-color-scheme:dark){:root{${decls(light)}}}`);
  if (dark && decls(dark)) parts.push(`@media (prefers-color-scheme:dark){:root{${decls(dark)}}}`);
  if (c.css) parts.push(checkCss(c.css).trim());
  return parts.join('\n');
}

// Blog-level asset references that need pinning (the post references are found in posts).
export const blogAssetRefs = (blog) => [blog.cover, blog.customize && blog.customize.header && blog.customize.header.logo].filter(Boolean);

export function resolveLogo(blog, lock) {
  const ref = blog.customize && blog.customize.header && blog.customize.header.logo;
  return ref ? resolveAsset(ref, blog, lock) : null;
}
