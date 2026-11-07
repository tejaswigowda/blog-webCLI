// The normaliser the generator-vs-client equivalence test (test/equivalence.test.js) applies before comparing two pages. It is
// DEFINED HERE and committed, because an undefined normaliser makes that test flaky, and a flaky test gets disabled.
//
// It forgives exactly three things, which carry no meaning to a reader, a crawler or an unfurler:
//   1. whitespace between tags: a run of whitespace that sits between ">" and "<" collapses to nothing. Text is never touched,
//      and neither is anything inside <pre>, <textarea>, <script> or <style>, where whitespace is content.
//   2. attribute order: the attributes of a start tag are sorted by name (byte order); values are untouched.
//   3. self-closing form: <br />, <br/> and <br> are one thing; a trailing "/" on a void element is dropped.
// plus the two byte-level facts that are the same page on any platform: CRLF is LF, and the file ends in exactly one newline.
//
// It does NOT forgive: a different attribute value, a different character of text, a different element, a different order of
// elements, a different entity or quote inside text, a different comment. normalise.test.js proves each of those still differs.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = /<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<([A-Za-z][^\s/>]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;

function startTag(name, attrs, slash) {
  const list = [];
  for (const m of attrs.matchAll(ATTR)) {
    const value = m[2] ?? m[3] ?? m[4];
    list.push([m[1], value === undefined ? null : value.includes('"') ? `'${value}'` : `"${value}"`]);
  }
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rest = list.map(([n, v]) => (v === null ? ` ${n}` : ` ${n}=${v}`)).join('');
  return `<${name}${rest}${slash && !VOID.has(name.toLowerCase()) ? ' /' : ''}>`;
}

// Regions are processed separately so that nothing inside a raw-text element is rewritten by rules 1 and 2.
function plainRegion(s) {
  return s.replace(TAG, (_, name, attrs, slash) => startTag(name, attrs, slash)).replace(/>\s+</g, '><');
}

export function normalise(html) {
  const text = String(html).replace(/\r\n?/g, '\n');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(RAW)) {
    const open = m[0].indexOf('>') + 1;
    const head = m[0].slice(0, open);
    out += plainRegion(text.slice(last, m.index)) + head.replace(TAG, (_, name, attrs, slash) => startTag(name, attrs, slash)) + m[0].slice(open);
    last = m.index + m[0].length;
  }
  out += plainRegion(text.slice(last));
  return `${out.replace(/\n+$/, '')}\n`;
}
