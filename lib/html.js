// Delta -> HTML. Every character of source text is escaped; raw HTML in a post can
// never reach the output. URLs pass an allow-list or are refused/neutralised.
import { Refusal } from './errors.js';
import { assertSupported, normalizeForMarkdown, renderInline, toLines } from './delta.js';
import { isAssetRef, isSafeUrl, resolveAsset } from './assets.js';
import { videoLabel } from './video.js';
import { parseInline } from './markdown.js';
import { htmlBlockText, renderHtmlBlock } from './rawhtml.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const TAG = { bold: 'strong', italic: 'em', strike: 'del', code: 'code' };

// opts.resolve(ref) -> absolute URL, opts.resolveVideo(ref) -> player URL (both throw Refusal on failure)
// opts.strict: throw on unsafe URLs / unresolved assets; otherwise neutralise them.
// opts.contract: the markup contract of the theme ('blog-webcli-v1' or 'wordpress-classic').
export function deltaToHtml(delta, opts = {}) {
  const lines = toLines(normalizeForMarkdown(delta.ops).ops);
  assertSupported(lines);
  const strict = opts.strict !== false;
  const wp = opts.contract === 'wordpress-classic';

  const url = (u, what) => {
    if (!isSafeUrl(u)) {
      if (strict) throw new Refusal('unsafe-url', `${what} "${u}" uses a URL scheme that is not allowed`);
      return null;
    }
    if (isAssetRef(u)) {
      try {
        return opts.resolve(u);
      } catch (e) {
        if (strict) throw e;
        return null;
      }
    }
    return u;
  };

  const inline = (items) =>
    renderInline(items, {
      open: (t) => {
        if (t.k !== 'link') return `<${TAG[t.k]}>`;
        const href = url(t.v, 'link');
        if (href === null) return '<span class="unresolved">';
        const ext = /^https?:/i.test(href) ? ' rel="noopener noreferrer"' : '';
        return `<a href="${escapeHtml(href)}"${ext}>`;
      },
      close: (t) => {
        if (t.k !== 'link') return `</${TAG[t.k]}>`;
        return url(t.v, 'link') === null ? '</span>' : '</a>';
      },
      text: (s) => escapeHtml(s),
      embed: (it) => {
        const src = url(it.insert.image, 'image');
        const alt = escapeHtml((it.attributes && it.attributes.alt) || '');
        if (src === null) return `<span class="unresolved">[image unavailable: ${escapeHtml(it.insert.image)}]</span>`;
        return `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy">`;
      },
    });

  // The iframe is sandboxed and cross-origin; the link inside is the fallback with scripting off.
  const video = (ref) => {
    let src;
    try {
      src = opts.resolveVideo(ref);
    } catch (e) {
      if (strict) throw e;
      return `<p><span class="unresolved">[video unavailable: ${escapeHtml(ref)}]</span></p>`;
    }
    const label = escapeHtml(videoLabel(ref));
    const u = escapeHtml(src);
    const frame = `<iframe src="${u}" title="Video: ${label}" loading="lazy" allow="fullscreen" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`;
    const watch = `<a href="${u}" rel="noopener noreferrer">Watch: ${label}</a>`;
    if (wp) return `<figure class="wp-block-embed is-type-video wp-embed-aspect-16-9 wp-has-aspect-ratio video"><div class="wp-block-embed__wrapper">${frame}</div><figcaption class="wp-element-caption">${watch}</figcaption></figure>`;
    return `<figure class="video">${frame}<figcaption>${watch}</figcaption></figure>`;
  };

  // cells are inline markdown; alignment is the align attribute, which every browser and every theme draws without a class
  const table = (t) => {
    const cell = (tag, md, a) => `<${tag}${a ? ` align="${a}"` : ''}>${inline(parseInline(md))}</${tag}>`;
    const head = `<thead><tr>${t.head.map((c, i) => cell('th', c, t.align[i])).join('')}</tr></thead>`;
    const body = t.rows.length ? `<tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => cell('td', c, t.align[i])).join('')}</tr>`).join('')}</tbody>` : '';
    return wp ? `<figure class="wp-block-table"><table>${head}${body}</table></figure>` : `<table>${head}${body}</table>`;
  };

  const html = [];
  let k = 0;
  while (k < lines.length) {
    const { items, block } = lines[k];
    if (lines[k].mdtable) {
      html.push(table(items[0].insert.mdtable));
      k++;
    } else if (lines[k].htmlblock) {
      html.push(renderHtmlBlock(items[0].insert.htmlblock, { resolve: (r) => opts.resolve(r), strict }));
      k++;
    } else if (lines[k].video) {
      html.push(video(items[0].insert.video));
      k++;
    } else if (block['code-block'] !== undefined) {
      const lang = block['code-block'] === true ? '' : String(block['code-block']);
      const body = [];
      while (k < lines.length && lines[k].block['code-block'] !== undefined) {
        body.push(escapeHtml(lines[k].items.map((i) => (typeof i.insert === 'string' ? i.insert : '')).join('')));
        k++;
      }
      const cls = lang && /^[\w+#.-]+$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre${wp ? ' class="wp-block-code"' : ''}><code${cls}>${body.join('\n')}\n</code></pre>`);
    } else if (block.blockquote) {
      const ps = [];
      while (k < lines.length && lines[k].block.blockquote) ps.push(`<p>${inline(lines[k++].items)}</p>`);
      html.push(`<blockquote${wp ? ' class="wp-block-quote"' : ''}>${ps.join('')}</blockquote>`);
    } else if (block.list) {
      const stack = [];
      let out = '';
      while (k < lines.length && lines[k].block.list) {
        const b = lines[k].block;
        const lvl = Number(b.indent || 0);
        const type = b.list === 'ordered' ? 'ol' : 'ul';
        while (stack.length > lvl + 1) out += `</li></${stack.pop()}>`;
        if (stack.length === lvl + 1) {
          if (stack[lvl] !== type) {
            out += `</li></${stack.pop()}>`;
            out += `<${type}${wp ? ' class="wp-block-list"' : ''}>`;
            stack.push(type);
          } else out += '</li>';
        } else {
          out += `<${type}${wp ? ' class="wp-block-list"' : ''}>`;
          stack.push(type);
        }
        out += `<li>${inline(lines[k].items)}`;
        k++;
      }
      while (stack.length) out += `</li></${stack.pop()}>`;
      html.push(out);
    } else if (block.header) {
      html.push(`<h${block.header}${wp ? ' class="wp-block-heading"' : ''}>${inline(items)}</h${block.header}>`);
      k++;
    } else if (wp && items.length === 1 && typeof items[0].insert === 'object' && items[0].insert.image) {
      html.push(`<figure class="wp-block-image size-large">${inline(items)}</figure>`);
      k++;
    } else {
      html.push(`<p>${inline(items)}</p>`);
      k++;
    }
  }
  return html.join('\n');
}

// Plain text of a Delta, line per block (code included), for word counts and excerpts.
const cellText = (md) => parseInline(md).map((o) => (typeof o.insert === 'string' ? o.insert : '')).join('');

export function plainLines(delta) {
  return toLines(normalizeForMarkdown(delta.ops).ops).map((l) => {
    if (l.mdtable) {
      const t = l.items[0].insert.mdtable;
      return { text: [...t.head, ...t.rows.flat()].map(cellText).filter(Boolean).join(' ').trim(), block: {}, embed: true };
    }
    if (l.htmlblock) {
      let text = '';
      try {
        text = htmlBlockText(l.items[0].insert.htmlblock);
      } catch {
        /* a block that is not allowed is refused when the page is made; it has no words to count */
      }
      return { text, block: {}, embed: true };
    }
    return { text: l.items.map((i) => (typeof i.insert === 'string' ? i.insert : '')).join('').trim(), block: l.block };
  });
}

export function wordCount(delta) {
  return plainLines(delta)
    .map((l) => l.text)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function excerpt(delta, max = 160) {
  const ls = plainLines(delta).filter((l) => l.text);
  const pick = ls.find((l) => !l.embed && !Object.keys(l.block).length) || ls.find((l) => !l.embed && l.block['code-block'] === undefined);
  if (!pick) return '';
  const t = pick.text.replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.replace(/\s+\S*$/, '') + '…';
}

export { resolveAsset };
