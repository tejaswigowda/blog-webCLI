// Markdown <-> Delta, restricted to what Quill's toolbar can express.
//
// Canonical form (what deltaToMd emits, and what a post must already be in):
//   paragraphs separated by one blank line; "## " headings (1-3); "- " bullets and
//   "1." numbered items with 4-space nesting; "> " quotes; fenced code; **bold**,
//   _italic_, ~~strike~~, `code`, [text](url), ![alt](src).
// Anything that would not survive md -> Delta -> md is refused, never guessed.
import { Refusal } from './errors.js';
import { VIDEO_REF } from './video.js';
import { canon, deltaEqual, normalizeForMarkdown, renderInline, toLines, assertSupported } from './delta.js';

const PUNCT = /[!-/:-@[-`{-~]/;
const isAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isWs = (c) => c !== undefined && /\s/.test(c);

// ---------- inline parsing ----------

// Find the index of `delim` closing at/after `from`, skipping escapes, code spans
// and link/image URL parts so their contents cannot close an outer mark.
function findClose(s, delim, from) {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) {
        i = j + 1;
        continue;
      }
    }
    if (c === ']' && s[i + 1] === '(') {
      const j = s.indexOf(')', i + 2);
      if (j > 0) {
        i = j + 1;
        continue;
      }
    }
    if (s.startsWith(delim, i)) {
      if (delim === '_') {
        if (!isAlnum(s[i + 1]) && !isWs(s[i - 1]) && i > from) return i;
      } else if (i > from) return i;
    }
    i++;
  }
  return -1;
}

function findBracket(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) i = j;
    } else if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function unescape(s) {
  return s.replace(/\\(.)/g, (m, c) => (PUNCT.test(c) ? c : m));
}

export function parseInline(s, attrs = {}, out = []) {
  let buf = '';
  const flush = () => {
    if (buf) out.push({ insert: buf, attributes: { ...attrs } });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ insert: s.slice(i + 1, j), attributes: { ...attrs, code: true } });
        i = j + 1;
        continue;
      }
    }
    if (s.startsWith('**', i) || s.startsWith('~~', i)) {
      const d = s.slice(i, i + 2);
      const j = findClose(s, d, i + 2);
      if (j > i + 2) {
        flush();
        parseInline(s.slice(i + 2, j), { ...attrs, [d === '**' ? 'bold' : 'strike']: true }, out);
        i = j + 2;
        continue;
      }
    }
    if (c === '_' && !isAlnum(s[i - 1]) && s[i + 1] !== undefined && !isWs(s[i + 1])) {
      const j = findClose(s, '_', i + 1);
      if (j > i + 1) {
        flush();
        parseInline(s.slice(i + 1, j), { ...attrs, italic: true }, out);
        i = j + 1;
        continue;
      }
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const isImg = c === '!';
      const open = isImg ? i + 1 : i;
      const close = findBracket(s, open + 1);
      if (close > 0 && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        const url = end > 0 ? s.slice(close + 2, end) : '';
        if (end > 0 && url !== '' && !/\s/.test(url)) {
          flush();
          const inner = s.slice(open + 1, close);
          if (isImg) {
            const a = { ...attrs };
            const alt = unescape(inner);
            if (alt) a.alt = alt;
            out.push({ insert: { image: url }, attributes: a });
          } else {
            parseInline(inner, { ...attrs, link: url }, out);
          }
          i = end + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---------- block parsing ----------

const RE_FENCE = /^```(\S*)\s*$/;
const RE_HEAD = /^(#{1,3}) (.*)$/;
const RE_ITEM = /^( *)([-*+]|\d+\.) (.*)$/;
const RE_QUOTE = /^>(?: ?)(.*)$/;

const RE_VIDEO = /^!\[\]\((video:[^\s()]+)\)$/;

const startsBlock = (l) => RE_VIDEO.test(l.trim()) || RE_FENCE.test(l) || RE_HEAD.test(l) || RE_ITEM.test(l) || RE_QUOTE.test(l);

export function mdToDelta(md) {
  const lines = md.split('\n');
  const ops = [];
  const para = (text, block) => {
    ops.push(...parseInline(text.trim()));
    ops.push(block ? { insert: '\n', attributes: block } : { insert: '\n' });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let m;
    if ((m = RE_VIDEO.exec(line.trim()))) {
      ops.push({ insert: { video: m[1] } });
      i++;
      continue;
    }
    if ((m = RE_FENCE.exec(line))) {
      const lang = m[1];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        if (lines[i] !== '') ops.push({ insert: lines[i] });
        ops.push({ insert: '\n', attributes: { 'code-block': lang || true } });
        i++;
      }
      i++;
      continue;
    }
    if ((m = RE_HEAD.exec(line))) {
      para(m[2], { header: m[1].length });
      i++;
      continue;
    }
    if (RE_QUOTE.test(line)) {
      let buf = [];
      const flushQ = () => {
        if (buf.length) para(buf.join(' '), { blockquote: true });
        buf = [];
      };
      while (i < lines.length && (m = RE_QUOTE.exec(lines[i]))) {
        if (m[1].trim() === '') flushQ();
        else buf.push(m[1].trim());
        i++;
      }
      flushQ();
      continue;
    }
    if ((m = RE_ITEM.exec(line))) {
      const widths = [];
      while (i < lines.length && (m = RE_ITEM.exec(lines[i]))) {
        const w = m[1].length;
        while (widths.length && w < widths[widths.length - 1]) widths.pop();
        if (!widths.length || w > widths[widths.length - 1]) widths.push(w);
        const level = widths.length - 1;
        const attrs = { list: /^\d/.test(m[2]) ? 'ordered' : 'bullet' };
        if (level > 0) attrs.indent = level;
        para(m[3], attrs);
        i++;
      }
      continue;
    }
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    para(buf.join(' '));
  }
  if (!ops.length) ops.push({ insert: '\n' });
  return { ops: canon(ops) };
}

// ---------- serialisation ----------

function escapeText(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' || c === '*' || c === '~' || c === '[' || c === ']' || c === '<' || c === '`') out += '\\' + c;
    else if (c === '_') out += isAlnum(t[i - 1]) && isAlnum(t[i + 1]) ? c : '\\_';
    else if (c === '&' && /^&#?\w+;/.test(t.slice(i))) out += '\\&';
    else out += c;
  }
  return out;
}

function safeUrl(url) {
  if (/[\s()]/.test(url)) throw new Refusal('lossy-round-trip', `URL "${url}" contains spaces or parentheses`);
  return url;
}

function inlineToMd(items, { plainStart = false } = {}) {
  let first = true;
  const md = renderInline(items, {
    open: (t) => (t.k === 'link' ? '[' : t.k === 'bold' ? '**' : t.k === 'italic' ? '_' : t.k === 'strike' ? '~~' : '`'),
    close: (t) => (t.k === 'link' ? `](${safeUrl(t.v)})` : t.k === 'bold' ? '**' : t.k === 'italic' ? '_' : t.k === 'strike' ? '~~' : '`'),
    text: (s, a) => {
      const wasFirst = first;
      first = false;
      if (a.code) {
        if (s.includes('`')) throw new Refusal('lossy-round-trip', 'inline code containing a backtick');
        return s;
      }
      let e = escapeText(s);
      if (plainStart && wasFirst && !Object.keys(a).length) e = e.replace(/^(#|>|-|\+)/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
      return e;
    },
    embed: (it) => {
      first = false;
      const alt = ((it.attributes && it.attributes.alt) || '').replace(/[\\[\]]/g, '\\$&');
      return `![${alt}](${safeUrl(it.insert.image)})`;
    },
  });
  return md;
}

export function deltaToMd(delta) {
  const lines = toLines(delta.ops);
  assertSupported(lines);
  const blocks = [];
  let k = 0;
  const counters = [];
  while (k < lines.length) {
    const { items, block } = lines[k];
    if (lines[k].video) {
      const ref = items[0].insert.video;
      if (!VIDEO_REF.test(ref)) throw new Refusal('lossy-round-trip', `"${ref}" is not a video reference`);
      blocks.push(`![](${ref})`);
      k++;
      continue;
    }
    if (block['code-block'] !== undefined) {
      const lang = block['code-block'] === true ? '' : String(block['code-block']);
      const body = [];
      while (k < lines.length && lines[k].block['code-block'] !== undefined && (lines[k].block['code-block'] === true ? '' : String(lines[k].block['code-block'])) === lang) {
        body.push(lines[k].items.map((i) => (typeof i.insert === 'string' ? i.insert : '')).join(''));
        k++;
      }
      if (body.some((l) => /^```/.test(l))) throw new Refusal('lossy-round-trip', 'a code block containing a ``` line');
      blocks.push('```' + lang + '\n' + body.join('\n') + (body.length ? '\n' : '') + '```');
      continue;
    }
    if (block.blockquote) {
      const parts = [];
      while (k < lines.length && lines[k].block.blockquote) {
        parts.push('> ' + inlineToMd(lines[k].items));
        k++;
      }
      blocks.push(parts.join('\n>\n'));
      continue;
    }
    if (block.list) {
      const parts = [];
      counters.length = 0;
      let topType = null;
      while (k < lines.length && lines[k].block.list) {
        const b = lines[k].block;
        const lvl = Number(b.indent || 0);
        // Adjacent lists of different types are separate lists: keep the blank line.
        if (lvl === 0) {
          if (topType && topType !== b.list) parts.push('');
          topType = b.list;
        }
        counters.length = lvl + 1;
        for (let q = 0; q < counters.length; q++) counters[q] = counters[q] || 0;
        let marker = '-';
        if (b.list === 'ordered') {
          counters[lvl] += 1;
          marker = counters[lvl] + '.';
        } else counters[lvl] = 0;
        parts.push(' '.repeat(4 * lvl) + marker + ' ' + inlineToMd(lines[k].items));
        k++;
      }
      blocks.push(parts.join('\n'));
      continue;
    }
    if (block.header) {
      blocks.push('#'.repeat(Number(block.header)) + ' ' + inlineToMd(items));
      k++;
      continue;
    }
    if (items.length) blocks.push(inlineToMd(items, { plainStart: true }));
    k++;
  }
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

// Convert editor content to markdown, proving the round trip before returning it.
export function deltaToMarkdownChecked(delta) {
  const norm = normalizeForMarkdown(delta.ops);
  const md = deltaToMd(norm);
  const back = mdToDelta(md);
  if (!deltaEqual(norm.ops, back.ops)) {
    throw new Refusal('lossy-round-trip', 'the content changed when converted to markdown and back');
  }
  return { md, delta: back };
}

// Is this markdown already in canonical form? (md -> Delta -> md is byte-identical)
export function mdRoundTrips(md) {
  const out = deltaToMd(mdToDelta(md));
  return { ok: out === md, out };
}
