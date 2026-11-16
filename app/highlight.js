// CSS and HTML source highlighting. No dependency: small tokenizers and a transparent <textarea>
// laid over a <pre> that holds the same text in colour. The textarea stays the field (its value is what is saved); the <pre> is
// only a picture of it, built with textContent, so what is typed can never become markup.

// -> [[type, text], …] whose texts, joined, are exactly `css`. Types: comment, string, atrule, selector, property, value (plain),
// number, color, function, important, punct, space. Forgiving: unbalanced input still tokenizes, it just colours what it can.
export function tokenizeCss(css) {
  const out = [];
  const push = (type, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[0] === type && type !== 'punct') last[1] += text;
    else out.push([type, text]);
  };
  const stack = []; // 'rule' (declarations) or 'group' (@media and the like: holds rules)
  let i = 0;
  // what the next bare text is: a selector or at-rule prelude, a property name, or a value
  let mode = 'head';
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      push('comment', css.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      const stop = Math.min(css[j] === c ? j + 1 : j, n);
      push('string', css.slice(i, stop));
      i = stop;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(css[j])) j++;
      push('space', css.slice(i, j));
      i = j;
      continue;
    }
    if (c === '{') {
      // a group holds rules; a rule holds declarations
      const group = startsAt(out) && /^@(media|supports|container|layer|document)\b/i.test(headText(out));
      push('punct', c);
      stack.push(group ? 'group' : 'rule');
      mode = stack[stack.length - 1] === 'rule' ? 'property' : 'head';
      i++;
      continue;
    }
    if (c === '}') {
      push('punct', c);
      stack.pop();
      mode = stack[stack.length - 1] === 'rule' ? 'property' : 'head';
      i++;
      continue;
    }
    if (c === ';') {
      push('punct', c);
      mode = stack[stack.length - 1] === 'rule' ? 'property' : 'head';
      i++;
      continue;
    }
    if (mode === 'property' && c === ':') {
      push('punct', c);
      mode = 'value';
      i++;
      continue;
    }
    if (mode === 'head') {
      // a selector or an at-rule prelude, up to the "{" (or a ";" for an at-rule with no block)
      let j = i;
      while (j < n && !'{};'.includes(css[j]) && !(css[j] === '/' && css[j + 1] === '*') && css[j] !== '"' && css[j] !== "'") j++;
      const text = css.slice(i, j);
      if (text.trimStart().startsWith('@') || startsAt(out)) push('atrule', text);
      else push('selector', text);
      i = j === i ? i + 1 : j;
      continue;
    }
    if (mode === 'property') {
      let j = i;
      while (j < n && !'{};:'.includes(css[j]) && !(css[j] === '/' && css[j + 1] === '*')) j++;
      // "a:hover {" inside a rule is a nested selector, not a property; leave that to the next "{"
      push('property', css.slice(i, j));
      i = j === i ? i + 1 : j;
      continue;
    }
    // value
    const rest = css.slice(i);
    let m;
    if ((m = /^#[0-9a-fA-F]{3,8}\b/.exec(rest))) push('color', m[0]);
    else if ((m = /^!\s*important\b/i.exec(rest))) push('important', m[0]);
    else if ((m = /^[a-zA-Z_-][\w-]*(?=\()/.exec(rest))) push('function', m[0]);
    else if ((m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/.exec(rest))) push('number', m[0]);
    else if ((m = /^[+-](?=\s)/.exec(rest))) push('punct', m[0]);
    else if ((m = /^[\w-]+/.exec(rest))) push('value', m[0]);
    else {
      m = [c];
      push(/[(),/*+-]/.test(c) ? 'punct' : 'value', c);
    }
    i += m[0].length;
  }
  return out;
}

// the current prelude is an at-rule when the first non-space token since the last block boundary starts with "@"
function startsAt(tokens) {
  for (let k = tokens.length - 1; k >= 0; k--) {
    const [t, s] = tokens[k];
    if (t === 'punct' && (s === '{' || s === '}' || s === ';')) return false;
    if (t === 'atrule') return true;
    if (t !== 'space' && t !== 'comment') return false;
  }
  return false;
}
function headText(tokens) {
  const parts = [];
  for (let k = tokens.length - 1; k >= 0; k--) {
    const [t, s] = tokens[k];
    if (t === 'punct' && (s === '{' || s === '}' || s === ';')) break;
    if (t === 'atrule') parts.unshift(s);
  }
  return parts.join('').trimStart();
}

export function tokenizeHtmlSource(html) {
  const out = [];
  const push = (type, text) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.[0] === type) last[1] += text;
    else out.push([type, text]);
  };
  let i = 0, inTag = false, value = false;
  while (i < html.length) {
    const rest = html.slice(i);
    let m;
    if (!inTag && rest.startsWith('<!--')) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? html.length : end + 3;
      push('comment', html.slice(i, stop));
      i = stop;
      continue;
    }
    if (!inTag && (m = /^(<\/?)([a-z][\w:-]*)/i.exec(rest))) {
      push('punct', m[1]);
      push('tag', m[2]);
      i += m[0].length;
      inTag = true;
      value = false;
      continue;
    }
    if (inTag) {
      if ((m = /^\s+/.exec(rest))) push('space', m[0]);
      else if ((m = /^\/?>/.exec(rest))) { push('punct', m[0]); inTag = false; }
      else if (rest[0] === '=') { m = ['=']; push('punct', '='); value = true; }
      else if (rest[0] === '"' || rest[0] === "'") {
        const end = html.indexOf(rest[0], i + 1);
        m = [html.slice(i, end < 0 ? html.length : end + 1)];
        push('string', m[0]);
        value = false;
      } else if ((m = /^[^\s=/>]+/.exec(rest))) {
        push(value ? 'string' : 'attribute', m[0]);
        value = false;
      } else { m = [rest[0]]; push('punct', m[0]); }
    } else if ((m = /^&(?:#x[\da-f]+|#\d+|[a-z][\w]*);/i.exec(rest))) push('entity', m[0]);
    else {
      m = /^[^<&]+/.exec(rest) || [rest[0]];
      push('text', m[0]);
    }
    i += m[0].length;
  }
  return out;
}

const CLASS = { comment: 'cm', string: 'st', atrule: 'at', selector: 'se', property: 'pr', number: 'nu', color: 'co', function: 'fn', important: 'im', punct: 'pu', tag: 'se', attribute: 'pr', entity: 'nu' };

// Fill `pre` with the coloured text. Only text nodes and spans with fixed class names are created.
function paintTokens(pre, tokens, doc) {
  pre.textContent = '';
  for (const [type, text] of tokens) {
    const cls = CLASS[type];
    if (!cls) {
      pre.append(doc.createTextNode(text));
      continue;
    }
    const span = doc.createElement('span');
    span.className = `tk-${cls}`;
    span.textContent = text;
    pre.append(span);
  }
}

export function paintHtmlSource(pre, html, doc = pre.ownerDocument) {
  paintTokens(pre, tokenizeHtmlSource(html), doc);
}

export function paintCss(pre, css, doc = pre.ownerDocument) {
  paintTokens(pre, tokenizeCss(css), doc);
  // a final newline occupies no line in a <pre> unless something follows it, and the textarea does show that line
  pre.append(doc.createTextNode('\n'));
}

// Wraps `textarea` (which stays the field: bind it as usual) and returns the element to put on the page.
export function highlightedTextarea(textarea, doc = textarea.ownerDocument, paintSource = paintCss) {
  const wrap = doc.createElement('div');
  wrap.className = 'hl-wrap';
  const pre = doc.createElement('pre');
  pre.className = 'hl-pre';
  pre.setAttribute('aria-hidden', 'true');
  textarea.classList.add('hl-input');
  textarea.setAttribute('wrap', 'off');
  const paint = () => {
    paintSource(pre, textarea.value, doc);
    sync();
  };
  const sync = () => {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  };
  textarea.addEventListener('input', paint);
  textarea.addEventListener('scroll', sync);
  // the form can set the value without an input event
  textarea.addEventListener('change', paint);
  wrap.append(pre, textarea);
  paint();
  return wrap;
}
