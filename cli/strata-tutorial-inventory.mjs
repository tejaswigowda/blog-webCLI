import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseHtml } from '../lib/html-tree.js';
import { ALLOWED_TAGS, tokenizeHtml } from '../lib/rawhtml.js';
import { escapeHtml } from '../lib/html.js';

const root = new URL('https://strataeditor.dev/about/tutorials/');
const input = process.argv[2];
const base = new URL(process.argv[3] || root);
if (!input) throw new Error('usage: strata-tutorial-inventory.mjs <legacy-tutorial-directory> | --verify [deployment-base]');
const fetchHtml = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
  if (!res.ok || !/^text\/html\b/i.test(res.headers.get('content-type') || '')) throw new Error(`${url}: expected HTML at the exact address, got ${res.status}`);
  return res.text();
};
if (input === '--verify') {
  const rows = JSON.parse(await readFile(new URL('../docs/strata-tutorial-inventory.json', import.meta.url), 'utf8'));
  for (const { url } of rows) {
    const target = new URL(new URL(url).pathname.split('/').at(-1), base);
    if (/<meta\b[^>]*http-equiv\s*=\s*['"]?refresh\b/i.test(await fetchHtml(target))) throw new Error(`${target}: a redirect stub is not a migrated tutorial`);
  }
  console.log(`${rows.length}/${rows.length} original tutorial addresses serve HTML directly`);
  process.exit(0);
}
const listed = new Set((await readdir(input)).filter((name) => /^[\w-]+\.html$/.test(name)));
const local = await Promise.all(['index.html', 'tutorials.json'].map((name) => readFile(path.join(input, name), 'utf8')));
for (const match of local[0].matchAll(/\bhref="([\w-]+\.html)(?:#[^"]*)?"/g)) listed.add(match[1]);
for (const { href } of JSON.parse(local[1])) if (/^[\w-]+\.html$/.test(href)) listed.add(href);
const tags = new Set(ALLOWED_TAGS);
const voids = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const summary = [];
for (const name of [...listed].sort()) {
  const url = new URL(name, base);
  const html = await fetchHtml(url);
  const rawTagRefusals = new Set();
  const rawAttributeRefusals = new Set();
  const embeds = [];
  function visit(node, inBody = false) {
    if (typeof node === 'string') return;
    const { tag, attrs } = node;
    if (tag === 'iframe' && attrs.src) {
      const src = new URL(attrs.src, new URL(name, root));
      const kind = /(?:^|\/)player(?:\/|$)/.test(src.pathname) ? 'player' : src.origin === root.origin && (src.pathname === '/' || src.hash.includes('repo=')) ? 'strata' : 'other';
      embeds.push({ kind, src: src.href, title: attrs.title || '' });
    }
    if (tag !== '#root' && tag !== 'body' && (inBody || ['style', 'script', 'svg'].includes(tag))) {
      if (!tags.has(tag)) rawTagRefusals.add(tag);
      for (const [key, val] of Object.entries(attrs)) {
        if (!tags.has(tag)) {
          if (key === 'style' || key.startsWith('on')) rawAttributeRefusals.add(`${tag}[${key}]`);
          continue;
        }
        try {
          tokenizeHtml(`<${tag} ${key}="${escapeHtml(val)}">${voids.has(tag) ? '' : `</${tag}>`}`);
        } catch {
          rawAttributeRefusals.add(`${tag}[${key}]`);
        }
      }
    }
    for (const child of node.children) visit(child, inBody || tag === 'body');
  }
  visit(parseHtml(html));
  summary.push({ url: new URL(name, root).href, rawTagRefusals: [...rawTagRefusals].sort(), rawAttributeRefusals: [...rawAttributeRefusals].sort(), embeds });
}
console.log(JSON.stringify(summary, null, 2));
