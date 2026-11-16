import { escapeHtml as esc } from './html.js';
import { decodeHtml as decode } from './html-entities.js';

const HEADING = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g;
const ANCHOR = /<a\b[^>]*class="(?:[^"]*\s)?anchor(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/a>/g;

// Pure generation, shared by the reader and publisher; source Markdown is never changed.
export function headingNavigation(html, { contents = false } = {}) {
  const used = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1])));
  const entries = [];
  const body = html.replace(HEADING, (all, level, attrs, inner) => {
    const labelHtml = inner.replace(ANCHOR, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const label = decode(labelHtml);
    const had = /\sid="([^"]*)"/.exec(attrs);
    let id = had && decode(had[1]);
    if (!id) {
      const base = label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
      id = base;
      for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
      used.add(id);
      attrs += ` id="${esc(id)}"`;
    }
    if (level === '2' || level === '3') entries.push({ id, labelHtml });
    const anchor = /<a\b[^>]*class="(?:[^"]*\s)?anchor(?:\s[^"]*)?"/.test(inner) ? '' : ` <a class="anchor" href="#${esc(id)}" aria-label="Link to this section">#</a>`;
    return `<h${level}${attrs}>${inner}${anchor}</h${level}>`;
  });
  if (contents !== true || entries.length < 3 || /<(?:nav|div)\b[^>]*class="(?:[^"]*\s)?toc(?:\s[^"]*)?"/.test(body)) return body;
  const links = entries.map((e) => `<li><a href="#${esc(e.id)}">${e.labelHtml}</a></li>`).join('');
  return `<nav class="toc" aria-label="Contents"><p class="toc-title">Contents</p><ol>${links}</ol></nav>\n${body}`;
}
