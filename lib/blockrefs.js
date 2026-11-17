// The addresses a post names inside its tables and HTML blocks, so they are pinned, checked for provider hostnames and
// counted like the ones in its paragraphs. A block that is not allowed names nothing here: it is refused when the page is made.
import { markdownWidget, parseInline } from './markdown.js';
import { htmlBlockUrls, tokenizeHtml } from './rawhtml.js';

// -> [{ kind: 'image' | 'link', url }]
export function embedUrls(delta) {
  const out = [];
  for (const op of delta.ops || []) {
    const v = op.insert;
    if (!v || typeof v !== 'object') continue;
    if (v.mdtable && typeof v.mdtable === 'object') {
      const cells = [...(v.mdtable.head || []), ...(v.mdtable.rows || []).flat()];
      for (const cell of cells) {
        if (typeof cell !== 'string') continue;
        for (const o of parseInline(cell)) {
          if (o.insert && typeof o.insert === 'object' && typeof o.insert.image === 'string') out.push({ kind: 'image', url: o.insert.image });
          if (o.attributes && typeof o.attributes.link === 'string') out.push({ kind: 'link', url: o.attributes.link });
        }
      }
    } else if (typeof v.htmlblock === 'string') {
      const widget = markdownWidget(v.htmlblock);
      if (widget) {
        for (const nested of widget.delta.ops) {
          if (nested.insert && typeof nested.insert === 'object' && typeof nested.insert.image === 'string') out.push({ kind: 'image', url: nested.insert.image });
          if (nested.attributes && typeof nested.attributes.link === 'string') out.push({ kind: 'link', url: nested.attributes.link });
        }
        out.push(...embedUrls(widget.delta));
        continue;
      }
      try {
        const first = tokenizeHtml(v.htmlblock).find((token) => token.t === 'open');
        const isFrame = first?.tag === 'div' && first.attrs.some(([key, value]) => key === 'class' && value.split(/\s+/).includes('wc-embed'));
        for (const u of htmlBlockUrls(v.htmlblock)) out.push({ kind: isFrame ? 'embed' : u.tag === 'img' ? 'image' : 'link', url: u.url });
      } catch {
        /* not allowed: refused at render */
      }
    }
  }
  return out;
}
