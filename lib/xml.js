// A small, tolerant XML reader for WordPress export files (WXR). Pure and dependency-free, so the browser and
// Node run the same code (DOMParser exists in only one of them). It builds a tree of { name, attrs, children },
// where a child is a node or a string. It reads data and nothing else: a DOCTYPE is skipped and no entity it
// declares is ever expanded, so a hostile file cannot make it read a file or balloon in memory.
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e] ?? m;
  });
}

const NAME = /[^\s/>=]+/y;
const ATTR = /\s*([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;

export function parseXml(src) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (t, raw) => {
    if (!t) return;
    const kids = top().children;
    const last = kids[kids.length - 1];
    const v = raw ? t : decodeEntities(t);
    if (typeof last === 'string') kids[kids.length - 1] = last + v;
    else kids.push(v);
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(src.slice(i));
      break;
    }
    if (lt > i) addText(src.slice(i, lt));
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end < 0 ? n : end;
      addText(src.slice(lt + 9, stop), true);
      i = stop + 3;
    } else if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE: skipped, including an internal subset in [...]
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim();
      // close the nearest open element of that name; a stray close tag is ignored
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const m = NAME.exec(src);
      if (!m) {
        addText('<');
        i = lt + 1;
        continue;
      }
      const node = { name: m[0], attrs: {}, children: [] };
      let j = NAME.lastIndex;
      let selfClosing = false;
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++;
        if (j >= n) break;
        if (src[j] === '>') {
          j++;
          break;
        }
        if (src[j] === '/' && src[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        ATTR.lastIndex = j;
        const a = ATTR.exec(src);
        if (!a || ATTR.lastIndex === j) {
          j++;
          continue;
        }
        node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
        j = ATTR.lastIndex;
      }
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j;
    }
  }
  return root;
}

export const kids = (node, name) => (node ? node.children.filter((c) => typeof c !== 'string' && (name === undefined || c.name === name)) : []);
export const child = (node, name) => kids(node, name)[0] || null;
export const textOf = (node) => (!node ? '' : node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join(''));
export const childText = (node, name) => textOf(child(node, name));
