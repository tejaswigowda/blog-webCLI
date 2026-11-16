// Trusted renderer output still crosses an allowlist before it reaches a page.
import { Refusal } from './errors.js';
import { decodeHtml } from './html-entities.js';

const TAGS = new Set('math semantics annotation mrow mi mn mo mtext mspace ms mfrac msqrt mroot mstyle merror mpadded mphantom msub msup msubsup munder mover munderover mmultiscripts mprescripts mtable mtr mtd'.split(' '));
const TOKEN = new Set(['mi', 'mn', 'mo', 'mtext', 'ms', 'annotation']);
const BOOL = /^(true|false)$/;
const LENGTH = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?$/;
const ATTRS = {
  math: { display: /^(block|inline)$/, xmlns: /^http:\/\/www\.w3\.org\/1998\/Math\/MathML$/ },
  annotation: { encoding: /^application\/x-tex$/ },
  mo: { form: /^(prefix|infix|postfix)$/, fence: BOOL, separator: BOOL, stretchy: BOOL, symmetric: BOOL, largeop: BOOL, movablelimits: BOOL, lspace: LENGTH, rspace: LENGTH, minsize: LENGTH, maxsize: LENGTH },
  mspace: { width: LENGTH, height: LENGTH, depth: LENGTH },
  mfrac: { linethickness: LENGTH },
  mpadded: { width: LENGTH, height: LENGTH, depth: LENGTH, lspace: LENGTH, voffset: LENGTH },
  mover: { accent: BOOL },
  munder: { accentunder: BOOL },
  munderover: { accent: BOOL, accentunder: BOOL },
  mi: { mathvariant: /^normal$/ },
};
const GLOBAL = { displaystyle: BOOL, scriptlevel: /^[+-]?[0-2]$/ };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bad = (detail) => { throw new Refusal('bad-math', detail); };

function presentation(tag, name, value) {
  if (name === 'class') {
    if (tag === 'math' && value === 'tml-display') return '';
    if (tag === 'mtable' && value === 'tml-jot') return '';
    if (tag === 'mtd' && /^tml-(left|right|center)$/.test(value)) return `text-align:${value.slice(4)};`;
    bad(`MathML <${tag}> requires unsupported class "${value}".`);
  }
  if (name === 'style') {
    if (tag === 'math' && value === 'display:block math;') return '';
    // Aligned equations need cell padding/alignment without a stylesheet. No other CSS is accepted.
    if (tag !== 'mtd') bad(`MathML <${tag}> requires unsupported inline styling.`);
    for (const decl of value.split(';').filter(Boolean)) {
      if (!/^(?:padding-(?:left|right|top|bottom)):-?(?:\d+(?:\.\d*)?|\.\d+)(?:em|pt)$/.test(decl)) bad(`Unsupported MathML layout style "${decl}".`);
    }
    return value;
  }
  return null;
}

export function serializeMathML(src, tex) {
  if (typeof src !== 'string' || src.length > 200000) bad('MathML output exceeds 200000 characters.');
  const stack = [];
  let out = '', i = 0, roots = 0, annotations = 0, annotation = '';
  while (i < src.length) {
    if (src[i] !== '<') {
      const end = src.indexOf('<', i);
      const text = decodeHtml(src.slice(i, end < 0 ? src.length : end));
      if (!TOKEN.has(stack.at(-1)) && text.trim()) bad('Text outside a MathML token.');
      if (stack.at(-1) === 'annotation') annotation += text;
      out += esc(text);
      i = end < 0 ? src.length : end;
      continue;
    }
    const close = /^<\/([a-z][a-z0-9]*)>/.exec(src.slice(i));
    if (close) {
      if (stack.pop() !== close[1]) bad('Unbalanced MathML output.');
      out += `</${close[1]}>`;
      i += close[0].length;
      continue;
    }
    const open = /^<([a-z][a-z0-9]*)(?=[\s>])/.exec(src.slice(i));
    if (!open || !TAGS.has(open[1])) bad(`Unsupported MathML element near ${JSON.stringify(src.slice(i, i + 70))}.`);
    const tag = open[1];
    if (!stack.length && (tag !== 'math' || ++roots !== 1)) bad('MathML must have one math root.');
    if (stack.length && tag === 'math') bad('Nested math roots are not supported.');
    if (stack.length >= 64) bad('MathML nests at most 64 levels.');
    if (tag === 'annotation' && (stack.at(-1) !== 'semantics' || ++annotations !== 1)) bad('Unexpected MathML annotation.');
    if (TOKEN.has(stack.at(-1))) bad('Elements inside a MathML text token.');
    let j = i + open[0].length, attrs = '', style = '';
    const seen = new Set();
    while (src[j] !== '>') {
      const a = /^\s+([a-z][a-z0-9-]*)="([^"]*)"/.exec(src.slice(j));
      if (!a || seen.has(a[1])) bad('Invalid or duplicate MathML attribute.');
      const [, name, raw] = a;
      seen.add(name);
      const value = decodeHtml(raw);
      const css = presentation(tag, name, value);
      if (css !== null) style += css;
      else {
        const rule = ATTRS[tag]?.[name] || GLOBAL[name];
        if (!rule || !rule.test(value)) bad(`Unsupported MathML <${tag} ${name}=${JSON.stringify(value)}> .`);
        attrs += ` ${name}="${esc(value)}"`;
      }
      j += a[0].length;
    }
    if (tag === 'annotation' && !seen.has('encoding')) bad('MathML annotation needs its TeX encoding.');
    if (style) attrs += ` style="${esc(style)}"`;
    out += `<${tag}${attrs}>`;
    stack.push(tag);
    i = j + 1;
  }
  if (stack.length || roots !== 1 || annotations !== 1 || annotation !== tex) bad('MathML must contain the exact TeX source in one annotation.');
  return out;
}

export function mathFeedHtml(html) {
  return html.replace(/<math\b[^>]*>[\s\S]*?<\/math>/g, (math) => {
    const annotation = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/.exec(math);
    if (!annotation) bad('Generated math has no TeX annotation for the feed.');
    return esc(decodeHtml(annotation[1]));
  });
}
