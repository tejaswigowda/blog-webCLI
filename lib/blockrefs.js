// The addresses a post names inside its tables and HTML blocks, so they are pinned, checked for provider hostnames and
// counted like the ones in its paragraphs. A block that is not allowed names nothing here: it is refused when the page is made.
import { parseInline } from './markdown.js';
import { htmlBlockUrls } from './rawhtml.js';

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
      try {
        for (const u of htmlBlockUrls(v.htmlblock)) out.push({ kind: u.tag === 'img' ? 'image' : 'link', url: u.url });
      } catch {
        /* not allowed: refused at render */
      }
    }
  }
  return out;
}
