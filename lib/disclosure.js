import { parseHtml } from './html-tree.js';
import { decodeHtml } from './html-entities.js';

const block = new Set('address article aside blockquote br caption dd details div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table td th tr ul'.split(' '));
const invisible = new Set(['script', 'style', 'template', 'iframe', 'noscript', 'annotation', 'annotation-xml']);
const normalized = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const word = /[\p{L}\p{N}\p{M}_]/u;

export function disclosureText(disclosure, bodyHtml) {
  if (typeof disclosure === 'string') return disclosure;
  const phrase = normalized(disclosure.skipIfPresent || '');
  if (!phrase) return disclosure.text;
  const parts = [];
  function visit(node) {
    if (typeof node === 'string') {
      parts.push(decodeHtml(node));
      return;
    }
    if (invisible.has(node.tag) || Object.hasOwn(node.attrs, 'hidden')) return;
    if (block.has(node.tag)) parts.push(' ');
    for (const child of node.children) visit(child);
    if (block.has(node.tag)) parts.push(' ');
  }
  visit(parseHtml(bodyHtml));
  const text = normalized(parts.join(''));
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    const end = at + phrase.length;
    if ((!word.test(phrase[0]) || !word.test(text[at - 1] || '')) &&
        (!word.test(phrase.at(-1)) || !word.test(text[end] || ''))) return '';
  }
  return disclosure.text;
}
