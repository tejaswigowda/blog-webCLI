// The acceptance check for a theme written outside the editor (by a person or by an agent), and the loop's feedback: one run says what
// would be refused (every rule, with its reason and what to do), and, if nothing is, how the theme renders over the whole layout corpus at
// a desktop and a phone width. It stops at accepted or not. It does not publish: there is no token here, no GitHub call, no way to
// push. Generating a theme and publishing one are separate acts.
//
//   node cli/theme-check.mjs <theme-dir> [--reference-css file.css]... [--reference-url https://…] [--out dir] [--json]
//   node cli/theme-check.mjs --classes             the vocabulary the contract emits (what the CSS may target)
//   node cli/theme-check.mjs --new <dir> --reference https://… --agent "model version" [--relation inspired-by]
//
// Accepted = nothing refused AND the verdict is usable or usable (soft): no signature that hides, covers or loses content, on any page of the
// corpus, at either width. The measure is signatures, never pixel distance. A person looks at the contact sheet (<out>/sheet.html) last.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadTheme, pinFor, themeDigest, themeFilePaths, wouldRefuse } from '../lib/theme-pack.js';
import { declarationOverlap } from '../lib/overlap.js';
import { launch, openPage } from '../test/e2e/cdp.mjs';
import { POSTS, loadCorpus, emittedNames, readDir, renderAndMeasure, verdictOf } from './sweep-core.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
const first = (n) => values(n)[0];
const json = flag('--json');
const say = (...a) => { if (!json) console.log(...a); };

// ---- --classes -----------------------------------------------------------------------------------------------------------------
if (flag('--classes')) {
  const { classes, ids } = emittedNames(await loadCorpus());
  if (json) console.log(JSON.stringify({ contract: 'wordpress-classic-2', classes, ids }, null, 1));
  else { console.log(`wordpress-classic-2 emits ${classes.length} classes and ${ids.length} ids over the layout corpus.\n\nclasses:\n${classes.join('\n')}\n\nids:\n${ids.join('\n')}`); }
  process.exit(0);
}

// ---- --new ---------------------------------------------------------------------------------------------------------------------
if (first('--new')) {
  const dir = first('--new');
  const reference = first('--reference'), agent = first('--agent');
  if (!reference || !agent) { console.error('--new needs --reference https://… and --agent "model version"'); process.exit(2); }
  await fs.mkdir(dir, { recursive: true });
  const manifest = { name: path.basename(path.resolve(dir)), version: '0.1.0', licence: 'MIT', description: '', class_contract: 'wordpress-classic-2', css: ['style.css'], assets: [], origin: 'generated', reference, relation: first('--relation') || 'inspired-by', agent, generated: new Date().toISOString().slice(0, 10) };
  await fs.writeFile(path.join(dir, 'theme.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(dir, 'style.css'), '/* Write the theme against the classes `node cli/theme-check.mjs --classes` lists. */\n:root { --bg: #fff; --fg: #1a1a1a; --link: #0a58ca; }\nbody { background: var(--bg); color: var(--fg); }\n', { flag: 'wx' });
  console.log(`wrote ${dir}/theme.json and ${dir}/style.css; now run: node cli/theme-check.mjs ${dir}`);
  process.exit(0);
}

// ---- the reference stylesheet, the one network use ------------------------------------------------------------------------------------
async function referenceCss(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)) throw new Error('the reference must be a public https address');
  const get = async (href, limit) => {
    const r = await fetch(href, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${href}: ${r.status}`);
    const t = await r.text();
    return t.length > limit ? t.slice(0, limit) : t;
  };
  const html = await get(u.href, 2_000_000);
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)].map((m) => /href=["']?([^"' >]+)/i.exec(m[0])?.[1]).filter(Boolean).slice(0, 10);
  for (const h of hrefs) { try { const abs = new URL(h, u).href; if (abs.startsWith('https://')) css += '\n' + (await get(abs, 1_000_000)); } catch { /* one stylesheet missing does not stop the check */ } }
  return css;
}

// ---- check ---------------------------------------------------------------------------------------------------------------------
const dir = args.find((a, i) => !a.startsWith('--') && !['--reference-css', '--reference-url', '--out'].includes(args[i - 1]));
if (!dir) { console.error('usage: node cli/theme-check.mjs <theme-dir> [--reference-css f]... [--reference-url url] [--out dir] [--json]  |  --classes  |  --new <dir> --reference url --agent name'); process.exit(2); }
const OUT = first('--out') || path.join('/tmp', `theme-check-${path.basename(path.resolve(dir))}`);
const files = await readDir(dir);
const report = { theme: dir, accepted: false, refusals: wouldRefuse(files), verdict: null, signatures: {}, overlap: null, contactSheet: null };

if (!report.refusals.length) {
  const manifest = JSON.parse(new TextDecoder().decode(files['theme.json']));
  const pin = pinFor(`local/${path.basename(path.resolve(dir))}`, 'v0.0.0', manifest, themeDigest(files, themeFilePaths(manifest)));
  const theme = loadTheme(pin, files);
  const chrome = await launch();
  try {
    await fs.rm(OUT, { recursive: true, force: true });
    await fs.mkdir(path.join(OUT, 'shots'), { recursive: true });
    const page = await openPage(chrome, 'about:blank');
    await page.send('Page.enable');
    const res = await renderAndMeasure(page, { slug: 'theme', name: manifest.name, theme, pin, corpus: await loadCorpus(), dir: path.join(OUT, 'site'), shots: path.join(OUT, 'shots') });
    page.close();
    report.verdict = verdictOf(res, false);
    for (const [k, v] of Object.entries(res.pages)) for (const sz of ['desktop', 'phone']) if (v[sz].sig.length) (report.signatures[k] ||= {})[sz] = v[sz].sig;
    await fs.writeFile(path.join(OUT, 'sheet.html'), `<!doctype html><meta charset=utf-8><title>${manifest.name}</title><body style="font:12px system-ui;margin:8px"><p>${manifest.name}: ${report.verdict.verdict}</p><img src="shots/theme-desktop.jpg"> <img src="shots/theme-phone.jpg">`);
    report.contactSheet = path.join(OUT, 'sheet.html');
    report.accepted = ['usable', 'usable (soft)'].includes(report.verdict.verdict);
  } finally { chrome.close(); }
}

// overlap with a reference stylesheet: a signal, said as one
const refs = [];
for (const f of values('--reference-css')) refs.push(await fs.readFile(f, 'utf8'));
if (first('--reference-url')) { try { refs.push(await referenceCss(first('--reference-url'))); } catch (e) { report.referenceError = e.message; } }
if (refs.length) {
  const m = JSON.parse(new TextDecoder().decode(files['theme.json'] || new Uint8Array()) || '{}');
  const css = (Array.isArray(m.css) ? m.css : []).map((f) => (f in files ? new TextDecoder().decode(files[f]) : '')).join('\n');
  report.overlap = declarationOverlap(css, refs.join('\n'));
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
if (json) console.log(JSON.stringify(report, null, 1));
else {
  console.log(`${report.accepted ? 'ACCEPTED' : 'NOT ACCEPTED'}  ${dir}`);
  for (const r of report.refusals) console.log(`  refused  ${r.rule}  ${r.reason.startsWith(r.where) ? "" : `${r.where}: `}${r.reason}${r.fix ? `\n           fix: ${r.fix}` : ''}`);
  if (report.verdict) {
    console.log(`  render   ${report.verdict.verdict}${report.verdict.onPost.length ? `  on the post: ${report.verdict.onPost.join(', ')}` : ''}${report.verdict.stress.length ? `  elsewhere: ${report.verdict.stress.join(', ')}` : ''}`);
    for (const [k, v] of Object.entries(report.signatures)) console.log(`           ${k}: ${Object.entries(v).map(([sz, s]) => `${sz} ${s.join('+')}`).join('; ')}`);
    console.log(`  corpus   ${POSTS.length} posts + index (list, cards), page 2, tag, tags, archive, standalone page; 1280 and 390 px`);
    console.log(`  look     ${report.contactSheet}  (a person approves last)`);
  }
  if (report.overlap) console.log(`  overlap  ${report.overlap.note}`);
  if (report.referenceError) console.log(`  overlap  the reference could not be read: ${report.referenceError}`);
}
process.exit(report.accepted ? 0 : 1);
