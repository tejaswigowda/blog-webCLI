import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/blog.js';
import { newFront, joinFile } from '../lib/frontmatter.js';
import { parseHtml } from '../lib/html-tree.js';
import { decodeHtml } from '../lib/html-entities.js';
import { escapeHtml, deltaToHtml } from '../lib/html.js';
import { ALLOWED_TAGS, canonHtml, tokenizeHtml } from '../lib/rawhtml.js';
import { deltaToMarkdownChecked, mdToDelta } from '../lib/markdown.js';
import { htmlToDelta } from '../lib/wp-html.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';
import { nativeTutorialProse } from './strata-native-prose.mjs';
import { widgetHtml } from '../lib/widget-markup.js';

const REPO = 'tejaswigowda/strata-editor';
const FOLDER = 'docs/about/tutorials';
const DOMAIN = 'https://strataeditor.dev/about/tutorials';
const allowed = new Set(ALLOWED_TAGS);
const voids = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sri = (text) => `sha384-${createHash('sha384').update(text).digest('base64')}`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i;

export function tutorialSource(html, { name, title, cssRules, changes }) {
  const interior = main.exec(html)?.[1];
  if (!interior) throw new Error(`${name}: missing main`);
  const serialize = (node) => {
    if (typeof node === 'string') return escapeHtml(decodeHtml(node)).replaceAll('\n', '&#10;');
    let tag = node.tag;
    const attrs = { ...node.attrs };
    if (tag === 'a' && attrs.class === 'anchor') return '';
    if (/^h[1-3]$/.test(tag) && node.children.some((n) => n.tag === 'a' && n.attrs.class === 'anchor')) {
      delete attrs.id;
      node = { ...node, children: node.children.filter((n) => !(n.tag === 'a' && n.attrs.class === 'anchor')) };
      if (typeof node.children.at(-1) === 'string') node.children[node.children.length - 1] = node.children.at(-1).trimEnd();
    }
    if (tag === 'style') return '';
    if (tag === 'iframe' || tag === 'video') {
      const source = tag === 'iframe' ? attrs.src : node.children.find((n) => n.tag === 'source')?.attrs.src;
      if (!source) throw new Error(`${name}: ${tag} has no source`);
      const href = new URL(source, `${DOMAIN}/${name}`).href;
      const label = attrs.title || `${title}: ${tag === 'iframe' ? 'interactive example' : 'video demonstration'}`;
      const cls = tag === 'iframe' ? 'wc-embed' : 'wc-video';
      changes.push(`${tag} converted to ${cls}: ${href}`);
      return widgetHtml({ type: tag === 'iframe' ? 'embed' : 'native-video', title: label, url: href });
    }
    if (tag === 'footer') {
      tag = 'div';
      attrs.class = [attrs.class, 'tutorial-footer'].filter(Boolean).join(' ');
    }
    if (tag === 'nav') {
      tag = 'div';
      changes.push('Section jump navigation retained as a labelled div');
    }
    if (tag === 'var') {
      tag = 'em';
      changes.push('Mathematical variable retained as italic emphasis');
    }
    if (!allowed.has(tag)) throw new Error(`${name}: unsupported <${tag}>`);
    if (attrs.style !== undefined) {
      const className = `legacy-style-${cssRules.length + 1}`;
      cssRules.push(`.${className}{${attrs.style}}`);
      attrs.class = [attrs.class, className].filter(Boolean).join(' ');
      delete attrs.style;
    }
    for (const attr of ['loading', 'target', 'tabindex', 'download']) {
      if (attrs[attr] === undefined) continue;
      if (attr !== 'loading') changes.push(`<${tag}> ${attr} removed; destination and content retained`);
      delete attrs[attr];
    }
    for (const attr of ['href', 'src']) {
      if (!attrs[attr] || attrs[attr].startsWith('#')) continue;
      attrs[attr] = new URL(attrs[attr], `${DOMAIN}/${name}`).href;
    }
    const open = `<${tag}${Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('')}>`;
    return voids.has(tag) ? open : `${open}${node.children.map(serialize).join('')}</${tag}>`;
  };
  const blocks = parseHtml(interior).children.filter((n) => typeof n !== 'string' || n.trim()).map((node) => {
    const block = canonHtml(serialize(node));
    if (block) tokenizeHtml(block);
    return block;
  }).filter(Boolean);
  let body = nativeTutorialProse(blocks.join('\n\n') + '\n').body;
  // Code's final newline is supplied by the native renderer; all other code bytes must agree.
  const originalOps = mdToDelta(body).ops;
  const ops = originalOps.flatMap((op, index) => {
    const raw = op.insert.htmlblock;
    if (!raw?.startsWith('<pre><code>')) return [op];
    if ([originalOps[index - 1], originalOps[index + 1]].some((adjacent) => adjacent?.insert.htmlblock?.startsWith('<pre'))) return [op];
    const candidate = htmlToDelta(raw);
    if (candidate.notes.length) return [op];
    const { delta } = deltaToMarkdownChecked(candidate);
    const original = parseHtml(raw).children[0];
    const rendered = parseHtml(deltaToHtml(delta)).children[0];
    const text = (node) => node.children.map((n) => typeof n === 'string' ? decodeHtml(n) : text(n)).join('');
    if (!original || !rendered || rendered.tag !== 'pre' || text(original).replace(/\n$/, '') !== text(rendered).replace(/\n$/, '')) return [op];
    return delta.ops;
  });
  body = deltaToMarkdownChecked({ ops }).md;
  return `<div class="strata-tutorial-${name.slice(0, -5)}"></div>\n\n${body}`;
}

export async function prepareTutorialSite(root, sourceRef) {
  const folder = path.join(root, FOLDER);
  if (!sourceRef && (await readdir(folder)).includes('blog.json')) throw new Error('Already migrated: edit pages/ directly, or provide the original legacy commit to --prepare explicitly.');
  sourceRef ||= git(root, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(sourceRef)) throw new Error('legacy source ref must be a full committed SHA');
  const inventory = JSON.parse(await readFile(new URL('../docs/strata-tutorial-inventory.json', import.meta.url), 'utf8'));
  const catalogue = JSON.parse(await readFile(path.join(folder, 'tutorials.json'), 'utf8'));
  const themeDir = path.join(folder, 'theme');
  await mkdir(themeDir, { recursive: true });
  await mkdir(path.join(folder, 'pages'), { recursive: true });
  let css = '';
  const report = [];
  let indexScript = '';
  for (const row of inventory) {
    const name = new URL(row.url).pathname.split('/').at(-1);
    const html = execFileSync('git', ['-C', root, 'show', `${sourceRef}:${FOLDER}/${name}`], { encoding: 'utf8' });
    const entry = catalogue.find((e) => e.href === name);
    const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1].replace(/ <a class="anchor"[\s\S]*?<\/a>/g, '');
    if (!heading || /</.test(heading)) throw new Error(`${name}: cannot derive title`);
    const title = decodeHtml(heading);
    const cssRules = [];
    const changes = [];
    const body = tutorialSource(html, { name, title, cssRules, changes });
    const slug = name === 'index.html' ? 'home' : name.slice(0, -5);
    const meta = { slug, title, status: 'published', description: entry?.desc || 'Step-by-step Strata tutorials.' };
    if (entry?.thumb) {
      if (!entry.thumb.startsWith('screenshots/')) throw new Error(`${name}: unexpected thumbnail path`);
      meta.image = `asset:images/${entry.thumb.slice('screenshots/'.length)}`;
    }
    await writeFile(path.join(folder, 'pages', `${slug}.md`), joinFile(newFront(meta), body));
    const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    // Generated section anchors must not inherit the card's stretched-link overlay.
    css += `\nhtml:has(.strata-tutorial-${name.slice(0, -5)}){\n${[...styles, ...cssRules].join('\n').replace(/:root\b/g, '&').replace(/\bfooter\b/g, '.tutorial-footer').replaceAll('.card h3 a::after', '.card h3 a:not(.anchor)::after')}\n}\n`;
    report.push({ name, source: `pages/${slug}.md`, changes: [...new Set(changes)] });
    if (name === 'index.html') {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
      if (scripts.length !== 1) throw new Error('index.html: expected one search enhancement');
      indexScript = scripts[0][1].replace("const list = document.getElementById( 'list' );", "const list = document.getElementById( 'list' );\n\tif ( ! list ) return;");
    }
  }
  css += '\n' + await readFile(path.join(folder, 'highlight.css'), 'utf8');
  css += `
html{--width:800px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:auto}
main>.hentry,main>.entry-content.home{display:contents}
main>.hentry>.entry-header,.entry-content>.strata-marker,.strata-tutorial-index{display:none}
main>.hentry>.entry-content{margin:0;padding:0;max-width:none}
main>.hentry>.entry-content>div[class^="strata-tutorial-"]{display:none}
.entry-content.home{margin:0;padding:0}
.wc-embed{margin:0}
.wc-embed iframe{aspect-ratio:auto}
.wc-video{margin:0}
.wc-video video{max-width:100%}
`;
  const theme = {
    name: 'Strata tutorials', version: '1.0.0', licence: 'MIT',
    source: 'https://github.com/tejaswigowda/strata-editor',
    description: 'First-party Strata tutorial layout; original page styles scoped by tutorial.',
    class_contract: 'wordpress-classic', css: ['tutorials.css'], skeleton: 'skeleton.html',
  };
  await writeFile(path.join(themeDir, 'theme.json'), json(theme));
  await writeFile(path.join(themeDir, 'tutorials.css'), css);
  await writeFile(path.join(themeDir, 'skeleton.html'), '<main>{{content}}</main>\n');
  await writeFile(path.join(themeDir, 'LICENSE'), `MIT License

Copyright (c) 2026 Strata contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
  const brand = (await readFile(path.join(root, 'docs/about/brand.js'), 'utf8'))
    .replace("const here = new URL( '.', script.src );", "const here = new URL( 'https://strataeditor.dev/about/' );");
  await writeFile(path.join(folder, 'tutorial-enhancements.js'), `${brand}\n${indexScript}`);
  await writeFile(path.join(folder, 'migration.json'), json({
    root: `${REPO}/${FOLDER}`, domain: DOMAIN, sourceRef, pages: report,
    previousSource: 'tutorial-source', themeLicence: 'MIT',
  }));
  return report;
}

export async function buildTutorialSite(root, ref, { check = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(ref || '')) throw new Error('theme/script ref must be a full committed SHA');
  const folder = path.join(root, FOLDER);
  const theme = JSON.parse(await readFile(path.join(folder, 'theme/theme.json'), 'utf8'));
  const themeFiles = {};
  for (const file of themeFilePaths(theme)) themeFiles[file] = await readFile(path.join(folder, 'theme', file), 'utf8');
  const pin = pinFor(`${REPO}/${FOLDER}/theme`, ref, theme, themeDigest(themeFiles, themeFilePaths(theme)));
  const script = await readFile(path.join(folder, 'tutorial-enhancements.js'), 'utf8');
  const highlight = await readFile(path.join(folder, 'highlight.js'), 'utf8');
  const cdn = `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/${FOLDER}`;
  const initialBlog = {
    schemaVersion: 1, title: 'Strata tutorials', author: 'Strata',
    description: 'Step-by-step walkthroughs for building scenes, games, animation and characters with Strata.',
    domain: DOMAIN, repo: `${REPO}/${FOLDER}`, pagePermalink: '/{slug}.html',
    search: true, stylesheet: 'linked', theme: pin,
    assets: {
      base: 'https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}',
      repos: { images: `${REPO}/${FOLDER}/screenshots`, site: `${REPO}/docs` },
    },
    favicon: 'asset:site/favicon.svg', cover: 'asset:site/demo.png',
    scripts: [
      { src: `${cdn}/highlight.js`, integrity: sri(highlight) },
      { src: `${cdn}/tutorial-enhancements.js`, integrity: sri(script) },
    ],
  };
  const blog = check ? JSON.parse(await readFile(path.join(folder, 'blog.json'), 'utf8')) : initialBlog;
  const posts = [];
  const lock = (await readdir(folder)).includes('assets.lock.json') ? JSON.parse(await readFile(path.join(folder, 'assets.lock.json'), 'utf8')) : {};
  for (const key of ['site/favicon.svg', 'site/demo.png']) lock[key] ||= ref;
  for (const name of (await readdir(path.join(folder, 'pages'))).filter((n) => n.endsWith('.md')).sort()) {
    const text = await readFile(path.join(folder, 'pages', name), 'utf8');
    posts.push({ path: `pages/${name}`, text });
    for (const match of text.matchAll(/asset:images\/([^\s"'<>]+)/g)) lock[`images/${match[1]}`] ||= ref;
  }
  const site = buildSite({ blog, posts, lock, theme: loadTheme(pin, themeFiles) });
  if (site.errors.length) throw new AggregateError(site.errors, site.errors.map((e) => e.message).join('\n'));
  const inventory = JSON.parse(await readFile(new URL('../docs/strata-tutorial-inventory.json', import.meta.url), 'utf8'));
  for (const { url } of inventory) {
    const file = new URL(url).pathname.split('/').at(-1);
    if (!site.files[file] || /http-equiv="refresh"/i.test(site.files[file])) throw new Error(`missing direct output: ${file}`);
  }
  const files = { 'blog.json': json(blog), 'assets.lock.json': json(lock), ...site.files };
  for (const [file, text] of Object.entries(files)) {
    if (check) {
      if (await readFile(path.join(folder, file), 'utf8') !== text) throw new Error(`stale output: ${file}`);
    } else {
      await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
      await writeFile(path.join(folder, file), text);
    }
  }
  return { pages: posts.length, outputs: Object.keys(files).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, mode, ref] = process.argv.slice(2);
  if (!root || !['--prepare', '--build', '--check'].includes(mode)) throw new Error('usage: strata-tutorial-site.mjs <Strata checkout> <--prepare|--build|--check> [theme/script commit]');
  const pin = ref || (mode === '--check' ? JSON.parse(await readFile(path.join(root, FOLDER, 'blog.json'), 'utf8')).theme.ref : git(root, 'rev-parse', 'HEAD'));
  const result = mode === '--prepare' ? await prepareTutorialSite(root, ref) : await buildTutorialSite(root, pin, { check: mode === '--check' });
  console.log(json(result));
}
