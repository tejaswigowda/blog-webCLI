// WordPress post HTML -> a Delta that markdown can express. Pure, with its own small tolerant HTML reader, so it
// runs the same in the browser and in Node. Only what the editor offers survives: paragraphs, headings (to level
// 3), bold, italic, strike, inline code, links, images, lists, quotes and code blocks. Everything else is reduced
// to its text, and counted in `notes` so the person importing is told what was flattened, not left to find out.
//
// opts: {
//   image(src, alt)  -> string | null   the asset reference (or address) an <img> becomes; null drops it
//   link(href)       -> string | null   the address a link becomes; null keeps the words and drops the link
//   attachment(id)   -> { url, alt } | null   a media-library file, for [gallery ids="…"]
// }
import { decodeEntities } from './xml.js';

const HTML_NAMED = {
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  ccedil: 'ç', ntilde: 'ñ', iexcl: '¡', iquest: '¿', frac12: '½', plusmn: '±', micro: 'µ', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003', zwnj: '', zwj: '',
};

export function decodeHtml(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#' || ['lt', 'gt', 'amp', 'quot', 'apos', 'nbsp'].includes(e)) return decodeEntities(m);
    return HTML_NAMED[e] ?? m;
  });
}

// ---------- reading HTML ----------
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'col', 'embed', 'param', 'track', 'base']);
const RAW = new Set(['script', 'style']);
const AUTOCLOSE = { p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'] };

export function parseHtml(src) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().children.push(src.slice(i));
      break;
    }
    if (lt > i) top().children.push(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const e = src.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(src.slice(lt, lt + 40));
    if (!m) {
      top().children.push('<');
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    let j = lt + m[0].length;
    const attrs = {};
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === '>') {
        j++;
        break;
      }
      if (src[j] === '/') {
        if (src[j + 1] === '>') {
          selfClose = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      const a = /^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(src.slice(j, j + 4000));
      if (!a) {
        j++;
        continue;
      }
      attrs[a[1].toLowerCase()] = decodeHtml(a[2] ?? a[3] ?? a[4] ?? '');
      j += a[0].length;
    }
    for (const closes of [AUTOCLOSE[tag]]) {
      if (closes && closes.includes(top().tag)) stack.pop();
    }
    const node = { tag, attrs, children: [] };
    top().children.push(node);
    if (RAW.has(tag) && !selfClose) {
      const e = src.toLowerCase().indexOf(`</${tag}`, j);
      const close = e < 0 ? n : src.indexOf('>', e);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (!VOID.has(tag) && !selfClose) stack.push(node);
    i = j;
  }
  return root;
}

// ---------- shortcodes and plain-text paragraphs ----------
const BLOCK_START = /^<(?:p|div|h[1-6]|ul|ol|li|blockquote|pre|table|figure|hr|iframe|section|article|aside|dl|form|details|center)\b/i;

// WordPress stores older posts as text with blank lines between paragraphs and adds the <p> tags when it shows
// them. Do the same, so a post that never had any comes out as paragraphs and not one long line.
export function autop(html) {
  if (/<p[\s>]/i.test(html)) return html;
  return html
    .split(/\n[ \t]*\n+/)
    .map((chunk) => {
      const t = chunk.trim();
      if (!t) return '';
      if (BLOCK_START.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

const SHORTCODE = /\[(\/?)([a-z_][\w-]*)((?:\s[^\]]*)?)\]/gi;

function shortcodeAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

// [caption] keeps its picture and words; [gallery] becomes its pictures; [embed]/[video]/[audio] become links;
// any other shortcode is dropped and named in the notes.
export function expandShortcodes(html, opts, note) {
  let out = html.replace(/\[embed\]\s*([^\[]*?)\s*\[\/embed\]/gi, (m, url) => `<p><a href="${url.replace(/"/g, '&quot;')}">${url}</a></p>`);
  out = out.replace(/\[gallery([^\]]*)\]/gi, (m, a) => {
    const ids = (shortcodeAttrs(a).ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    const pics = ids.map((id) => (opts.attachment ? opts.attachment(Number(id)) : null)).filter(Boolean);
    if (!pics.length) {
      note('a [gallery] whose pictures are not in the export was dropped');
      return '';
    }
    note('a [gallery] became a run of images');
    return pics.map((p) => `<p><img src="${p.url.replace(/"/g, '&quot;')}" alt="${(p.alt || '').replace(/"/g, '&quot;')}"></p>`).join('');
  });
  out = out.replace(/\[(video|audio)([^\]]*)\](?:\s*\[\/\1\])?/gi, (m, kind, a) => {
    const at = shortcodeAttrs(a);
    const src = at.src || at.mp4 || at.mp3 || at.m4a || at.webm || at.ogg;
    if (!src) return '';
    note(`a [${kind}] became a link`);
    return `<p><a href="${src.replace(/"/g, '&quot;')}">${kind === 'video' ? 'Video' : 'Audio'}</a></p>`;
  });
  // Square brackets are also ordinary text ("[sic]", "[citation needed]"): an unknown [name] is a shortcode only when
  // it carries attributes, has an underscore or hyphen, or is closed by [/name]; the known ones always are.
  const closers = new Set([...out.matchAll(/\[\/([a-z_][\w-]*)\]/gi)].map((m) => m[1].toLowerCase()));
  const codes = new Set(['caption', 'wp_caption']);
  return out.replace(SHORTCODE, (m, close, name, attrs) => {
    const n = name.toLowerCase();
    if (!close && !codes.has(n) && !(attrs.includes('=') || /[_-]/.test(n) || closers.has(n))) return m;
    if (close && !codes.has(n) && !closers.has(n)) return m;
    if (!close && !codes.has(n)) {
      codes.add(n);
      note(`the [${n}] shortcode was dropped`);
    }
    return '';
  });
}

// ---------- building the Delta ----------
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'form', 'button', 'select', 'option', 'textarea', 'input', 'head', 'title', 'meta', 'link', 'canvas', 'template']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'address', 'center', 'dl', 'dt', 'dd', 'fieldset', 'legend', 'details', 'summary', 'hgroup', 'figure', 'figcaption', 'body', 'html']);
const MEDIA = new Set(['iframe', 'video', 'audio', 'embed', 'object']);
const IMG_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i;

class Builder {
  constructor() {
    this.ops = [];
    this.line = [];
  }

  add(insert, attributes) {
    this.line.push(attributes && Object.keys(attributes).length ? { insert, attributes } : { insert });
  }

  text(str, attrs) {
    const s = str.replace(/[ \t\r\n\f\u00a0]+/g, ' ');
    if (!s) return;
    const last = this.line[this.line.length - 1];
    const prevEndsSpace = last && typeof last.insert === 'string' && last.insert.endsWith(' ');
    const v = prevEndsSpace && s.startsWith(' ') ? s.slice(1) : s;
    if (v) this.add(v, attrs);
  }

  flush(block) {
    const items = this.line;
    this.line = [];
    while (items.length && typeof items[0].insert === 'string' && !items[0].insert.trim()) items.shift();
    while (items.length && typeof items[items.length - 1].insert === 'string' && !items[items.length - 1].insert.trim()) items.pop();
    if (items.length && typeof items[0].insert === 'string') items[0] = { ...items[0], insert: items[0].insert.replace(/^\s+/, '') };
    const l = items.length - 1;
    if (l >= 0 && typeof items[l].insert === 'string') items[l] = { ...items[l], insert: items[l].insert.replace(/\s+$/, '') };
    if (!items.length) return;
    this.ops.push(...items);
    this.ops.push(block && Object.keys(block).length ? { insert: '\n', attributes: block } : { insert: '\n' });
  }

  codeLines(lines) {
    for (const l of lines) {
      if (l !== '') this.ops.push({ insert: l });
      this.ops.push({ insert: '\n', attributes: { 'code-block': true } });
    }
  }
}

const rawText = (node) => (typeof node === 'string' ? node : node.tag === 'br' ? '\n' : node.children.map(rawText).join(''));

export function htmlToDelta(html, opts = {}) {
  const notes = new Map();
  const note = (m) => notes.set(m, (notes.get(m) || 0) + 1);
  const prepared = expandShortcodes(autop(html || ''), opts, note);
  const tree = parseHtml(prepared);
  const b = new Builder();

  const blockOf = (c) => {
    if (c.header) return { header: c.header };
    if (c.inLi) return c.depth > 1 ? { list: c.list, indent: c.depth - 1 } : { list: c.list };
    if (c.quote) return { blockquote: true };
    return {};
  };
  const end = (c) => b.flush(blockOf(c));

  const walk = (node, c) => {
    if (typeof node === 'string') {
      b.text(decodeHtml(node), c.inline);
      return;
    }
    const t = node.tag;
    if (SKIP.has(t)) return;
    const kidsOf = (ctx = c) => node.children.forEach((k) => walk(k, ctx));
    const withInline = (extra) => ({ ...c, inline: { ...c.inline, ...extra } });
    if (/^h[1-6]$/.test(t)) {
      end(c);
      kidsOf({ ...c, header: Math.min(Number(t[1]), 3), inLi: false, quote: false });
      b.flush({ header: Math.min(Number(t[1]), 3) });
      return;
    }
    switch (t) {
      case 'strong':
      case 'b':
        return kidsOf(withInline({ bold: true }));
      case 'em':
      case 'i':
      case 'cite':
        return kidsOf(withInline({ italic: true }));
      case 's':
      case 'strike':
      case 'del':
        return kidsOf(withInline({ strike: true }));
      case 'code':
      case 'kbd':
      case 'tt':
      case 'samp':
        return kidsOf(withInline({ code: true }));
      case 'br':
        end(c);
        return;
      case 'hr':
        end(c);
        note('a horizontal rule was dropped');
        return;
      case 'img': {
        const src = node.attrs.src || node.attrs['data-src'] || node.attrs['data-lazy-src'] || '';
        if (!src || src.startsWith('data:')) return;
        const ref = opts.image ? opts.image(src, node.attrs.alt || '') : src;
        if (!ref) {
          note('an image that could not be brought across was dropped');
          return;
        }
        b.add({ image: ref }, node.attrs.alt ? { alt: node.attrs.alt } : undefined);
        return;
      }
      case 'a': {
        const href = (node.attrs.href || '').trim();
        const only = node.children.filter((k) => typeof k !== 'string' || k.trim());
        const imgOnly = only.length === 1 && typeof only[0] !== 'string' && only[0].tag === 'img';
        if (imgOnly && IMG_FILE.test(href)) return walk(only[0], c); // a picture linked to a bigger copy of itself: just the picture
        const to = href && !href.startsWith('#') && !/^(?:javascript|data|vbscript):/i.test(href) && opts.link ? opts.link(href) : null;
        if (!to && href && !href.startsWith('#')) note('a link that cannot be kept was reduced to its words');
        return kidsOf(to ? withInline({ link: to }) : c);
      }
      case 'ul':
      case 'ol': {
        end(c);
        const depth = (c.depth || 0) + 1;
        const list = t === 'ol' ? 'ordered' : 'bullet';
        kidsOf({ ...c, list, depth, inLi: false, quote: false, header: 0 });
        return;
      }
      case 'li':
        end(c);
        kidsOf({ ...c, inLi: true });
        end({ ...c, inLi: true });
        return;
      case 'blockquote':
        end(c);
        kidsOf({ ...c, quote: true });
        end({ ...c, quote: true });
        return;
      case 'pre': {
        end(c);
        const lines = rawText(node).replace(/\r/g, '').replace(/\n$/, '').split('\n');
        b.codeLines(lines);
        return;
      }
      case 'table':
        note('a table was flattened to lines of text');
        end(c);
        return kidsOf();
      case 'tr': {
        end(c);
        const cells = node.children.filter((k) => typeof k !== 'string' && (k.tag === 'td' || k.tag === 'th'));
        cells.forEach((cell, i) => {
          if (i) b.text(' | ', c.inline);
          walk(cell, c);
        });
        end(c);
        return;
      }
      case 'thead':
      case 'tbody':
      case 'tfoot':
      case 'td':
      case 'th':
      case 'caption':
        return kidsOf();
      default:
    }
    if (MEDIA.has(t)) {
      const src = node.attrs.src || (node.children.find((k) => typeof k !== 'string' && k.tag === 'source') || { attrs: {} }).attrs.src || node.attrs.data || '';
      const to = src && opts.link ? opts.link(src) : null;
      end(c);
      if (to) {
        let host = 'media';
        try {
          host = new URL(to).hostname.replace(/^www\./, '');
        } catch {
          /* a relative address: the word is enough */
        }
        b.add(t === 'iframe' || t === 'embed' ? `Embedded from ${host}` : t === 'audio' ? 'Audio' : 'Video', { link: to });
        end(c);
        note(`an embedded ${t} became a link`);
      } else note(`an embedded ${t} was dropped`);
      return;
    }
    if (BLOCKS.has(t)) {
      end(c);
      kidsOf();
      end(c);
      return;
    }
    kidsOf(); // span, font, u, mark, sub, sup, small, … : the words, without the dressing
  };

  const base = { inline: {}, list: 'bullet', depth: 0, inLi: false, quote: false, header: 0 };
  tree.children.forEach((k) => walk(k, base));
  b.flush({});
  return { ops: b.ops, notes: [...notes].map(([m, n]) => (n > 1 ? `${m} (×${n})` : m)) };
}
