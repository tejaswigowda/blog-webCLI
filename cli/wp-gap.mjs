// Maintainer tool: the contract gap of the imported themes, computed statically (no browser, no screenshots).
// For each theme in blog-webCLI-themes/wp it takes every class and id the theme's CSS targets, subtracts every class and id the
// generator emits over a corpus of pages, and writes what is left: what the theme wants and does not get.
//   node cli/wp-gap.mjs [themes-dir] [out.json]
// "contract" is what the generator emits on its own; "full" also counts the markup the theme's own skeleton pours in.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/blog.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';
import { EXAMPLE_BLOG } from '../lib/sample.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const THEMES = process.argv[2] || path.join(REPO, '..', 'blog-webCLI-corpus');
const OUT = process.argv[3] || '/tmp/gap.json';

const readDir = async (dir) => {
  const out = {};
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(p)); } };
  await walk(dir);
  return out;
};

// The selectors a stylesheet targets: classes and ids in rule preludes only (never in declarations), looking inside @media-like blocks,
// skipping @font-face and @keyframes, and ignoring what sits inside :not(...) (a negation asks for nothing).
export function wantedOf(css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const classes = new Set(), ids = new Set();
  const take = (prelude) => {
    let p = prelude.replace(/\[[^\]]*\]/g, '');
    for (let i = 0; i < 4; i++) p = p.replace(/:not\([^()]*\)/g, '');
    for (const m of p.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]);
    for (const m of p.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) ids.add(m[1]);
  };
  let i = 0, start = 0;
  const skipBlock = (from) => { let d = 1, j = from; while (j < s.length && d) { const c = s[j++]; if (c === '{') d++; else if (c === '}') d--; } return j; };
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {
      const prelude = s.slice(start, i).trim();
      if (/^@(media|supports|layer|container|document|scope|-moz-document)\b/i.test(prelude)) { i++; start = i; continue; }
      if (prelude.startsWith('@')) { i = skipBlock(i + 1); start = i; continue; }
      take(prelude);
      i = skipBlock(i + 1);
      start = i;
      continue;
    }
    if (c === '}') { i++; start = i; continue; }
    if (c === ';') start = i + 1;
    i++;
  }
  return { classes, ids };
}

// What a page emits: every class and id on an element.
export function emittedOf(html) {
  const h = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const classes = new Set(), ids = new Set();
  for (const m of h.matchAll(/\sclass\s*=\s*"([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  for (const m of h.matchAll(/\sid\s*=\s*"([^"]*)"/g)) if (m[1]) ids.add(m[1]);
  return { classes, ids };
}

const unite = (a, b) => { for (const x of b) a.add(x); };
const htmlOf = (files) => Object.entries(files).filter(([k]) => k.endsWith('.html')).map(([, v]) => v);

// A kind for each missing name. A region is markup that implies content a blog does not have, and must not be faked; a state is
// something a script toggles; a plugin is someone else's product; a block is Gutenberg's own; the rest is a container: a wrapper.
const REGION = /^(children|bypostauthor|avatar|tagcloud|textwidget|logged-in-as|form-submit|says|required|edit-link|search-submit|search-field|submit|comment|reply|byline-edit)$|(^|[-_])(sidebar|widget|widgets|widget-area|comments?|comment-list|comment-form|respond|reply|pingback|trackback|related-posts?|author-box|author-bio|authors?-info|share|sharing|social|newsletter|subscribe|search-form|searchform|cart|woo|shop|product|products|breadcrumbs?|pagination-wrap)([-_]|$)/i;
const STATE = /^(open|opened|active|is-[\w-]+|has-[\w-]+-open|toggled|toggle[d]?|show|shown|hide|hidden|collapsed?|collapsing|expanded|current(-[\w-]+)?|focus|focused|hover|sticky|stuck|fixed|visible|invisible|in|out|fade|slide|loading|loaded|disabled|selected|checked|menu-open|nav-open|search-open|js|no-js)$/i;
const PLUGIN = /^(woocommerce|wc-|elementor|wpcf7|jetpack|tribe-|bbp-|bp-|wpforms|gform|mc4wp|yoast|wpml|polylang|slick-|swiper|owl-|fa-|fa$|fas$|far$|fab$|dashicons|genericon|glyphicon|icon-|material-icons|ti-|lnr|elementor)/i;
const BLOCK = /^(wp-block-|wp-|has-|align(left|right|center|wide|full|none)$|screen-reader-text|sr-only|skip-link|alignleft|alignright|aligncenter|size-|attachment-|wp-caption|gallery|blocks-gallery|is-style-|is-layout-)/i;
const BODY = /^(home|blog|single|single-post|single-[\w-]+|page|page-template[\w-]*|archive|category|tag|date|author|error404|search|search-results|search-no-results|paged|rtl|logged-in|admin-bar|no-sidebar|has-sidebar|hfeed|front-page|page-id-\d+|postid-\d+|wp-singular|wp-theme-[\w-]+|customize-support|no-js|js)$/;
export function kindOf(name, isId) {
  if (BODY.test(name)) return 'body';
  if (REGION.test(name)) return 'region';
  if (STATE.test(name)) return 'state';
  if (PLUGIN.test(name)) return 'plugin';
  if (BLOCK.test(name)) return 'block';
  if (isId) return 'container';
  return 'container';
}

async function corpus() {
  const posts = [];
  const add = async (dir, prefix) => { for (const f of (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort()) posts.push({ path: `${prefix}/${f.replace(/[^\w.-]/g, '-')}`, text: await fs.readFile(path.join(dir, f), 'utf8') }); };
  await add(path.join(REPO, 'examples/blog/posts'), 'posts');
  await add(path.join(REPO, 'test/golden'), 'posts');
  await add(path.join(REPO, 'test/corpus'), 'posts');
  await add(path.join(REPO, 'test/layout'), 'posts');
  posts.push({ path: 'pages/about.md', text: '---\nslug: about\ntitle: About\nstatus: published\n---\n\nA standalone page.\n' });
  return posts;
}

const ex = JSON.parse(await fs.readFile(path.join(REPO, 'examples/blog/blog.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(REPO, 'examples/blog/assets.lock.json'), 'utf8'));
const allInputs = await corpus();
const blog0 = JSON.parse(JSON.stringify(EXAMPLE_BLOG));
blog0.assets = ex.assets;
blog0.video = ex.video;
blog0.pagination = { size: 3 };

// the corpus the generator accepts: drop any file the build refuses, one at a time
const base = buildSite({ blog: JSON.stringify(blog0), posts: [], lock });
if (base.errors.length) throw new Error(base.errors[0].message);
const inputs = [];
for (const p of allInputs) { const t = buildSite({ blog: JSON.stringify(blog0), posts: [p], lock }); if (!t.errors.length) inputs.push(p); }

const WP = path.join(THEMES, 'wp');
const slugs = (await fs.readdir(WP)).filter((n) => !n.includes('.')).sort();
const themes = {};
const wantCount = { contract: new Map(), full: new Map() };

for (const slug of slugs) {
  const dir = path.join(WP, slug);
  const files = await readDir(dir);
  const manifest = JSON.parse(new TextDecoder().decode(files['theme.json']));
  const pin = pinFor(`tejaswigowda/blog-webCLI-themes/wp/${slug}`, 'v1.5.0', manifest, themeDigest(files, themeFilePaths(manifest)));
  let theme = loadTheme(pin, files);
  // CONTRACT=wordpress-classic-2 renders the same theme under another contract of the family, to see what it changes
  if (process.env.CONTRACT) theme = { ...theme, contract: process.env.CONTRACT, contractSpec: theme.skeleton ? { name: process.env.CONTRACT, skeleton: theme.skeleton } : process.env.CONTRACT };
  const css = manifest.css.map((f) => new TextDecoder().decode(files[f])).join('\n') + '\n' + (files['wp-inline.css'] ? new TextDecoder().decode(files['wp-inline.css']) : '');
  const wants = wantedOf(css);
  const render = (t) => {
    const e = { classes: new Set(), ids: new Set() };
    let pages = 0;
    for (const layout of ['list', 'cards']) {
      const out = buildSite({ blog: JSON.stringify({ ...blog0, theme: pin, customize: { ...(blog0.customize || {}), list: { ...((blog0.customize || {}).list || {}), layout } } }), posts: inputs, lock, theme: t });
      if (out.errors.length) throw new Error(`${slug}: ${out.errors[0].message}`);
      for (const h of htmlOf(out.files)) { const x = emittedOf(h); unite(e.classes, x.classes); unite(e.ids, x.ids); }
      pages = htmlOf(out.files).length;
    }
    return { e, pages };
  };
  const full = render(theme);
  const bare = render({ ...theme, skeleton: null, contractSpec: theme.contract });
  const gap = (e) => ({ classes: [...wants.classes].filter((c) => !e.classes.has(c)).sort(), ids: [...wants.ids].filter((c) => !e.ids.has(c)).sort() });
  const g = { contract: gap(bare.e), full: gap(full.e) };
  themes[slug] = { name: manifest.name, contract: manifest.class_contract, skeleton: !!manifest.skeleton, wantedClasses: wants.classes.size, wantedIds: wants.ids.size, gap: g, pages: full.pages };
  for (const view of ['contract', 'full']) for (const [kind, list] of [['.', g[view].classes], ['#', g[view].ids]]) for (const n of list) wantCount[view].set(kind + n, (wantCount[view].get(kind + n) || 0) + 1);
}

const rank = (m) => [...m].map(([k, n]) => ({ selector: k, themes: n, kind: kindOf(k.slice(1), k[0] === '#') })).sort((a, b) => b.themes - a.themes || a.selector.localeCompare(b.selector));
const result = { corpusPosts: inputs.length, themeCount: slugs.length, ranking: { contract: rank(wantCount.contract), full: rank(wantCount.full) }, themes };
await fs.writeFile(OUT, JSON.stringify(result, null, 1));
const k = (r) => r.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {});
console.log(`${slugs.length} themes, corpus ${inputs.length}/${allInputs.length} files`);

// What to do about a missing name that several themes want. EMIT: a wrapper or a class on an element the page already has, that can be
// populated truthfully. NO: it implies content a blog does not have, or a script, or a feature (post formats, submenus, categories).
const EMIT = new Set(['.page-numbers', '.next', '.prev', '.current', '.posts-navigation', '.updated', '.post-date', '.more-link', '.read-more', '.current_page_item', '.current-menu-item', '.page-content', '.nav-menu', '.site-logo', '.taxonomy-description', '.archive-title', '.custom-logo-link']);
const NO = new Map([['.menu-item-has-children', 'the blog menu is flat: no submenus'], ['.sub-menu', 'the blog menu is flat: no submenus'], ['.cat-links', 'a blog has tags, not categories'], ['.menu-toggle', 'needs a script; the generator ships none'], ['.page-links', 'a post is one page'], ['.dots', 'the pager has no numbered links to elide'], ['.button', 'a form control, not markup the blog has'], ['.alt', 'a table-row or product state'], ['.url', 'comment author link'], ['.clear', 'a utility class, not structure'], ['.clearfix', 'a utility class, not structure']]);
const FORMAT = /^\.format-(aside|quote|status|link|gallery|image|video|audio|chat)$/;
const UTIL = /^\.(d|flex|align|justify|w|h|m|p|mt|mb|ml|mr|pt|pb|col|row|text|btn|navbar|nav|card|order|float|border|rounded|bg|badge|alert|modal|form|table|list|input|dropdown|carousel|collapse|fade|show|embed|img|figure|offset|g|gx|gy|position|overflow|visible|invisible|sticky|shadow|font|lead|display|fw|fs|lh|mx|my|px|py|ms|me|ps|pe|gap|mh|mw|no-gutters|h[1-6]|columns|mejs|select2|bounce|flash|flip|pulse|rubber|shake|slide|light|rotate|roll|jello|hinge|heart|swing|tada|wobble|zoom)(-|[A-Z]|$|\d)/;
const dispose = (x) => {
  if (x.kind !== 'container') return x.kind === 'region' ? ['no', 'implies content a blog does not have (comments, widgets, a sidebar, search form)'] : x.kind === 'plugin' ? ['n/a', 'a plugin\'s own markup'] : x.kind === 'state' ? ['n/a', 'toggled by a script'] : x.kind === 'body' ? ['partial', 'honest ones (home, single, page, archive, error404, search) can go on <body>; logged-in, admin-bar, rtl, templates cannot'] : ['n/a', 'a Gutenberg block or core helper class'];
  if (NO.has(x.selector)) return ['no', NO.get(x.selector)];
  if (FORMAT.test(x.selector)) return ['no', 'a post format; the blog has none'];
  if (UTIL.test(x.selector)) return ['n/a', 'a framework utility or animation the theme ships and uses itself'];
  if (EMIT.has(x.selector)) return ['emit', 'a class on an element the page already has, or a wrapper, populated truthfully'];
  return ['review', ''];
};
const shared = result.ranking.full.filter((x) => x.themes >= 5);
const rows = shared.map((x) => ({ ...x, d: dispose(x) }));
const by = (d) => rows.filter((x) => x.d[0] === d);
const md = [];
md.push('# Contract gap of the imported themes', '', `Computed statically by \`node cli/wp-gap.mjs\` from the CSS of the ${slugs.length} themes in \`blog-webCLI-themes/wp\` and the markup \`wordpress-classic\` emits over a corpus of ${inputs.length} posts and pages (list and cards layouts, paginated, with tag, author, archive and search listings). No browser is involved.`, '', 'A *gap* is a class or id a theme\'s stylesheet targets that no page of the corpus carries. Names wanted by fewer than 5 themes are a theme\'s own vocabulary, not a contract question, and are left out of the tables below (they are in the JSON).', '');
md.push('## What is missing, by kind', '', '| kind | distinct names missing | wanted by 5+ themes |', '|---|---|---|');
for (const kd of ['container', 'region', 'plugin', 'block', 'state', 'body']) md.push(`| ${kd} | ${result.ranking.full.filter((x) => x.kind === kd).length} | ${shared.filter((x) => x.kind === kd).length} |`);
md.push('', 'Most of the raw gap is noise: plugin markup (WooCommerce, Elementor), Gutenberg block classes, framework utilities and animation names a theme ships with its own CSS. The contract is not short of those.', '');
md.push('## Emit: container markup that can be populated truthfully', '', '| themes | selector |', '|---|---|');
for (const x of by('emit')) md.push(`| ${x.themes} | \`${x.selector}\` |`);
md.push('', '## Do not fake: content regions and features a blog does not have', '', '| themes | selector | why |', '|---|---|---|');
for (const x of rows.filter((y) => y.d[0] === 'no').slice(0, 60)) md.push(`| ${x.themes} | \`${x.selector}\` | ${x.d[1]} |`);
md.push('', '## Review', '', rows.filter((x) => x.d[0] === 'review' && x.kind === 'container' && !/^\.(bounce|fade|flip|rotate|slide|roll|light|zoom)/.test(x.selector)).slice(0, 60).map((x) => `\`${x.selector}\` (${x.themes})`).join(', '), '');
// themes that want a sidebar: a candidate for "not portable", to be settled by rendering
const sidebar = ['#secondary', '.widget-area', '.sidebar', '#sidebar', '.sidebar-primary', '.primary-sidebar'];
const wantsSide = Object.entries(themes).filter(([, t]) => sidebar.some((n) => (n[0] === '#' ? t.gap.full.ids.includes(n.slice(1)) : t.gap.full.classes.includes(n.slice(1)))));
md.push('## Themes that target a sidebar', '', `${wantsSide.length} of ${slugs.length} style \`#secondary\`, \`.widget-area\` or \`.sidebar\`, which the generator does not emit (and must not, empty). Whether that makes a theme *unportable* depends on whether its layout leaves a hole without it. That takes a render, not a stylesheet: it is the next step (the failure signatures, on the corpus).`, '', wantsSide.map(([s]) => `\`${s}\``).join(', '), '');
await fs.mkdir(path.join(REPO, 'docs'), { recursive: true });
await fs.writeFile(path.join(REPO, 'docs/contract-gap.md'), md.join('\n') + '\n');
console.log('kinds (distinct):', k(result.ranking.full), '\nshared (5+):', k(shared), '\nemit:', by('emit').map((x) => x.selector + ' ' + x.themes).join(', '), '\nwants sidebar:', wantsSide.length);
