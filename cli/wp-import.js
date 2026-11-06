// Ingesting a WordPress theme: from the wordpress.org directory only, with the licence rules the
// work order sets out. What transfers is the CSS, its images and fonts, and design tokens; the PHP
// templates, functions.php and JavaScript are not converted (the markup contract replaces the
// templates, and a reader runs no theme code), and the manifest says so.
//
//   blog-webcli theme import <slug> [outdir]
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Refusal } from '../lib/errors.js';
import { checkLicence, isGplFamily, normaliseGpl, splitLicensingLanguage } from '../lib/licence.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths, tokenOk } from '../lib/theme-pack.js';
import { resolvePath, stripComments, urlTokens } from '../lib/css.js';
import { readZip } from './zip.js';

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

// info: the wordpress.org API record; zip: Map path -> bytes (paths relative to the theme folder).
export function convertWordPressTheme({ slug, info, zip }) {
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
    if (/\.php$/i.test(name)) dropped.php.push(name);
    else if (/\.m?js$/i.test(name)) dropped.js.push(name);
    else if (/^(templates|parts|patterns)\/.+\.(html|php)$/i.test(name)) dropped.templates.push(name);
    else if (/\.css$/i.test(name)) dropped.css.push(name);
    else if (!/^(screenshot\.(png|jpe?g)|readme\.txt|license\.txt|licen[cs]e(\.md|\.txt)?|changelog\.(txt|md)|languages\/.*|\.[^/]+)$/i.test(name)) dropped.other.push(name);
  }
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
    css: ['style.css'],
    ...(assets.length ? { assets: assets.sort() } : {}),
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
  const { files, manifest, warnings } = convertWordPressTheme({ slug, info, zip });

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
  log(`  taken    style.css${manifest.assets ? `, ${manifest.assets.length} asset file(s)` : ''}${manifest.tokens ? ', design tokens' : ''}, LICENSE`);
  const d = manifest.dropped || {};
  log(`  dropped  ${Object.entries(d).map(([k, v]) => `${v.length} ${k}`).join(', ') || 'nothing'} (recorded in theme.json)`);
  for (const w of warnings) log(`  note     ${w}`);
  log(`Next: commit ${outDir} to a repository, tag a release (v${manifest.version.split('.').slice(0, 3).join('.')}), then:\n  blog-webcli theme pin <owner>/<repo>@<tag>`);
  return 0;
}
