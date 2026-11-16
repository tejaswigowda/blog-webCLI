// Tolerant, inert HTML reading for import and trusted generated-markup inspection.
// Authored post HTML still goes through rawhtml.js's strict allowlist.
import { decodeHtml } from './html-entities.js';

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
