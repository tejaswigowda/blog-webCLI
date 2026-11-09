// A theme is a repository: theme.json + CSS (+ fonts/images). This module validates the
// manifest, computes the digest a blog pins, and turns the CSS into the stylesheet a page embeds.
//
// Trust model. Theme CSS may declare fonts and images (a classic WordPress theme needs them),
// so it is judged more loosely than customize.css, but only after it has matched its pinned
// sha256, and still: nothing but the theme's own declared files, rewritten to pinned addresses,
// plus small inline data: images and fonts. No @import, no foreign URL, no script hook.
import { Refusal } from './errors.js';
import { checkLicence } from './licence.js';
import { at, parseRepoRef } from './reporef.js';
import { filesDigest, validatePin } from './pin.js';
import { countUrlOpeners, resolvePath, stripComments, unescapeCss, urlTokens } from './css.js';
import { checkBodyClass, checkSkeleton } from './skeleton.js';
import { validateCustomize } from './customize.js';
import { PROVENANCE_KEYS, checkProvenance, provenanceFindings } from './provenance.js';

export const CONTRACTS = ['blog-webcli-v1', 'wordpress-classic', 'wordpress-classic-2'];
export const DEFAULT_THEME_BASE = 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}';
export const MAX_THEME_CSS = 800_000;

const bad = (m, rule) => new Refusal('bad-theme', m, undefined, rule);
const SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]*';
const REL = new RegExp(`^${SEG}(?:/${SEG})*$`);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYS = ['name', 'version', 'licence', 'source', 'attribution', 'description', 'screenshot', 'css', 'assets', 'class_contract', 'tokens', 'dropped', 'upstream', 'skeleton', 'body_class', 'kit', ...PROVENANCE_KEYS];

const dec = new TextDecoder('utf-8', { fatal: true });
const text = (v) => (typeof v === 'string' ? v : dec.decode(v));

// ---------- manifest ----------

const COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/a-z]+\))$/;
const UNIT = /^-?\d*\.?\d+(?:px|rem|em|%|vw|vh|ch)?$/;
const FAMILY = /^[\w\s,"'.-]{1,200}$/;
const clampOk = (v) => /^clamp\(([^(),]+),([^(),]+),([^(),]+)\)$/.exec(v)?.slice(1).every((p) => UNIT.test(p.trim()));

function checkTokens(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('tokens must be an object');
  const groups = { colors: (v) => COLOR.test(v), fontFamilies: (v) => FAMILY.test(v), fontSizes: (v) => UNIT.test(v) || clampOk(v), spacing: (v) => UNIT.test(v) || clampOk(v) };
  for (const [g, vals] of Object.entries(t)) {
    if (!(g in groups)) throw bad(`tokens.${g} is not a token group (${Object.keys(groups).join(', ')})`);
    if (!vals || typeof vals !== 'object' || Array.isArray(vals)) throw bad(`tokens.${g} must be an object of slug: value`);
    if (Object.keys(vals).length > 64) throw bad(`tokens.${g} has more than 64 entries`);
    for (const [slug, v] of Object.entries(vals)) {
      if (!SLUG.test(slug)) throw bad(`tokens.${g}: "${slug}" is not a slug`);
      if (typeof v !== 'string' || !groups[g](v.trim())) throw bad(`tokens.${g}.${slug}: "${v}" is not an allowed value`);
    }
  }
}

// Is `value` acceptable for a token group? (for importers that lift tokens from other formats)
export const tokenOk = (group, value, slug) => {
  const checks = { colors: (v) => COLOR.test(v), fontFamilies: (v) => FAMILY.test(v), fontSizes: (v) => UNIT.test(v) || clampOk(v), spacing: (v) => UNIT.test(v) || clampOk(v) };
  return SLUG.test(slug) && typeof value === 'string' && !!checks[group] && checks[group](value.trim());
};

// A theme's bootstrap kit: what a blog becomes when it starts fresh with the theme: the settings that make it look as the theme was designed
// (colours, fonts, width, list layout), a short home page, and a header picture with its credit. Data only, judged here and again when applied.
export const KIT_HOME_MAX = 4000;
const UNSPLASH = /^https:\/\/unsplash\.com\/[A-Za-z0-9@/_.-]{1,120}$/;
function checkKit(k, m) {
  if (!k || typeof k !== 'object' || Array.isArray(k)) throw bad('theme.json: "kit" must be an object');
  for (const key of Object.keys(k)) if (!['customize', 'home', 'hero'].includes(key)) throw bad(`theme.json: kit.${key} is not a field (customize, home, hero)`);
  if (k.customize !== undefined) {
    try {
      validateCustomize(k.customize);
    } catch (e) {
      throw bad(`theme.json: kit.${e.detail || e.message}`);
    }
  }
  if (k.home !== undefined && (typeof k.home !== 'string' || !k.home.trim() || k.home.length > KIT_HOME_MAX)) throw bad(`theme.json: kit.home must be markdown text of at most ${KIT_HOME_MAX} characters`);
  if (k.hero !== undefined) {
    const h = k.hero;
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw bad('theme.json: kit.hero must be an object');
    for (const key of Object.keys(h)) if (!['image', 'alt', 'credit'].includes(key)) throw bad(`theme.json: kit.hero.${key} is not a field (image, alt, credit)`);
    if (typeof h.image !== 'string' || !(m.assets || []).includes(h.image)) throw bad('theme.json: kit.hero.image must be one of the theme\'s "assets"');
    if (typeof h.alt !== 'string' || h.alt.length > 200 || /[<>]/.test(h.alt)) throw bad('theme.json: kit.hero.alt must be plain text');
    const c = h.credit;
    if (!c || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80 || /[<>]/.test(c.name) || !UNSPLASH.test(c.profile || '') || !UNSPLASH.test(c.source || '') || Object.keys(c).some((x) => !['name', 'profile', 'source'].includes(x))) {
      throw bad('theme.json: kit.hero.credit must be { name, profile, source }: the photographer, and their profile and the photo on unsplash.com');
    }
  }
}

export function validateThemeManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('theme.json must be an object');
  for (const k of Object.keys(m)) if (!KEYS.includes(k)) throw bad(`theme.json: "${k}" is not a field (${KEYS.join(', ')})`);
  for (const k of ['name', 'version']) if (typeof m[k] !== 'string' || !m[k].trim() || m[k].length > 80) throw bad(`theme.json: "${k}" is required`);
  checkLicence(m.licence, `theme "${m.name}"`);
  if (!CONTRACTS.includes(m.class_contract)) throw bad(`theme.json: class_contract must be one of ${CONTRACTS.join(', ')}`);
  if (!Array.isArray(m.css) || !m.css.length || m.css.length > 8 || !m.css.every((p) => typeof p === 'string' && REL.test(p) && p.endsWith('.css'))) throw bad('theme.json: "css" must list 1-8 relative .css paths');
  if (m.assets !== undefined && (!Array.isArray(m.assets) || m.assets.length > 300 || !m.assets.every((p) => typeof p === 'string' && REL.test(p)))) throw bad('theme.json: "assets" must list relative paths (at most 300)');
  if (m.screenshot !== undefined && !(typeof m.screenshot === 'string' && REL.test(m.screenshot))) throw bad('theme.json: "screenshot" must be a relative path');
  if (m.source !== undefined && !(typeof m.source === 'string' && /^https:\/\/[^\s]+$/.test(m.source))) throw bad('theme.json: "source" must be an https URL');
  for (const k of ['attribution', 'description']) if (m[k] !== undefined && (typeof m[k] !== 'string' || m[k].length > 600)) throw bad(`theme.json: "${k}" must be text of at most 600 characters`);
  if (m.skeleton !== undefined) {
    if (!(typeof m.skeleton === 'string' && REL.test(m.skeleton) && m.skeleton.endsWith('.html'))) throw bad('theme.json: "skeleton" must be a relative .html path');
    if (!String(m.class_contract).startsWith('wordpress-classic')) throw bad('theme.json: a skeleton belongs to a wordpress-classic theme (it is poured from that contract\'s page)');
  }
  checkProvenance(m);
  if (m.body_class !== undefined) checkBodyClass(m.body_class);
  if (m.kit !== undefined) checkKit(m.kit, m);
  if (m.tokens !== undefined) checkTokens(m.tokens);
  if (m.dropped !== undefined) {
    if (!m.dropped || typeof m.dropped !== 'object' || Array.isArray(m.dropped)) throw bad('theme.json: "dropped" must be an object of lists');
    for (const [k, v] of Object.entries(m.dropped)) if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && x.length < 200)) throw bad(`theme.json: dropped.${k} must be a list of file names`);
  }
  if (m.upstream !== undefined && (typeof m.upstream !== 'object' || Array.isArray(m.upstream) || !Object.values(m.upstream).every((v) => typeof v === 'string' && v.length < 200))) throw bad('theme.json: "upstream" must be an object of short strings');
  return m;
}

export const themeFilePaths = (m) => [...new Set(['theme.json', ...m.css, ...(m.assets || []), ...(m.skeleton ? [m.skeleton] : [])])].sort();

// The hash a blog pins: every file the theme declares, by path and content.
export const themeDigest = (files, paths) => filesDigest(files, paths, bad);

// ---------- CSS ----------

const DATA_OK = /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff2?|x-font-woff|vnd\.ms-fontobject))[;,]/i;
const AT_OK = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', '-moz-keyframes', 'font-face', 'page', 'layer', 'container', 'viewport', '-ms-viewport']);
const FORBIDDEN = [
  [/@import\b/i, '@import, which would load another stylesheet', 'css-import', 'put the rules in the theme\'s own css files'],
  [/image-set\s*\(|cross-fade\s*\(|\belement\s*\(|\bpaint\s*\(|\bimage\s*\(|\bsrc\s*\(/i, 'an image or resource function', 'css-image-function', 'use url() of a declared asset, or a gradient'],
  [/expression\s*\(|-moz-binding|behavior\s*:/i, 'a scripting hook', 'css-script-hook', 'remove it'],
  [/javascript\s*:|vbscript\s*:|\bdata\s*:/i, 'a script or data URL outside url()', 'css-script-url', 'data: images and fonts are allowed only inside url()'],
];

export const themeAssetUrl = (pin, path) => {
  const { repo, folder } = parseRepoRef(pin.repo);
  const [owner, name] = repo.split('/');
  return (pin.base || DEFAULT_THEME_BASE).replace('{owner}', owner).replace('{repo}', name).replace('{ref}', pin.ref).replace('{path}', at(folder, path).split('/').map(encodeURIComponent).join('/'));
};

// Everything wrong with one CSS file, as [{ rule, where, reason, fix }] in the order the checks run (processThemeCss refuses on the first).
// `rule` names the check, `fix` says what to do about it, so a tool that revises a theme can act on all of them at once.
export function cssFindings(css, { file, assets }) {
  const out = [];
  const add = (rule, reason, fix) => out.push({ rule, where: file, reason, fix });
  if (css.length > MAX_THEME_CSS) add('css-size', `${file} is ${css.length} characters; the limit is ${MAX_THEME_CSS}`, 'drop rules the contract never emits, or split the theme');
  // Only a closing </style can leave a <style> element. A bare < is inert there (and inline SVG data
  // images, common in real themes, contain one); an SVG used as a CSS image cannot run script.
  if (/<\/style/i.test(css)) add('css-style-close', `${file} contains "</style"`, 'remove it; it can end the page\'s <style> element');
  const src = stripComments(css).replace(/^\s*@charset\s+(?:"[^"]*"|'[^']*')\s*;/i, '');
  // an escape-built url( would not appear in the raw text: refuse the mismatch outright
  if (countUrlOpeners(unescapeCss(src)) !== countUrlOpeners(src)) add('css-escaped-url', `${file} hides a url() behind a CSS escape`, 'write url( plainly');
  const tokens = urlTokens(src);
  if (tokens.length !== countUrlOpeners(src)) add('css-url-form', `${file} has a url() that is not a plain quoted or unquoted address`, 'use url("file.ext") or url(file.ext)');
  let blanked = '';
  let last = 0;
  for (const t of tokens) {
    const arg = t.arg.trim();
    blanked += src.slice(last, t.index) + 'url()';
    last = t.index + t.length;
    if (arg.includes('\\')) add('css-url-backslash', `${file}: url("${arg.slice(0, 40)}") contains a backslash`, 'use forward slashes');
    else if (DATA_OK.test(arg) || arg.startsWith('#')) continue;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(arg) || arg.startsWith('//')) add('css-foreign-url', `${file}: url(${arg.slice(0, 60)}) points outside the theme; only the theme's own files may be referenced`, 'ship the file as a theme asset (with its licence) or drop the declaration');
    else {
      const m = /^([^?#]*)([?#].*)?$/.exec(arg);
      const resolved = resolvePath(file, m[1]);
      if (!resolved || !assets.has(resolved)) add('css-undeclared-asset', `${file}: url(${arg.slice(0, 60)}) names a file that theme.json does not list under "assets"`, 'add the file to "assets" (and, for a generated theme, to "asset_licences")');
    }
  }
  blanked += src.slice(last);
  const scan = unescapeCss(blanked);
  for (const m of scan.matchAll(/@([\w-]+)/g)) if (!AT_OK.has(m[1].toLowerCase())) add(m[1].toLowerCase() === 'import' ? 'css-import' : 'css-at-rule', `${file} uses @${m[1]}, which is not allowed`, m[1].toLowerCase() === 'import' ? 'put the rules in the theme\'s own css files; an @import would load another stylesheet' : `remove the @${m[1]} block (allowed: ${[...AT_OK].join(', ')})`);
  for (const [re, what, rule, fix] of FORBIDDEN) if (re.test(scan) && !out.some((f) => f.rule === rule)) add(rule, `${file} uses ${what}`, fix);
  return out;
}

// One CSS file -> safe CSS. `file` is its path in the repo; `assets` the declared asset set.
export function processThemeCss(css, { file, assets, pin }) {
  const found = cssFindings(css, { file, assets });
  if (found.length) throw bad(found[0].reason, found[0].rule);
  const src = stripComments(css).replace(/^\s*@charset\s+(?:"[^"]*"|'[^']*')\s*;/i, '');
  let out = '';
  let last = 0;
  for (const t of urlTokens(src)) {
    const arg = t.arg.trim();
    let rewritten;
    if (DATA_OK.test(arg)) rewritten = `url("${arg.replace(/"/g, '%22')}")`;
    else if (arg.startsWith('#')) rewritten = `url("${arg}")`;
    else {
      const m = /^([^?#]*)([?#].*)?$/.exec(arg);
      rewritten = `url("${themeAssetUrl(pin, resolvePath(file, m[1]))}${(m[2] || '').replace(/"/g, '%22')}")`;
    }
    out += src.slice(last, t.index) + rewritten;
    last = t.index + t.length;
  }
  out += src.slice(last);
  return out.trim();
}

const PRESET = { colors: 'color', fontFamilies: 'font-family', fontSizes: 'font-size', spacing: 'spacing' };
const ALIAS = { background: '--bg', base: '--bg', foreground: '--fg', contrast: '--fg', primary: '--link' };

// Design tokens as custom properties, in WordPress's preset naming so WordPress CSS finds them,
// with the conventional colour slugs also mapped to this app's own variables.
export function tokensCss(tokens) {
  if (!tokens) return '';
  const decl = [];
  for (const [g, vals] of Object.entries(tokens)) for (const [slug, v] of Object.entries(vals)) decl.push(`--wp--preset--${PRESET[g]}--${slug}:${v.trim()}`);
  for (const [slug, v] of Object.entries(tokens.colors || {})) if (ALIAS[slug]) decl.push(`${ALIAS[slug]}:${v.trim()}`);
  return decl.length ? `:root{${decl.join(';')}}` : '';
}

// Everything that would make loadTheme refuse these files, not just the first thing: [{ rule, where, reason, fix }], empty when the theme
// would load. A tool that writes themes revises against this list, so each entry names its rule and says what to do about it. Pinning
// (the sha256) is not checked: that is about a published copy, not about the files.
export function wouldRefuse(files) {
  const out = [];
  const add = (rule, where, reason, fix = '') => out.push({ rule, where, reason, fix });
  let m;
  if (!('theme.json' in files)) return [{ rule: 'manifest-missing', where: 'theme.json', reason: 'the theme has no theme.json', fix: 'add theme.json' }];
  try { m = JSON.parse(text(files['theme.json'])); } catch (e) { return [{ rule: 'manifest-json', where: 'theme.json', reason: `theme.json is not valid JSON (${e.message})`, fix: 'fix the syntax' }]; }
  try { validateThemeManifest(m); } catch (e) {
    if (!(e.rule && /^(prov|asset)-/.test(e.rule))) add(e.rule || e.code, e.where || 'theme.json', e.detail || e.message, 'see the reason; the field is named in it');
  }
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    try { for (const f of provenanceFindings(m)) out.push(f); } catch { /* a malformed manifest is already reported above */ }
    const assets = new Set(Array.isArray(m.assets) ? m.assets.filter((p) => typeof p === 'string') : []);
    for (const file of Array.isArray(m.css) ? m.css.filter((p) => typeof p === 'string') : []) {
      if (!(file in files)) { add('file-missing', file, `theme.json lists "${file}" under "css" but the file is not there`, 'add the file or remove it from "css"'); continue; }
      let css;
      try { css = text(files[file]); } catch { add('css-encoding', file, `${file} is not valid UTF-8`, 'save it as UTF-8'); continue; }
      for (const f of cssFindings(css, { file, assets })) out.push(f);
    }
    for (const p of assets) if (!(p in files)) add('file-missing', p, `theme.json lists "${p}" under "assets" but the file is not there`, 'add the file or remove it from "assets"');
    if (typeof m.skeleton === 'string') {
      if (!(m.skeleton in files)) add('file-missing', m.skeleton, `theme.json lists the skeleton "${m.skeleton}" but the file is not there`, 'add it or remove "skeleton"');
      else { try { checkSkeleton(text(files[m.skeleton])); } catch (e) { add(e.rule || 'skeleton', m.skeleton, e.detail || e.message, 'see the reason'); } }
    }
  }
  const seen = new Set();
  return out.filter((f) => { const k = `${f.rule}|${f.where}|${f.reason}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- a loaded, verified theme ----------

// files: { path: string | Uint8Array } read at the pinned ref. Verifies and processes; throws a
// Refusal on anything wrong. The result is plain data, safe to hand to the (pure) generator.
export function loadTheme(pin, files) {
  validatePin(pin, 'theme');
  if (!('theme.json' in files)) throw bad(`${pin.repo}@${pin.ref} has no theme.json`);
  let manifest;
  try {
    manifest = JSON.parse(text(files['theme.json']));
  } catch (e) {
    throw bad(`theme.json is not valid JSON (${e.message})`);
  }
  validateThemeManifest(manifest);
  const digest = themeDigest(files, themeFilePaths(manifest));
  if (digest !== pin.sha256) throw new Refusal('pin-mismatch', `${pin.repo}@${pin.ref} hashes to ${digest}, but blog.json pins ${pin.sha256}. The theme changed after it was pinned; review it and pin it again, or revert.`);
  for (const [k, from] of [['licence', 'licence'], ['name', 'name'], ['version', 'version'], ['contract', 'class_contract']]) {
    if (pin[k] !== undefined && pin[k] !== manifest[from]) throw new Refusal('pin-mismatch', `blog.json records ${k} "${pin[k]}" for this theme but theme.json says "${manifest[from]}"`);
  }
  const assets = new Set(manifest.assets || []);
  const css = manifest.css.map((file) => processThemeCss(text(files[file]), { file, assets, pin })).join('\n');
  // a skeleton makes the contract an object: { name, skeleton: { html, bodyClass } } (contractOf in lib/contracts.js reads either)
  const skeleton = manifest.skeleton ? { html: checkSkeleton(text(files[manifest.skeleton])), bodyClass: checkBodyClass(manifest.body_class) } : null;
  return { pin, manifest, contract: manifest.class_contract, contractSpec: skeleton ? { name: manifest.class_contract, skeleton } : manifest.class_contract, skeleton, css: [tokensCss(manifest.tokens), css].filter(Boolean).join('\n'), digest };
}

// The header picture of a theme's kit, as the top of the home page, with its credit (the photographer, their profile and the photo, on
// Unsplash). '' when the theme has none. The picture is a file of the theme, at the address its pin names.
export function heroHtml(pin, manifest) {
  const hero = manifest && manifest.kit && manifest.kit.hero;
  if (!hero) return '';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const c = hero.credit;
  return `<figure class="theme-hero"><img src="${esc(themeAssetUrl(pin, hero.image))}" alt="${esc(hero.alt)}"><figcaption>Photo by <a href="${esc(c.profile)}" rel="noopener">${esc(c.name)}</a> on <a href="${esc(c.source)}" rel="noopener">Unsplash</a></figcaption></figure>`;
}

// What a blog records about a theme it pins (so licences are visible without fetching it).
export function pinFor(repo, ref, manifest, digest, base) {
  // The contract is recorded so a reader can render the right markup without fetching the theme.
  const pin = { repo, ref, sha256: digest, name: manifest.name, version: manifest.version, licence: manifest.licence, contract: manifest.class_contract };
  if (base) pin.base = base;
  return pin;
}

// A stylesheet a READER is about to apply: it came from a repository the reader has no reason
// to trust (the blog's committed theme.css). Loose on what themes legitimately contain, strict on
// what could reach out or run: no @import, no non-https url(), no script hooks, no "<".
export function checkPublishedCss(css) {
  const bad = (m) => new Refusal('bad-theme', `theme.css ${m}`);
  if (typeof css !== 'string' || css.length > MAX_THEME_CSS + 200_000) throw bad('is missing or too large');
  if (/<\/style/i.test(css)) throw bad('contains "</style"');
  const src = stripComments(css);
  const dec = unescapeCss(src);
  if (countUrlOpeners(dec) !== countUrlOpeners(src)) throw bad('hides a url() behind a CSS escape');
  for (const t of urlTokens(src)) {
    const a = t.arg.trim();
    if (!(/^https:\/\//i.test(a) || a.startsWith('#') || DATA_OK.test(a))) throw bad(`has a url() that is not https: "${a.slice(0, 50)}"`);
  }
  if (urlTokens(src).length !== countUrlOpeners(src)) throw bad('has a url() that is not a plain address');
  const scan = dec.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, 'url()');
  for (const m of scan.matchAll(/@([\w-]+)/g)) if (!AT_OK.has(m[1].toLowerCase())) throw bad(`uses @${m[1]}`);
  for (const [re, what] of FORBIDDEN) if (re.test(scan)) throw bad(`uses ${what}`);
  return css;
}
