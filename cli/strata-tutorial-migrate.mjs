import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSite, parsePost, renderPost } from '../lib/blog.js';
import { joinFile, newFront, splitFile } from '../lib/frontmatter.js';
import { parseHtml } from '../lib/html-tree.js';
import { escapeHtml } from '../lib/html.js';
import { canonHtml, tokenizeHtml, ALLOWED_TAGS } from '../lib/rawhtml.js';
import { decodeHtml } from '../lib/html-entities.js';
import { nativeTutorialProse, sameTutorialMarkup } from './strata-native-prose.mjs';

const [root, mode] = process.argv.slice(2);
if (!root || !['--stage', '--check', '--native'].includes(mode)) throw new Error('usage: strata-tutorial-migrate.mjs <Strata repository> <--stage|--check|--native>');
const staging = mode === '--stage';
const inventory = JSON.parse(await readFile(new URL('../docs/strata-tutorial-inventory.json', import.meta.url), 'utf8'));
const sourceDir = path.join(root, 'tutorial-source');
const legacyRoot = path.join(root, 'docs/about/tutorials');
const blog = !staging ? JSON.parse(await readFile(path.join(sourceDir, 'blog.json'), 'utf8')) :
  { schemaVersion: 1, title: 'Strata tutorials', author: 'Strata', description: 'Hands-on Strata tutorials', domain: 'https://strataeditor.dev', pagePermalink: '/{slug}.html' };
const allowed = new Set(ALLOWED_TAGS);
const voids = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const input = (slug, title, parent, body) => ({
  path: `pages/${slug}.md`,
  text: joinFile(newFront({ slug, title, ...(parent ? { parent } : {}), status: 'published' }), body),
});
const required = !staging ? await Promise.all(['pages/about.md', 'pages/tutorials.md']
  .map(async (name) => ({ path: name, text: await readFile(path.join(sourceDir, name), 'utf8') }))) :
  [input('about', 'About', null, 'About Strata.\n'), input('tutorials', 'Tutorials', 'about', 'Strata tutorials.\n')];
const stage = [];
const main = /(<main\b[^>]*>)([\s\S]*?)(<\/main>)/i;
const footer = /<footer\b[^>]*>[\s\S]*?<\/footer>/i;
const style = /<style>(\.credits\{[\s\S]*?)<\/style>/i;

function writeNode(node) {
  if (typeof node === 'string') return node.replace(/>/g, '&gt;').replaceAll('\n', '&#10;');
  if (!allowed.has(node.tag)) throw new Error(`unsupported <${node.tag}>`);
  const attrs = Object.entries(node.attrs).filter(([k]) => !(node.tag === 'img' && k === 'loading')).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  const open = `<${node.tag}${attrs}>`;
  return voids.has(node.tag) ? open : `${open}${node.children.map(writeNode).join('')}</${node.tag}>`;
}

const manifestPath = path.join(sourceDir, 'migration.json');
const existing = !staging ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
const retained = existing?.retained || [];
for (const row of inventory) {
  const name = new URL(row.url).pathname.split('/').at(-1);
  const filename = path.join(legacyRoot, name);
  const original = await readFile(filename, 'utf8');
  if (existing && !existing.staged.includes(name)) continue;
  const reason = name === 'index.html' ? 'existing interactive index' : row.embeds.length ? 'existing interactive embed (sandbox parity not established)' : row.rawTagRefusals.includes('video') ? 'existing native video' : null;
  if (reason) { retained.push({ name, reason }); continue; }
  const interior = main.exec(original)?.[2];
  if (!interior) throw new Error(`${name}: missing main`);
  const slug = name.slice(0, -5);
  try {
    let source;
    if (staging) {
      const parsed = parseHtml(interior.replace(footer, '').replace(style, ''));
      const heading = parsed.children.find((n) => n.tag === 'h1');
      if (!heading || heading.children.some((n) => typeof n !== 'string')) throw new Error('cannot derive a plain tutorial title');
      const blocks = parsed.children.filter((n) => typeof n !== 'string' || n.trim()).map((n) => {
        const block = canonHtml(writeNode(n));
        tokenizeHtml(block);
        return block;
      });
      source = input(slug, decodeHtml(heading.children.join('')).trim(), 'tutorials', `${blocks.join('\n\n')}\n`);
    } else {
      source = { path: `pages/${slug}.md`, text: await readFile(path.join(sourceDir, `pages/${slug}.md`), 'utf8') };
    }
    let converted = 0;
    if (mode !== '--check') {
      const { front, body } = splitFile(source.text, source.path);
      const native = nativeTutorialProse(body);
      converted = native.converted;
      if (converted) source.text = joinFile(front, native.body);
    }
    stage.push({ source, original, filename, name, converted });
  } catch (e) {
    if (!staging) throw e;
    retained.push({ name, reason: e.message });
  }
}
const result = buildSite({ blog, lock: {}, posts: [...required, ...stage.map(({ source }) => source)] });
if (result.errors.length) throw new AggregateError(result.errors, result.errors.map((e) => e.message).join('\n'));
const writes = [];
for (const { source, original, filename, name, converted } of stage) {
  const parsed = parsePost(source);
  const address = `about/tutorials/${name}`;
  if (!result.files[address]) throw new Error(`generator did not preserve ${address}`);
  const rendered = renderPost(blog, parsed, {}, { pagePath: address }).bodyHtml;
  const chromeFooter = footer.exec(main.exec(original)[2])?.[0] || '';
  let html = original.replace(main, (_, open, _body, close) => `${open}\n${rendered}\n${chromeFooter}\n${close}`);
  const creditsCss = style.exec(main.exec(original)[2])?.[0];
  if (creditsCss) html = html.replace('</head>', `${creditsCss}\n</head>`);
  if (mode === '--check') {
    if (html !== original) throw new Error(`${name}: generated tutorial is stale`);
  } else if (mode === '--native' && !sameTutorialMarkup(original, html)) {
    throw new Error(`${name}: native conversion would change the published markup`);
  } else if (staging || converted) {
    writes.push([path.join(sourceDir, source.path), source.text], [filename, html]);
  }
}
if (staging) await mkdir(path.join(sourceDir, 'pages'), { recursive: true });
for (const [file, text] of writes) await writeFile(file, text);
if (staging) {
  for (const page of required) await writeFile(path.join(sourceDir, page.path), page.text);
  await writeFile(path.join(sourceDir, 'blog.json'), JSON.stringify(blog, null, 2) + '\n');
  await writeFile(manifestPath, JSON.stringify({ staged: stage.map(({ name }) => name), retained }, null, 2) + '\n');
}
console.log(JSON.stringify({ staged: stage.map(({ name }) => name), retained,
  ...(mode === '--native' ? { convertedBlocks: stage.reduce((sum, row) => sum + row.converted, 0) } : {}),
}, null, 2));
