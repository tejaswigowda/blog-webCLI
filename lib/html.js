// Delta -> HTML. Every character of source text is escaped; raw HTML in a post can
// never reach the output. URLs pass an allow-list or are refused/neutralised.
import { Refusal } from './errors.js';
import { IMAGE_LAYOUTS, assertSupported, normalizeForMarkdown, renderInline, toLines } from './delta.js';
import { isAssetRef, isSafeUrl, resolveAsset } from './assets.js';
import { videoLabel } from './video.js';
import { markdownWidget, parseInline } from './markdown.js';
import { canonHtml, htmlBlockText, renderHtmlBlock, tokenizeHtml } from './rawhtml.js';
import { renderMath } from './math-renderer.js';
import { linkRel } from './affiliate.js';
import { highlightedCode } from './code-highlight.js';
import { counterResolver } from './counters.js';

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
  const wp = String(opts.contract).startsWith('wordpress-classic'); // the family (lib/contracts.js isClassic)
  const resolveCounter = opts.counterState || counterResolver(opts.counters, opts.where);

  const url = (u, what) => {
    if (!isSafeUrl(u)) {
      if (strict) throw new Refusal('unsafe-url', `${what} "${u}" uses a URL scheme that is not allowed`);
      return null;
    }
    // "../<slug>/" means the post or page with that slug, wherever the blog's permalink puts it
    const to = opts.linkTo && what === 'link' ? /^\.\.\/([^/?#]+)\/?(#.*)?$/.exec(u) : null;
    if (to) {
      const at = opts.linkTo(to[1]);
      if (at) return `${at}${to[2] || ''}`;
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
        if (t.k === 'math') return '';
        if (t.k !== 'link') return `<${TAG[t.k]}>`;
        const href = url(t.v, 'link');
        if (href === null) return '<span class="unresolved">';
        const existing = !opts.htmlBlockSource && /^https?:/i.test(href) ? 'noopener noreferrer' : '';
        const rel = opts.htmlBlockSource ? '' : linkRel(t.v, existing, { base: opts.base, affiliates: opts.affiliates });
        return `<a href="${escapeHtml(href)}"${rel ? ` rel="${escapeHtml(rel)}"` : ''}>`;
      },
      close: (t) => {
        if (t.k === 'math') return '';
        if (t.k !== 'link') return `</${TAG[t.k]}>`;
        return url(t.v, 'link') === null ? '</span>' : '</a>';
      },
      text: (s, a) => a.math ? renderMath(s, { where: opts.where }) : escapeHtml(s),
      embed: (it) => {
        if (it.insert.hardbreak) return '<br>';
        if (it.insert.counter) return opts.htmlBlockSource ? it.insert.counter.source : `<span class="wc-count-${it.insert.counter.name}">${resolveCounter(it.insert.counter.name)}</span>`;
        const src = url(it.insert.image, 'image');
        const alt = escapeHtml((it.attributes && it.attributes.alt) || '');
        if (src === null) return `<span class="unresolved">[image unavailable: ${escapeHtml(it.insert.image)}]</span>`;
        const dims = isAssetRef(it.insert.image) && opts.dimensions ? opts.dimensions(it.insert.image) : null; // the box is reserved before the file loads
        const box = dims ? ` width="${dims.width}" height="${dims.height}"` : '';
        const layout = it.attributes && IMAGE_LAYOUTS.includes(it.attributes.layout) ? ` class="img-${it.attributes.layout}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${alt}"${layout}${box}${opts.htmlBlockSource ? '' : ' loading="lazy"'}>`;
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
    const watch = `<a href="${u}" rel="${escapeHtml(linkRel(src, 'noopener noreferrer', { base: opts.base, affiliates: opts.affiliates }))}">Watch: ${label}</a>`;
    if (wp) return `<figure class="wp-block-embed is-type-video wp-embed-aspect-16-9 wp-has-aspect-ratio video"><div class="wp-block-embed__wrapper">${frame}</div><figcaption class="wp-element-caption">${watch}</figcaption></figure>`;
    return `<figure class="video">${frame}<figcaption>${watch}</figcaption></figure>`;
  };

  // cells are inline markdown; alignment is the align attribute, which every browser and every theme draws without a class
  const table = (t) => {
    const cell = (tag, md, a) => `<${tag}${a ? ` align="${a}"` : ''}>${inline(parseInline(md, {}, [], { counters: !!opts.counters || !!opts.counterMode }))}</${tag}>`;
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
      const source = items[0].insert.htmlblock;
      const widget = markdownWidget(source, { counters: !!opts.counters || !!opts.counterMode });
      html.push(opts.htmlBlockSource ? source : widget ? `<div class="wc-markdown">${deltaToHtml(widget.delta, { ...opts, counterState: resolveCounter })}</div>` : renderHtmlBlock(source, { resolve: (r) => opts.resolve(r), strict, base: opts.base, affiliates: opts.affiliates, resolveCounter, counterMode: !!opts.counterMode || !!opts.counters }));
      k++;
    } else if (lines[k].video) {
      if (opts.htmlBlockSource) throw new Refusal('bad-html', 'Videos cannot go inside an HTML group. Select blocks without the video.');
      html.push(video(items[0].insert.video));
      k++;
    } else if (block['code-block'] !== undefined) {
      const lang = block['code-block'] === true ? '' : String(block['code-block']);
      const body = [];
      while (k < lines.length && lines[k].block['code-block'] !== undefined && (lines[k].block['code-block'] === true ? '' : String(lines[k].block['code-block'])) === lang) {
        body.push(lines[k].items.map((i) => (typeof i.insert === 'string' ? i.insert : '')).join(''));
        k++;
      }
      if (lang === 'math') {
        if (opts.htmlBlockSource) throw new Refusal('bad-html', 'Math cannot go inside an authored HTML group. Keep math outside the group.');
        html.push(renderMath(body.join('\n'), { display: true, where: opts.where }));
        continue;
      }
      const cls = lang && /^[\w+#.-]+$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : '';
      const code = body.join('\n');
      html.push(`<pre${wp ? ' class="wp-block-code"' : ''}><code${cls}>${opts.htmlBlockSource ? escapeHtml(code) : highlightedCode(code, lang)}\n</code></pre>`);
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
      html.push(`<p${block.para ? ` class="${block.para}"` : ''}>${inline(items)}</p>`);
      k++;
    }
  }
  return html.join('\n');
}

// Editor conversion: keep logical assets and omit derived attributes the HTML renderer adds back on publish.
export function deltaToHtmlGroup(delta, classNames) {
  const classes = classNames.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z_][\w-]*(?: [A-Za-z_][\w-]*)*$/.test(classes) || classes.length > 200) {
    throw new Refusal('bad-html', 'Enter space-separated class names without dots (letters, digits, _ and -; start with a letter or _). Maximum 200 characters.');
  }
  const lines = toLines(normalizeForMarkdown(delta.ops).ops);
  if (lines[0]?.block.indent) throw new Refusal('bad-html', 'Select the parent list item as well as its nested items.');
  const body = deltaToHtml(delta, { resolve: (r) => r, htmlBlockSource: true });
  const raw = `<div class="${escapeHtml(classes)}">\n${body}\n</div>`;
  const src = canonHtml(raw);
  if (src !== raw && /<pre[\s>]/i.test(raw)) throw new Refusal('bad-html', 'Code whitespace cannot be preserved in an HTML group. Keep this code block outside the group.');
  tokenizeHtml(src);
  return src;
}

// Plain text of a Delta, line per block (code included), for word counts and excerpts.
const cellText = (md, options, resolveCounter) => parseInline(md, {}, [], { counters: !!options.counters || !!options.counterMode }).map((o) => (typeof o.insert === 'string' && !o.attributes?.math ? o.insert : o.insert?.counter ? resolveCounter(o.insert.counter.name) : '')).join('');

export function plainLines(delta, options = {}) {
  const resolveCounter = options.counterState || counterResolver(options.counters, options.where);
  return toLines(normalizeForMarkdown(delta.ops).ops).flatMap((l) => {
    if (l.block['code-block'] === 'math') return { text: '', block: l.block };
    if (l.mdtable) {
      const t = l.items[0].insert.mdtable;
      return { text: [...t.head, ...t.rows.flat()].map((cell) => cellText(cell, options, resolveCounter)).filter(Boolean).join(' ').trim(), block: {}, embed: true };
    }
    if (l.htmlblock) {
      let text = '';
      try {
        const source = l.items[0].insert.htmlblock;
        const widget = markdownWidget(source, { counters: !!options.counters || !!options.counterMode });
        if (widget) return plainLines(widget.delta, { ...options, counterState: resolveCounter });
        text = htmlBlockText(source, resolveCounter, !!options.counterMode || !!options.counters);
      } catch (error) {
        if (error instanceof Refusal && (options.counters || options.counterMode || ['undeclared-counter', 'bad-counter'].includes(error.code))) throw error;
        /* a block that is not allowed is refused when the page is made; it has no words to count */
      }
      return { text, block: {}, embed: true };
    }
    return { text: l.items.map((i) => (typeof i.insert === 'string' && !i.attributes?.math ? i.insert : i.insert.counter ? resolveCounter(i.insert.counter.name) : i.insert.hardbreak ? ' ' : '')).join('').trim(), block: l.block };
  });
}

export function wordCount(delta, options) {
  return plainLines(delta, options)
    .map((l) => l.text)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function excerpt(delta, max = 160, options) {
  const ls = plainLines(delta, options).filter((l) => l.text);
  const pick = ls.find((l) => !l.embed && !Object.keys(l.block).length) || ls.find((l) => !l.embed && l.block['code-block'] === undefined);
  if (!pick) return '';
  const t = pick.text.replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.replace(/\s+\S*$/, '') + '…';
}

export { resolveAsset };
