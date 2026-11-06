// Extension output is data that ends up in a committed page, so it is rebuilt from an allow-list:
// tags and attributes are re-emitted from tokens, text is escaped, and nothing is passed through
// verbatim. Clearly hostile constructs (script, event handlers, javascript: URLs, an iframe that
// is not a declared, sandboxed embed) are *refused*: an extension that emits them is buggy or
// malicious, and a silent strip would hide that. Merely unknown tags are dropped, keeping their text.
import { Refusal } from './errors.js';

const refuse = (m) => new Refusal('unsafe-extension-output', m);

const VOID = new Set(['br', 'hr', 'img']);
const ALLOWED = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'abbr', 'cite', 'q', 'span', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'details', 'summary', 'time', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'dl', 'dt', 'dd', 'a', 'img', 'iframe']);
const DANGEROUS = new Set(['script', 'style', 'link', 'meta', 'base', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'template', 'frame', 'frameset']);
const GLOBAL_ATTR = /^(?:class|id|lang|dir|role|title|aria-[\w-]+|data-[\w-]+)$/;
const TAG_ATTR = { a: ['href'], img: ['src', 'alt', 'width', 'height', 'loading'], time: ['datetime'], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'], abbr: [], iframe: ['src', 'width', 'height', 'loading', 'allow', 'referrerpolicy', 'sandbox'], ol: ['start'] };
const REL_OK = new Set(['bookmark', 'tag', 'home', 'nofollow', 'noopener', 'noreferrer']);
const DANGEROUS_ATTR = /^(?:on[\w-]+|srcdoc|formaction|action|xlink:href|ping)$/i;
const SAFE_VALUE = /^[\w\s.,:;#@%+/=?&()[\]'"!-]*$/u;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    if (name) return name in NAMED ? NAMED[name] : m;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
  });
}

export const escText = (s) => s.replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const scheme = (v) => /^([a-z][a-z0-9+.-]*):/i.exec(v.replace(/[\u0000-\u0020\u00a0\u2028\u2029]/g, ''))?.[1].toLowerCase() || null;

function safeUrl(v, { attr, tag }) {
  const s = scheme(v);
  if (s && !['https', 'http', 'mailto'].includes(s)) throw refuse(`<${tag} ${attr}="${v.slice(0, 40)}"> uses the "${s}:" scheme`);
  if (tag === 'img' && s === 'http') throw refuse('<img src> must be https');
  if (s === 'mailto' && tag === 'img') throw refuse('<img src> must be https');
  return v;
}

// opts.iframes: Set of exact URLs an embed may load (the extension's pinned_assets).
export function sanitizeHtml(html, { iframes = new Set() } = {}) {
  const src = String(html);
  let out = '';
  const stack = [];
  let i = 0;
  const closeTop = () => {
    out += `</${stack.pop()}>`;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      out += escText(src.slice(i));
      break;
    }
    if (lt > i) out += escText(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (/^<[!?]/.test(src.slice(i, i + 2))) {
      const end = src.indexOf('>', i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    let m = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(src.slice(i, i + 80));
    if (m) {
      const name = m[1].toLowerCase();
      if (DANGEROUS.has(name)) throw refuse(`</${name}> is not allowed`);
      const at = stack.lastIndexOf(name);
      if (at >= 0) while (stack.length > at) closeTop();
      i += m[0].length;
      continue;
    }
    m = /^<([a-zA-Z][\w-]*)/.exec(src.slice(i, i + 80));
    if (!m) {
      out += '&lt;';
      i += 1;
      continue;
    }
    const name = m[1].toLowerCase();
    let j = i + m[0].length;
    const attrs = [];
    const re = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
    for (;;) {
      re.lastIndex = j;
      const a = re.exec(src);
      if (!a || a[0] === '') break;
      attrs.push([a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')]);
      j = re.lastIndex;
    }
    const gt = src.indexOf('>', j);
    i = gt < 0 ? src.length : gt + 1;

    if (DANGEROUS.has(name)) throw refuse(`<${name}> is not allowed in a page`);
    for (const [k] of attrs) if (DANGEROUS_ATTR.test(k)) throw refuse(`the "${k}" attribute is not allowed`);
    if (!ALLOWED.has(name)) continue; // unknown tag: dropped, its text kept

    let kept = '';
    const allowedHere = TAG_ATTR[name] || [];
    const seen = {};
    const rel = [];
    for (const [k, v] of attrs) {
      if (k in seen) continue;
      seen[k] = v;
      if (k === 'rel' && name === 'a') {
        for (const t of v.toLowerCase().split(/\s+/)) if (REL_OK.has(t) && !rel.includes(t)) rel.push(t);
        continue;
      }
      if (!(GLOBAL_ATTR.test(k) || allowedHere.includes(k))) continue;
      if ((k === 'href' && name === 'a') || (k === 'src' && (name === 'img' || name === 'iframe'))) safeUrl(v, { attr: k, tag: name });
      if (name !== 'iframe' && k !== 'href' && k !== 'src' && !SAFE_VALUE.test(v)) continue;
      kept += ` ${k}="${escAttr(v)}"`;
    }
    if (name === 'iframe') {
      const s = seen.src;
      if (!s || !iframes.has(s)) throw refuse(`<iframe src="${(s || '').slice(0, 60)}"> is not an embed this extension declared under pinned_assets`);
      if (seen.sandbox !== 'allow-scripts') throw refuse('an <iframe> must carry sandbox="allow-scripts" and nothing more (never allow-same-origin)');
      if (seen.allow !== undefined && seen.allow !== 'fullscreen') throw refuse('an <iframe> may only ask to allow="fullscreen"');
      kept = ` src="${escAttr(s)}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy"${seen.title ? ` title="${escAttr(seen.title)}"` : ''}${seen.width && /^\d{1,4}$/.test(seen.width) ? ` width="${seen.width}"` : ''}${seen.height && /^\d{1,4}$/.test(seen.height) ? ` height="${seen.height}"` : ''}`;
    }
    if (name === 'a') {
      if (seen.href !== undefined && scheme(seen.href)) for (const t of ['noopener', 'noreferrer']) if (!rel.includes(t)) rel.push(t);
      if (rel.length) kept += ` rel="${rel.join(' ')}"`;
    }
    out += `<${name}${kept}>`;
    if (!VOID.has(name)) stack.push(name);
  }
  while (stack.length) closeTop();
  return out;
}
