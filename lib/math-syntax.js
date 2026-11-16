import { Refusal } from './errors.js';

export const MATH_FILE = 'webcli-math.js';
export const MATH_ID = 'Temml@0.14.0';
export const MAX_MATH_LENGTH = 4096;

// Called only outside code and HTML; escaped backslashes are consumed by the Markdown parser.
export function inlineMathAt(s, start) {
  let depth = 0;
  for (let i = start + 2; i < s.length; i++) {
    if (s[i] === '\n') break;
    if (s[i] === '%') break;
    if (s[i] === '\\') {
      if (s[i + 1] === ')') {
        if (depth) throw new Refusal('bad-math', 'A closing \\) occurs inside an unclosed group; a literal \\) inside inline math is not supported.');
        const tex = s.slice(start + 2, i);
        if (!tex.trim() || tex.length > MAX_MATH_LENGTH) throw new Refusal('bad-math', `Inline math needs 1-${MAX_MATH_LENGTH} characters.`);
        return { tex, end: i + 2 };
      }
      i++;
    } else if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
  }
  throw new Refusal('unclosed-math', `No closing \\) for ${JSON.stringify(s.slice(start, start + 100))}.`);
}

export function refuseDollarMath(s, start) {
  if (s.startsWith('$$', start)) throw new Refusal('dollar-math');
  // A second price, as in "$30 and $50", is not a closing math delimiter.
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '$') {
      if (!/\d/.test(s[i + 1] || '')) throw new Refusal('dollar-math');
      return;
    } else if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) i = end;
    }
  }
}
