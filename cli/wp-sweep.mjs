// Maintainer tool: render every imported theme over the layout corpus at a desktop and a phone width, in headless Chrome, and
// measure the failure signatures. It judges nothing by pixel distance: only whether the page is readable and fits.
//   node cli/wp-sweep.mjs [themes-dir] [out-dir] [slug...]  (writes <out>/sweep.json, verdicts.json, shots/*.jpg, sheet.html, docs/layout-sweep.md)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';
import { launch, openPage } from '../test/e2e/cdp.mjs';
import { REPO, loadCorpus, POSTS, readDir, renderAndMeasure, verdictOf } from './sweep-core.mjs';

const THEMES = process.argv[2] || path.join(REPO, '..', 'blog-webCLI-themes');
const OUT = process.argv[3] || '/tmp/sweep';
const corpus = await loadCorpus();

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
  return renderAndMeasure(page, { slug, name: manifest.name, theme, pin, corpus, dir: path.join(OUT, 'site', slug), shots: path.join(OUT, 'shots') });
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

// the sidebar half of "unportable?" needs the contract gap (node cli/wp-gap.mjs) first
let gap = {};
try { gap = JSON.parse(await fs.readFile(process.env.GAP_JSON || '/tmp/gap.json', 'utf8')).themes; } catch { /* absent */ }
const SIDEBAR = ['secondary', 'widget-area', 'sidebar', 'sidebar-primary', 'primary-sidebar'];
const verdicts = {};
for (const [slug, t] of Object.entries(results)) {
  if (t.error) { verdicts[slug] = { verdict: 'error', why: t.error }; continue; }
  const g = gap[slug] && gap[slug].gap.full;
  verdicts[slug] = verdictOf(t, !!g && SIDEBAR.some((n) => g.classes.includes(n) || g.ids.includes(n)));
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
