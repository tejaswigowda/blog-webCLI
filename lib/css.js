// CSS scanning helpers shared by the theme pipeline. A stylesheet is only ever judged on its
// *decoded* text: escapes (\75 rl() and comments (u/**/rl) are resolved first, so an
// obfuscated forbidden construct cannot slip past a pattern.
export const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

// CSS escapes: \ followed by 1-6 hex digits (and one optional whitespace), or any other character.
export function unescapeCss(css) {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (m, hex, ch) => {
    if (ch !== undefined) return ch === '\n' ? '' : ch;
    const cp = parseInt(hex, 16);
    return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(cp);
  });
}

export const decodedText = (css) => unescapeCss(stripComments(css));

// Every url(...) token in already comment-stripped text: [{ index, length, arg }].
export function urlTokens(text) {
  const out = [];
  const re = /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^)\s"'(]*))\s*\)/gi;
  let m;
  while ((m = re.exec(text))) out.push({ index: m.index, length: m[0].length, arg: m[1] ?? m[2] ?? m[3] ?? '' });
  return out;
}

export const countUrlOpeners = (text) => (text.match(/url\s*\(/gi) || []).length;

// Resolve `rel` against the directory of `fromFile`; null if it would leave the repository.
export function resolvePath(fromFile, rel) {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
