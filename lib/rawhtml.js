// Raw HTML blocks in markdown: a block that starts with an HTML tag at the start of a line and runs to the next blank line.
// This is the one place a post's own markup reaches a page, so it is held to an allowlist and never passed through:
//   * the block is tokenised and every token is checked: only the tags and attributes below, balanced, no scripting, no styling,
//     no frames, no forms, no event handlers, no address that is not http(s), mailto, relative or an asset: reference;
//   * what reaches the page is re-serialised from the tokens (names lower-cased, every attribute value re-escaped), not the source;
//   * a block that fails is refused (`bad-html`) and says why; nothing is stripped silently, so what you wrote is what is shown.
// Pure: no DOM, no network. Imports only the error type, so the markdown, Delta and HTML modules can all use it.
import { Refusal } from './errors.js';

export const MAX_BLOCK = 50000;
const MAX_DEPTH = 24;

const TAGS = new Set([
  'a', 'abbr', 'aside', 'article', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'wbr',
]);
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);

const BOOL = (v) => v === '' || v === 'true';
const NUM = (max) => (v) => new RegExp(`^\\d{1,${max}}$`).test(v);
const TEXT = (v) => v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v);
// name -> predicate over the *decoded* value
const GLOBAL = {
  class: (v) => /^[\w -]{1,200}$/.test(v),
  id: (v) => /^[A-Za-z][\w:.-]{0,63}$/.test(v),
  title: TEXT,
  lang: (v) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(v),
  dir: (v) => ['ltr', 'rtl', 'auto'].includes(v),
  'aria-label': TEXT,
  'aria-hidden': (v) => v === 'true' || v === 'false',
};
const URL_ATTR = 'url';
const PER_TAG = {
  a: { href: URL_ATTR },
  img: { src: URL_ATTR, alt: (v) => v.length <= 500 && !/[\u0000-\u001f\u007f]/.test(v), width: (v) => /^\d{1,4}%?$/.test(v), height: (v) => /^\d{1,4}%?$/.test(v) },
  ol: { start: (v) => /^-?\d{1,6}$/.test(v), type: (v) => ['1', 'a', 'A', 'i', 'I'].includes(v), reversed: BOOL },
  li: { value: (v) => /^-?\d{1,6}$/.test(v) },
  td: { colspan: NUM(3), rowspan: NUM(3), align: (v) => ['left', 'right', 'center'].includes(v) },
  th: { colspan: NUM(3), rowspan: NUM(3), scope: (v) => ['row', 'col', 'rowgroup', 'colgroup'].includes(v), align: (v) => ['left', 'right', 'center'].includes(v) },
  col: { span: NUM(3) },
  colgroup: { span: NUM(3) },
  details: { open: BOOL },
  time: { datetime: (v) => /^[\dTZ:+.\- ]{4,40}$/.test(v) },
};
const BOOLEAN_ATTRS = new Set(['reversed', 'open']);

export const ALLOWED_TAGS = [...TAGS].sort();

const bad = (detail) => new Refusal('bad-html', detail);

const ENTITY = /&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});/g;
const BASIC = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

// An attribute value, entities decoded: an address must be judged as the browser will read it, not as it was typed.
function decodeAttr(v, name) {
  return v.replace(ENTITY, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw bad(`"${name}" has an invalid character reference`);
      return String.fromCodePoint(cp);
    }
    if (e in BASIC) return BASIC[e];
    throw bad(`"${name}" uses the entity &${e}; (write the character itself)`);
  });
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// text keeps the entities it was written with (a browser reads them as text, never as markup) and escapes everything else
const escText = (s) => s.replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});)/g, '&amp;').replace(/>/g, '&gt;');

export const isAsset = (u) => typeof u === 'string' && u.startsWith('asset:');

function checkUrl(v, tag, name) {
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(v) || v.length > 2000) throw bad(`<${tag} ${name}> must be a plain address with no spaces`);
  if (isAsset(v)) return v;
  if (/^(https?:)/i.test(v) || (tag === 'a' && /^mailto:/i.test(v))) return v;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) throw bad(`<${tag} ${name}="${v.slice(0, 40)}"> uses an address scheme that is not allowed`);
  return v; // relative
}

// -> [{ t: 'open', tag, attrs: [[name, value]], line }, { t: 'close', tag }, { t: 'text', text }, { t: 'comment' }]
export function tokenizeHtml(src) {
  if (typeof src !== 'string') throw bad('an HTML block is text');
  if (src.length > MAX_BLOCK) throw bad(`an HTML block may be at most ${MAX_BLOCK} characters`);
  const out = [];
  const stack = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0 || lt > i) {
      const text = src.slice(i, lt < 0 ? n : lt);
      out.push({ t: 'text', text });
      if (lt < 0) break;
      i = lt;
    }
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      if (e < 0) throw bad('a comment is never closed');
      out.push({ t: 'comment' });
      i = e + 3;
      continue;
    }
    const close = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>/.exec(src.slice(i, i + 40));
    if (close) {
      const tag = close[1].toLowerCase();
      if (!TAGS.has(tag)) throw bad(`<${tag}> is not allowed in an HTML block`);
      if (!stack.length || stack[stack.length - 1] !== tag) throw bad(stack.length ? `</${tag}> closes <${stack[stack.length - 1]}>, which is still open` : `</${tag}> has no opening tag`);
      stack.pop();
      out.push({ t: 'close', tag });
      i += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z][A-Za-z0-9]*)/.exec(src.slice(i, i + 40));
    if (!open) throw bad(`a "<" that starts no tag (write &lt; for the character)`);
    const tag = open[1].toLowerCase();
    if (!TAGS.has(tag)) throw bad(`<${tag}> is not allowed in an HTML block${/^(script|style|iframe|object|embed|form|input|button|svg|math|link|meta|base|video|audio|textarea|select|template|noscript)$/.test(tag) ? ' (nothing that runs, loads or submits)' : ''}`);
    let j = i + open[0].length;
    const attrs = [];
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw bad(`<${tag}> is never closed with ">"`);
      if (src[j] === '>') {
        j++;
        break;
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      const a = /^([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(src.slice(j, j + 4000));
      if (!a) throw bad(`<${tag}> has something that is not an attribute: "${src.slice(j, j + 20)}"`);
      const name = a[1].toLowerCase();
      const raw = a[2] ?? a[3] ?? a[4];
      if (attrs.some(([k]) => k === name)) throw bad(`<${tag}> has "${name}" twice`);
      const rule = GLOBAL[name] || (PER_TAG[tag] && PER_TAG[tag][name]);
      if (!rule) throw bad(`<${tag} ${name}> is not allowed${name.startsWith('on') ? ' (no event handlers)' : name === 'style' ? ' (no inline style: use a class and the blog\'s CSS)' : ''}`);
      let value = raw === undefined ? '' : decodeAttr(raw, name);
      if (raw === undefined && !BOOLEAN_ATTRS.has(name)) throw bad(`<${tag} ${name}> needs a value`);
      if (rule === URL_ATTR) value = checkUrl(value, tag, name);
      else if (!rule(value)) throw bad(`<${tag} ${name}="${value.slice(0, 40)}"> is not a valid value`);
      attrs.push([name, value]);
      j += a[0].length;
    }
    if (selfClose && !VOID.has(tag)) throw bad(`<${tag}/> cannot be self-closing: write <${tag}></${tag}>`);
    if (tag === 'img' && !attrs.some(([k]) => k === 'src')) throw bad('<img> needs a src');
    out.push({ t: 'open', tag, attrs });
    if (!VOID.has(tag)) {
      if (stack.length >= MAX_DEPTH) throw bad(`HTML blocks nest at most ${MAX_DEPTH} deep`);
      stack.push(tag);
    }
    i = j;
  }
  if (stack.length) throw bad(`<${stack[stack.length - 1]}> is never closed (a blank line ends an HTML block, so keep a block's tags together)`);
  return out;
}

// Throws bad-html unless the block is allowed.
export const checkHtmlBlock = (src) => void tokenizeHtml(src);

// Every address the block names: [{ tag, attr, url }]
export function htmlBlockUrls(src) {
  const urls = [];
  for (const tok of tokenizeHtml(src)) if (tok.t === 'open') for (const [name, v] of tok.attrs) if (PER_TAG[tok.tag] && PER_TAG[tok.tag][name] === URL_ATTR) urls.push({ tag: tok.tag, attr: name, url: v });
  return urls;
}

// resolve(ref) -> pinned address (throws a Refusal for an unpinned reference). strict: false turns an unusable image into a note.
export function renderHtmlBlock(src, { resolve, strict = true } = {}) {
  let html = '';
  for (const tok of tokenizeHtml(src)) {
    if (tok.t === 'comment') continue;
    if (tok.t === 'text') {
      html += escText(tok.text);
      continue;
    }
    if (tok.t === 'close') {
      html += `</${tok.tag}>`;
      continue;
    }
    const attrs = [];
    let dropped = false;
    for (const [name, value] of tok.attrs) {
      if (PER_TAG[tok.tag] && PER_TAG[tok.tag][name] === URL_ATTR && isAsset(value)) {
        try {
          attrs.push([name, resolve(value)]);
        } catch (e) {
          if (strict) throw e;
          dropped = true;
        }
        continue;
      }
      attrs.push([name, value]);
    }
    if (dropped && tok.tag === 'img') {
      html += `<span class="unresolved">[image unavailable]</span>`;
      continue;
    }
    if (dropped) continue;
    if (tok.tag === 'a' && attrs.some(([k, v]) => k === 'href' && /^https?:/i.test(v))) attrs.push(['rel', 'noopener noreferrer']);
    if (tok.tag === 'img') attrs.push(['loading', 'lazy']);
    html += `<${tok.tag}${attrs.map(([k, v]) => (BOOLEAN_ATTRS.has(k) ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('')}>`;
  }
  return html;
}

const BLOCKISH = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul']);

// The words of the block, for excerpts, search and word counts; block boundaries are spaces.
export function htmlBlockText(src) {
  let t = '';
  for (const tok of tokenizeHtml(src)) {
    if (tok.t === 'text') t += tok.text.replace(/&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e) => (e in BASIC ? BASIC[e] : e[0] === '#' ? safeChar(e) : ' '));
    else if ((tok.t === 'open' || tok.t === 'close') && BLOCKISH.has(tok.tag)) t += ' ';
  }
  return t.replace(/\s+/g, ' ').trim();
}

function safeChar(e) {
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
}

// The canonical source of a block, which is what markdown holds: lines right-trimmed, no blank lines (a blank line ends a
// block), no leading or trailing blank lines. A <pre> cannot survive that, so it is refused rather than altered.
export function canonHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.some((l) => l === '') && /<pre[\s>]/i.test(src)) throw bad('a <pre> inside an HTML block cannot contain a blank line (a blank line ends the block); use a fenced code block');
  return lines.filter((l) => l !== '').join('\n');
}
