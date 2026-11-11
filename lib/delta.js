// Delta helpers. A Delta here is { ops: [{ insert, attributes? }] } — the shape Quill
// produces and consumes. It is only ever a *view*: markdown is the format of record.
import { Refusal } from './errors.js';
import { VIDEO_REF, isVideoRef } from './video.js';

export const INLINE_ORDER = ['link', 'bold', 'italic', 'strike', 'code'];
export const BLOCK_ATTRS = ['header', 'blockquote', 'list', 'indent', 'code-block', 'para'];
// a paragraph style is one of a closed set of classes the theme styles: a lead paragraph, or small print
export const PARA_STYLES = ['lead', 'small'];
// Embeds that stand alone as a line of their own, with no trailing newline in the Delta: a video, a table (cells are inline
// markdown) and a block of raw HTML (see lib/rawhtml.js). A line made of one carries a flag named for it.
export const BLOCK_EMBEDS = ['video', 'mdtable', 'htmlblock'];
export const embedKind = (insert) => (insert && typeof insert === 'object' ? BLOCK_EMBEDS.find((k) => k in insert) : undefined);
export const isEmbedLine = (line) => !!(line.video || line.mdtable || line.htmlblock);
const INLINE_OK = new Set([...INLINE_ORDER, 'alt']);
const BLOCK_OK = new Set(BLOCK_ATTRS);

export function cleanAttrs(attrs) {
  const out = {};
  for (const k of Object.keys(attrs || {}).sort()) {
    let v = attrs[k];
    if (v === undefined || v === null || v === false || v === '') continue;
    if (k === 'indent' && (v === 0 || v === '0')) continue;
    if (k === 'code-block' && v === 'plain') v = true;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function attrsEqual(a, b) {
  return JSON.stringify(cleanAttrs(a) || null) === JSON.stringify(cleanAttrs(b) || null);
}

// Merge adjacent text ops with equal attributes — the form Quill itself emits.
export function canon(ops) {
  const out = [];
  for (const op of ops || []) {
    const attributes = cleanAttrs(op.attributes);
    if (typeof op.insert === 'string') {
      if (op.insert === '') continue;
      const last = out[out.length - 1];
      if (last && typeof last.insert === 'string' && attrsEqual(last.attributes, attributes)) {
        last.insert += op.insert;
        continue;
      }
      out.push(attributes ? { insert: op.insert, attributes } : { insert: op.insert });
    } else {
      out.push(attributes ? { insert: op.insert, attributes } : { insert: op.insert });
    }
  }
  return out;
}

export function deltaEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function split(attrs) {
  const inline = {};
  const block = {};
  for (const [k, v] of Object.entries(attrs || {})) (BLOCK_OK.has(k) ? block : inline)[k] = v;
  return { inline, block };
}

// Delta -> lines: [{ items: [{insert, attributes?}], block: {} }]
export function toLines(ops) {
  const lines = [];
  let cur = [];
  for (const op of canon(ops)) {
    const { inline, block } = split(op.attributes);
    if (typeof op.insert === 'string') {
      const parts = op.insert.split('\n');
      parts.forEach((part, i) => {
        if (part !== '') {
          if (Object.keys(block).length) {
            throw new Refusal('lossy-round-trip', 'block formatting attached to text rather than a line break');
          }
          cur.push(cleanOp(part, inline));
        }
        if (i < parts.length - 1) {
          for (const k of Object.keys(inline)) if (!INLINE_OK.has(k)) bad(`"${k}" formatting`);
          lines.push({ items: cur, block: cleanAttrs(block) || {} });
          cur = [];
        }
      });
    } else if (embedKind(op.insert)) {
      // A block embed is a line of its own and has no trailing newline in the Delta.
      if (cur.length) lines.push({ items: cur, block: {} });
      cur = [];
      lines.push({ items: [cleanOp(op.insert, inline)], block: {}, [embedKind(op.insert)]: true });
    } else {
      cur.push(cleanOp(op.insert, inline));
    }
  }
  if (cur.length) lines.push({ items: cur, block: {} });
  return lines;
}

function cleanOp(insert, attrs) {
  const a = cleanAttrs(attrs);
  return a ? { insert, attributes: a } : { insert };
}

export function assertSupported(lines) {
  for (const line of lines) {
    for (const k of Object.keys(line.block)) {
      const v = line.block[k];
      if (k === 'header' && ![1, 2, 3, 4].includes(Number(v))) bad(`heading level ${v}`);
      if (k === 'para' && !PARA_STYLES.includes(v)) bad(`paragraph style "${v}"`);
      if (k === 'list' && v !== 'ordered' && v !== 'bullet') bad(`list type "${v}"`);
      if (k === 'indent' && !(Number.isInteger(Number(v)) && Number(v) > 0)) bad(`indent ${v}`);
      if (k === 'indent' && line.block.list === undefined) bad('indent outside a list');
    }
    if (line.block['code-block'] !== undefined && Object.keys(line.block).length > 1) {
      bad('code block combined with other block formatting');
    }
    if (line.block.header && Object.keys(line.block).length > 1) bad('heading combined with other block formatting');
    if (line.block.para && Object.keys(line.block).length > 1) bad('paragraph style combined with other block formatting');
    for (const it of line.items) {
      for (const k of Object.keys(it.attributes || {})) {
        if (!INLINE_OK.has(k)) bad(`"${k}" formatting`);
      }
      if (line.video) {
        const keys = Object.keys(it.insert);
        if (keys.length !== 1 || !VIDEO_REF.test(it.insert.video) || it.attributes) bad('a video that is not a video: reference');
      } else if (line.mdtable) {
        if (Object.keys(it.insert).length !== 1 || it.attributes) bad('a table with formatting attached');
        assertTable(it.insert.mdtable);
      } else if (line.htmlblock) {
        if (Object.keys(it.insert).length !== 1 || it.attributes || typeof it.insert.htmlblock !== 'string' || it.insert.htmlblock.trim() === '') bad('an HTML block that is not text');
      } else if (typeof it.insert !== 'string') {
        const keys = Object.keys(it.insert);
        if (keys.length !== 1 || keys[0] !== 'image' || typeof it.insert.image !== 'string') {
          bad(`embed "${keys.join(',')}"`);
        }
        if (isVideoRef(it.insert.image)) bad('a video reference inside a paragraph (it must stand alone)');
      } else if (it.attributes && 'alt' in it.attributes) {
        bad('alt text on text');
      }
    }
  }
}

const ALIGNS = ['', 'left', 'right', 'center'];
function assertTable(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.head) || !Array.isArray(t.align) || !Array.isArray(t.rows) || Object.keys(t).length !== 3) bad('a table that is not { head, align, rows }');
  const n = t.head.length;
  if (n < 1 || n > 50) bad('a table with no columns, or more than 50');
  if (t.align.length !== n || !t.align.every((a) => ALIGNS.includes(a))) bad('a table whose alignments do not match its columns');
  if (t.rows.length > 2000 || !t.rows.every((r) => Array.isArray(r) && r.length === n)) bad('a table row with a different number of cells than the header');
  for (const c of [...t.head, ...t.rows.flat()]) if (typeof c !== 'string' || c.includes('\n') || c.length > 2000) bad('a table cell that is not one line of text');
}

function bad(what) {
  throw new Refusal('lossy-round-trip', `${what} cannot be expressed in markdown`);
}

function tokensOf(item) {
  const a = item.attributes || {};
  const toks = [];
  for (const k of INLINE_ORDER) if (a[k]) toks.push({ k, v: k === 'link' ? a[k] : true });
  return toks;
}
const same = (a, b) => a.k === b.k && a.v === b.v;

// Walk inline items, opening/closing marks with a stack so adjacent runs share
// wrappers. Marks already open stay open (so nesting follows the author's), new
// marks open in canonical order, and `code` is always innermost.
// `h` supplies open(tok), close(tok), text(str, attrs), embed(item).
export function renderInline(items, h) {
  let out = '';
  const stack = [];
  for (const item of items) {
    const rest = tokensOf(item);
    const ordered = [];
    for (const s of stack) {
      const idx = rest.findIndex((w) => same(w, s));
      if (idx < 0 || (s.k === 'code' && rest.length > 1)) break;
      ordered.push(s);
      rest.splice(idx, 1);
    }
    const k = ordered.length;
    ordered.push(...rest);
    while (stack.length > k) out += h.close(stack.pop());
    for (let i = k; i < ordered.length; i++) {
      out += h.open(ordered[i]);
      stack.push(ordered[i]);
    }
    out += typeof item.insert === 'string' ? h.text(item.insert, item.attributes || {}) : h.embed(item);
  }
  while (stack.length) out += h.close(stack.pop());
  return out;
}

// Make a Delta expressible as markdown without changing what it *means*:
// drop empty paragraphs, trim line ends, move formatting off edge whitespace,
// and keep list indents contiguous. Anything else unsupported is left for
// the round-trip check to refuse.
export function normalizeForMarkdown(ops) {
  const lines = toLines(ops);
  const out = [];
  let prevListLevel = -1;
  for (const line of lines) {
    if (isEmbedLine(line)) {
      prevListLevel = -1;
      out.push(line);
      continue;
    }
    const isCode = line.block['code-block'] !== undefined;
    let items = line.items.map((i) => ({ ...i }));
    if (!isCode) items = trimItems(items);
    if (!isCode && items.length === 0) continue;
    const block = { ...line.block };
    if (block.list) {
      let lvl = Number(block.indent || 0);
      if (lvl > prevListLevel + 1) lvl = prevListLevel + 1;
      prevListLevel = lvl;
      if (lvl > 0) block.indent = lvl;
      else delete block.indent;
    } else {
      prevListLevel = -1;
    }
    out.push({ items, block });
  }
  const ops2 = [];
  for (const line of out) {
    ops2.push(...line.items);
    if (isEmbedLine(line)) continue;
    ops2.push(line.block && Object.keys(line.block).length ? { insert: '\n', attributes: line.block } : { insert: '\n' });
  }
  return { ops: canon(ops2) };
}

function trimItems(items) {
  // trim plain-text edges of the line
  while (items.length && typeof items[0].insert === 'string') {
    const t = items[0].insert.replace(/^\s+/, '');
    if (t === '') items.shift();
    else {
      items[0] = { ...items[0], insert: t };
      break;
    }
  }
  while (items.length && typeof items[items.length - 1].insert === 'string') {
    const last = items[items.length - 1];
    const t = last.insert.replace(/\s+$/, '');
    if (t === '') items.pop();
    else {
      items[items.length - 1] = { ...last, insert: t };
      break;
    }
  }
  // move marks off leading/trailing whitespace inside formatted runs
  const out = [];
  for (const it of items) {
    if (typeof it.insert !== 'string' || !it.attributes) {
      out.push(it);
      continue;
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(it.insert);
    const [, lead, core, trail] = m;
    if (core === '') {
      out.push({ insert: it.insert });
      continue;
    }
    if (lead) out.push({ insert: lead });
    out.push({ insert: core, attributes: it.attributes });
    if (trail) out.push({ insert: trail });
  }
  return out.filter((i) => !(typeof i.insert === 'string' && i.insert === ''));
}
