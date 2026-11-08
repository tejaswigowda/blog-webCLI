// Ingesting a WordPress theme: from the wordpress.org directory only, with the licence rules the
// work order sets out. What transfers is the CSS (style.css and the theme's other front-end stylesheets, where many themes keep their
// real styling), its images and fonts, and design tokens; the PHP
// templates, functions.php and JavaScript are not converted (the markup contract replaces the
// templates, and a reader runs no theme code), and the manifest says so.
//
//   blog-webcli theme import <slug> [outdir]
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Refusal } from '../lib/errors.js';
import { checkLicence, isGplFamily, normaliseGpl, splitLicensingLanguage } from '../lib/licence.js';
import { loadTheme, pinFor, processThemeCss, themeDigest, themeFilePaths, tokenOk } from '../lib/theme-pack.js';
import { resolvePath, stripComments, urlTokens } from '../lib/css.js';
import { readZip } from './zip.js';
import { harvestSkeleton } from './wp-skeleton.js';

const API = 'https://api.wordpress.org/themes/info/1.2/';
const dec = new TextDecoder();
const enc = new TextEncoder();
const text = (zip, name) => (zip.has(name) ? dec.decode(zip.get(name)) : '');

// "Theme Name: X" style header lines from the first comment of style.css.
export function parseStyleHeader(css) {
  const block = /\/\*([\s\S]*?)\*\//.exec(css);
  const out = {};
  if (!block) return out;
  for (const line of block[1].split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?)\s*:[ \t]*(\S.*?)\s*$/.exec(line);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

const refuse = (code, m) => new Refusal(code, m);

// ---- the theme as WordPress itself draws it ----
// wp-themes.com serves every directory theme with demo content. Its page says exactly which stylesheets the theme enqueues (and in
// which order), and carries the CSS the theme and WordPress generate in PHP (the Customizer's colours and fonts as custom properties,
// the block theme's global styles): the part of a theme's look that is in no .css file of its archive. Both are read from that one
// page, as text; nothing in it is run.
const DEMO = (slug) => `https://wp-themes.com/${slug}/`;
const INLINE_SKIP = /^(wp-|core-block-supports|classic-theme-styles|woocommerce|elementor|jetpack|admin-bar|dashicons|global-styles-css-custom-properties)/i;
const INLINE_MAX = 150_000;

// -> { links: [path in the theme, in page order], inline: [{ id, css }] }
export function parseDemo(html, slug) {
  const prefix = `https://wp-themes.com/wp-content/themes/${slug}/`;
  const links = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=['"]stylesheet['"]/i.test(tag)) continue;
    const href = /href=['"]([^'"]+)['"]/i.exec(tag);
    if (!href) continue;
    const u = href[1].replace(/&#038;|&amp;/g, '&');
    if (!u.startsWith(prefix)) continue;
    const rel = decodeURIComponent(u.slice(prefix.length).split(/[?#]/)[0]);
    if (/\.css$/i.test(rel) && !links.includes(rel)) links.push(rel);
  }
  const inline = [];
  for (const m of String(html).matchAll(/<style\b[^>]*\bid=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/style>/gi)) {
    const id = m[1].replace(/-inline-css$/, '');
    if ((id === 'global-styles' || !INLINE_SKIP.test(id)) && m[2].trim()) inline.push({ id, css: m[2] });
  }
  return { links, inline, page: String(html) };
}

// Inline CSS from the demo page -> one stylesheet the app's rules accept. What points outside the theme (web fonts, uploads) is removed;
// a block that still fails is left out whole and named.
function buildInlineCss(slug, blocks, zip, haveAssets, budget) {
  const pin = { repo: 'upstream/ingest', ref: 'v0.0.0' };
  const own = new RegExp(`https?://wp-themes\\.com/wp-content/themes/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g');
  let css = '';
  const skipped = [];
  const assets = [];
  for (const b of blocks) {
    let c = b.css.replace(own, '');
    c = c.replace(/@import\b[^;]*;/gi, '').replace(/@font-face\s*\{[^{}]*url\(\s*['"]?(?:https?:)?\/\/[^{}]*\}/gi, '').replace(/[^;{}]*url\(\s*['"]?(?:https?:)?\/\/[^)]*\)[^;}]*/gi, '');
    const refs = new Set();
    for (const t of urlTokens(stripComments(c))) {
      const a = t.arg.trim();
      if (a.startsWith('data:') || a.startsWith('#')) continue;
      const r = resolvePath('wp-inline.css', a.split(/[?#]/)[0]);
      if (r && zip.has(r)) refs.add(r);
    }
    if (css.length + c.length > Math.min(INLINE_MAX, budget)) {
      skipped.push({ rel: `inline ${b.id}`, why: 'over the size budget' });
      continue;
    }
    try {
      processThemeCss(c, { file: 'wp-inline.css', assets: new Set([...haveAssets, ...refs]), pin });
    } catch (e) {
      skipped.push({ rel: `inline ${b.id}`, why: String(e.detail || e.message).replace(/^wp-inline\.css:?\s*/, '').slice(0, 110) });
      continue;
    }
    css += `/* ${b.id} (from the theme's demo page on wordpress.org) */\n${c.trim()}\n`;
    for (const r of refs) if (!assets.includes(r)) assets.push(r);
  }
  return { css, assets, skipped };
}

// ---- a theme's other stylesheets ----
// Many themes (Astra, GeneratePress, Kadence, Neve, …) keep style.css as little more than a header and put the real styling in
// assets/css/*.css. The front-end ones are taken too, as long as each passes the same rules style.css does; one that does not is left out
// and named, with the reason, so one bad file never costs the whole theme. Not taken: right-to-left and editor/admin/customizer
// styles, other plugins' styles (there is nothing for them to style), and vendor libraries.
const EXTRA_SKIP_DIR = /(^|\/)(node_modules|vendor|vendors|libs?|plugins?|demos?|admin|inc|includes?|customi[sz]er|editor|woocommerce|elementor|tests?|languages)\//i;
const EXTRA_SKIP_NAME = /(^|[\/._-])(rtl|editor|block-editor|admin|wp-admin|customi[sz]er|woocommerce|elementor|bbpress|buddypress|jetpack|gravity|wpforms|learndash|lifter|tutor|dokan|bakery|siteorigin|beaver|kirki|print|ie|rtl)([._-]|\.css$)/i;
const MAIN_NAME = /(^|\/)(main|style|styles|theme|frontend|front|global|base|common|app|blog|layout|content|header|footer|components)(\.min)?\.css$/i;
const EXTRA_MAX_FILES = 7; // theme.json lists at most 8 stylesheets, style.css being one
const CSS_BUDGET = 450_000; // characters in all of them: a published theme.css may not exceed what the app reads
const ASSET_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/; // what theme.json accepts as a file path
const ASSET_MAX = 60; // every one of them is fetched when the theme is chosen or previewed, so a theme stays a small read
const ASSET_BYTES = 1_500_000;

// -> { taken: [{ rel, assets: [paths] }], skipped: [{ rel, why }] }
function pickExtraCss(zip, styleLength, styleAssets, ordered = null, maxFiles = EXTRA_MAX_FILES) {
  const all = [...zip.keys()].filter((n) => /\.css$/i.test(n) && n !== 'style.css');
  const byBase = new Map();
  for (const n of ordered ? [] : all) {
    if (EXTRA_SKIP_DIR.test(n) || EXTRA_SKIP_NAME.test(n)) continue;
    const base = n.replace(/\.min\.css$/i, '.css');
    if (!byBase.has(base) || /\.min\.css$/i.test(n)) byBase.set(base, n); // the minified copy is the smaller one
  }
  const rank = (n) => (MAIN_NAME.test(n) ? 100 : 0) + (/(^|\/)(assets\/)?(css|dist|styles?)\//i.test(n) ? 50 : 0);
  const fromDemo = ordered ? ordered.filter((n) => n === 'style.css' || zip.has(n)) : null; // the page's own order, style.css marking where it sat
  const candidates = fromDemo || [...byBase.values()].sort((a, b) => rank(b) - rank(a) || zip.get(b).length - zip.get(a).length || (a < b ? -1 : 1));
  const taken = [];
  const skipped = [];
  const haveAssets = new Set(styleAssets);
  let chars = styleLength;
  let bytes = styleAssets.reduce((n, r) => n + zip.get(r).length, 0);
  let afterStyle = false;
  for (const rel of candidates) {
    if (rel === 'style.css') {
      afterStyle = true;
      continue;
    }
    if (taken.length >= maxFiles) break;
    let css;
    try {
      css = new TextDecoder('utf-8', { fatal: true }).decode(zip.get(rel));
    } catch {
      skipped.push({ rel, why: 'not UTF-8 text' });
      continue;
    }
    if (chars + css.length > CSS_BUDGET) {
      skipped.push({ rel, why: 'over the size budget' });
      continue;
    }
    const refs = new Set();
    for (const t of urlTokens(stripComments(css))) {
      const a = t.arg.trim();
      if (a.startsWith('data:') || a.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(a) || a.startsWith('//')) continue;
      const r = resolvePath(rel, a.split(/[?#]/)[0]);
      if (r && zip.has(r)) refs.add(r);
    }
    if ([...refs].some((r) => !ASSET_PATH.test(r))) {
      skipped.push({ rel, why: 'refers to a file whose name theme.json cannot list' });
      continue;
    }
    const newAssets = [...refs].filter((r) => !haveAssets.has(r));
    const addBytes = newAssets.reduce((n, r) => n + zip.get(r).length, 0);
    if (haveAssets.size + newAssets.length > ASSET_MAX || bytes + addBytes > ASSET_BYTES) {
      skipped.push({ rel, why: 'its images and fonts are over the size budget' });
      continue;
    }
    try {
      processThemeCss(css, { file: rel, assets: new Set([...haveAssets, ...refs]), pin: { repo: 'upstream/ingest', ref: 'v0.0.0' } });
    } catch (e) {
      skipped.push({ rel, why: String(e.detail || e.message).replace(new RegExp(`^${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:?\\s*`), '').slice(0, 110) });
      continue;
    }
    taken.push({ rel, assets: [...refs], after: afterStyle });
    newAssets.forEach((r) => haveAssets.add(r));
    chars += css.length;
    bytes += addBytes;
  }
  return { taken, skipped, chars };
}

// info: the wordpress.org API record; zip: Map path -> bytes (paths relative to the theme folder).
export function convertWordPressTheme({ slug, info, zip, demo = null }) {
  if (!info || info.error || info.slug !== slug || !/^https:\/\/downloads\.wordpress\.org\//.test(info.download_link || '') || !/^https:\/\/wordpress\.org\/themes\//.test(info.homepage || '')) {
    throw refuse('not-in-directory', `"${slug}" is not a theme in the wordpress.org directory. Only directory themes are ingested: a listing there requires GPL-compatible code and assets.`);
  }
  const warnings = [];
  const style = text(zip, 'style.css');
  if (!style) throw refuse('bad-theme', `${slug} has no style.css`);
  const header = parseStyleHeader(style);

  // ---- licence ----
  if (!header.license) throw refuse('no-licence', `${slug}: style.css declares no "License:". Not ingested.`);
  const spdx = normaliseGpl(header.license);
  if (!spdx || !isGplFamily(spdx)) throw refuse('bad-licence', `${slug}: style.css declares "${header.license}", which is not a GPL-family licence. Directory themes must be GPL; this one is not ingested.`);
  checkLicence(spdx, `theme ${slug}`);
  // Split licensing is judged on what the author wrote about it, not on the GPL text itself.
  for (const [name, body] of [['style.css', style], ['readme.txt', text(zip, 'readme.txt')], ['README.md', text(zip, 'README.md')], ['readme.md', text(zip, 'readme.md')]]) {
    const hit = splitLicensingLanguage(body);
    if (hit) throw refuse('bad-licence', `${slug}: ${name} contains split-licensing language ("${hit}"). Assets may not share the theme's licence, so it is refused rather than adjudicated.`);
  }
  if (info.is_commercial) warnings.push('the directory marks this theme as commercial (a paid upgrade exists); the free theme is GPL, the upgrade is not part of this');

  // ---- what transfers ----
  const files = { 'style.css': enc.encode(style) };
  const assets = [];
  const missing = [];
  for (const t of urlTokens(stripComments(style))) {
    const a = t.arg.trim();
    if (a.startsWith('data:') || a.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(a) || a.startsWith('//')) throw refuse('bad-theme', `${slug}: style.css loads ${a.slice(0, 70)} from outside the theme; a theme may only use its own files`);
    const rel = resolvePath('style.css', a.split(/[?#]/)[0]);
    if (!rel || !zip.has(rel)) {
      missing.push(a);
      continue;
    }
    if (!assets.includes(rel)) {
      assets.push(rel);
      files[rel] = zip.get(rel);
    }
  }
  if (missing.length) throw refuse('bad-theme', `${slug}: style.css refers to files that are not in the theme: ${[...new Set(missing)].slice(0, 5).join(', ')}`);
  // with the demo page, the stylesheets are the ones the theme really enqueues, in its order; without it, a best guess by name
  const demoOrder = demo && demo.links && demo.links.length ? demo.links : null;
  const wantInline = !!(demo && demo.inline && demo.inline.length);
  const extra = pickExtraCss(zip, style.length, assets, demoOrder, wantInline ? EXTRA_MAX_FILES - 1 : EXTRA_MAX_FILES);
  let inline = { css: '', assets: [], skipped: [] };
  if (wantInline) {
    inline = buildInlineCss(slug, demo.inline, zip, new Set([...assets, ...extra.taken.flatMap((x) => x.assets)]), CSS_BUDGET - extra.chars);
    extra.skipped.push(...inline.skipped);
    if (inline.css) {
      files['wp-inline.css'] = enc.encode(inline.css);
      for (const a of inline.assets) if (!assets.includes(a)) {
        assets.push(a);
        files[a] = zip.get(a);
      }
    }
  }
  // the theme's page structure, from the same demo page (best effort: a page with no recognisable main area has none)
  const skeleton = demo && demo.page ? harvestSkeleton(demo.page) : null;
  if (skeleton) files['skeleton.html'] = enc.encode(skeleton.html);
  else if (demo && demo.page) warnings.push('no page skeleton could be taken from the demo page, so pages use the generic classic structure');
  for (const { rel, assets: used } of extra.taken) {
    files[rel] = zip.get(rel);
    for (const a of used) if (!assets.includes(a)) {
      assets.push(a);
      files[a] = zip.get(a);
    }
  }

  // ---- design tokens from a block theme's theme.json ----
  const tokens = {};
  const dropped = { php: [], js: [], templates: [], css: [], other: [] };
  const droppedTokens = [];
  if (zip.has('theme.json')) {
    let tj = {};
    try {
      tj = JSON.parse(text(zip, 'theme.json'));
    } catch {
      warnings.push('theme.json could not be read; no tokens were taken');
    }
    const arr = (v) => (Array.isArray(v) ? v : Array.isArray(v && v.theme) ? v.theme : []);
    const s = tj.settings || {};
    const take = (group, list, valueKey) => {
      for (const e of list) {
        if (e && tokenOk(group, e[valueKey], e.slug)) (tokens[group] ||= {})[e.slug] = String(e[valueKey]).trim();
        else if (e && e.slug) droppedTokens.push(`${group}.${e.slug}`);
      }
    };
    take('colors', arr(s.color && s.color.palette), 'color');
    take('fontFamilies', arr(s.typography && s.typography.fontFamilies), 'fontFamily');
    take('fontSizes', arr(s.typography && s.typography.fontSizes), 'size');
    take('spacing', arr(s.spacing && s.spacing.spacingSizes), 'size');
  }

  // ---- be honest about what was not taken ----
  for (const name of [...zip.keys()].sort()) {
    if (name in files || name === 'theme.json') continue;
    const why = extra.skipped.find((x) => x.rel === name);
    if (why) {
      dropped.css.push(`${name} (${why.why})`);
      continue;
    }
    if (/\.php$/i.test(name)) dropped.php.push(name);
    else if (/\.m?js$/i.test(name)) dropped.js.push(name);
    else if (/^(templates|parts|patterns)\/.+\.(html|php)$/i.test(name)) dropped.templates.push(name);
    else if (/\.css$/i.test(name)) dropped.css.push(name);
    else if (!/^(screenshot\.(png|jpe?g)|readme\.txt|license\.txt|licen[cs]e(\.md|\.txt)?|changelog\.(txt|md)|languages\/.*|\.[^/]+)$/i.test(name)) dropped.other.push(name);
  }
  for (const x of extra.skipped) if (x.rel.startsWith('inline ')) dropped.css.push(`${x.rel} (${x.why})`);
  if (droppedTokens.length) dropped.tokens = droppedTokens;
  for (const k of Object.keys(dropped)) {
    if (!dropped[k].length) delete dropped[k];
    else if (dropped[k].length > 500) dropped[k] = [...dropped[k].slice(0, 499), `… and ${dropped[k].length - 499} more`];
  }

  const author = typeof info.author === 'object' && info.author ? info.author.user_nicename : String(info.author || header.author || 'unknown');
  const manifest = {
    name: info.name || header['theme name'] || slug,
    version: String(info.version || header.version || '0'),
    licence: spdx,
    source: info.homepage,
    attribution: `${info.name || slug} ${info.version} by ${author} (${header['theme uri'] || info.homepage}); licence ${spdx}${header['license uri'] ? ` (${header['license uri']})` : ''}. Ingested from wordpress.org; PHP templates and scripts were not converted.`.slice(0, 600),
    description: (header.description || '').slice(0, 300) || undefined,
    class_contract: 'wordpress-classic',
    css: [...extra.taken.filter((x) => !x.after).map((x) => x.rel), 'style.css', ...extra.taken.filter((x) => x.after).map((x) => x.rel), ...(inline.css ? ['wp-inline.css'] : [])], // the theme's own order; what its PHP generates last
    ...(assets.length ? { assets: assets.sort() } : {}),
    ...(skeleton ? { skeleton: 'skeleton.html', ...(skeleton.bodyClass ? { body_class: skeleton.bodyClass } : {}) } : {}),
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(Object.keys(dropped).length ? { dropped } : {}),
    upstream: { slug, version: String(info.version || ''), directory: info.homepage },
  };
  if (manifest.description === undefined) delete manifest.description;
  files['theme.json'] = enc.encode(JSON.stringify(manifest, null, 2) + '\n');
  const lic = ['license.txt', 'LICENSE', 'LICENSE.txt', 'license.md', 'licence.txt'].find((n) => zip.has(n));
  files.LICENSE = lic ? zip.get(lic) : enc.encode(`${manifest.name} is licensed under ${spdx}.\n${header['license uri'] || ''}\n`);

  // Prove the result loads under this app's rules before anything is written.
  const pin = pinFor('upstream/ingest', 'v0.0.0', manifest, themeDigest(files, themeFilePaths(manifest)));
  loadTheme(pin, files);
  return { files, manifest, warnings };
}

export async function importWordPressTheme(slug, outDir, { fetchImpl = (...a) => globalThis.fetch(...a), log = console.log } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug || '')) throw refuse('not-in-directory', 'give the theme\'s wordpress.org slug, for example twentytwentyone');
  const infoRes = await fetchImpl(`${API}?action=theme_information&request%5Bslug%5D=${encodeURIComponent(slug)}`);
  const info = infoRes.ok ? await infoRes.json().catch(() => null) : null;
  if (!info || info.error) throw refuse('not-in-directory', `"${slug}" is not a theme in the wordpress.org directory.`);
  const zipRes = await fetchImpl(info.download_link);
  if (!zipRes.ok) throw new Error(`could not download ${info.download_link} (${zipRes.status})`);
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
  const all = readZip(zipBytes);
  // the archive has one top-level folder, the slug
  const prefix = `${slug}/`;
  const zip = new Map([...all].filter(([n]) => n.startsWith(prefix)).map(([n, b]) => [n.slice(prefix.length), b]));
  // the theme as wordpress.org draws it: which stylesheets it enqueues, and the CSS its PHP generates (best effort; absent, the archive alone is used)
  let demo = null;
  try {
    const res = await fetchImpl(DEMO(slug));
    if (res.ok) demo = parseDemo(await res.text(), slug);
  } catch {
    /* no demo page: the archive alone */
  }
  const { files, manifest, warnings } = convertWordPressTheme({ slug, info, zip, demo });
  if (!demo) warnings.push('the demo page on wordpress.org could not be read, so the stylesheets were chosen by name and the CSS the theme generates in PHP is not included');

  try {
    if ((await fs.readdir(outDir)).length) throw new Error(`${outDir} is not empty; choose a new folder`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const [rel, bytes] of Object.entries(files)) {
    const f = path.join(outDir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, bytes);
  }
  const zipHash = crypto.createHash('sha256').update(zipBytes).digest('hex');
  log(`imported ${manifest.name} ${manifest.version} (${manifest.licence}) into ${outDir}`);
  log(`  source   ${manifest.source}\n  archive  ${info.download_link}\n  sha256   ${zipHash}`);
  log(`  taken    ${manifest.css.length} stylesheet(s)${manifest.skeleton ? ', page skeleton' : ''}${manifest.assets ? `, ${manifest.assets.length} asset file(s)` : ''}${manifest.tokens ? ', design tokens' : ''}, LICENSE`);
  const d = manifest.dropped || {};
  log(`  dropped  ${Object.entries(d).map(([k, v]) => `${v.length} ${k}`).join(', ') || 'nothing'} (recorded in theme.json)`);
  for (const w of warnings) log(`  note     ${w}`);
  log(`Next: commit ${outDir} to a repository, tag a release (v${manifest.version.split('.').slice(0, 3).join('.')}), then:\n  blog-webcli theme pin <owner>/<repo>@<tag>`);
  return 0;
}
