import { renderToString, ParseError } from '../vendor/temml/temml.esm.js';
import { Refusal } from './errors.js';
import { MAX_MATH_LENGTH } from './math-syntax.js';
import { serializeMathML } from './mathml.js';
import { mathState } from './math-state.js';

const MACROS = new Set('newcommand renewcommand providecommand def gdef edef xdef let futurelet global long csname endcsname expandafter noexpand catcode DeclareMathOperator newenvironment renewenvironment definecolor'.split(' '));
const UNSUPPORTED = new Set('href url includegraphics class id style htmlStyle htmlClass htmlId htmlData data require label ref eqref tag notag nonumber'.split(' '));
const ENVIRONMENTS = new Set('aligned alignedat gathered matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix cases array'.split(' '));

export function renderMath(tex, { display = false, where } = {}) {
  const fail = (code, reason) => new Refusal(code, `${JSON.stringify(tex)}: ${reason}`, where);
  if (typeof tex !== 'string' || !tex.trim() || tex.length > MAX_MATH_LENGTH) throw fail('bad-math', `an expression must contain 1-${MAX_MATH_LENGTH} characters`);
  let depth = 0, commands = 0;
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === '$') throw fail('dollar-math', 'Dollars are currency, not math delimiters; omit them inside a math expression.');
    if (tex[i] === '%') {
      const end = tex.indexOf('\n', i);
      i = end < 0 ? tex.length : end;
    } else if (tex[i] === '\\') {
      const command = /^\\([A-Za-z]+|[\s\S])/.exec(tex.slice(i));
      if (!command) continue;
      const name = command[1];
      if (MACROS.has(name)) throw fail('math-macro', `\\${name} defines or manipulates macros; macros are not supported`);
      if (UNSUPPORTED.has(name)) throw fail('bad-math', `\\${name} is not supported (no links, resources, custom markup or equation references)`);
      if (++commands > 256) throw fail('bad-math', 'at most 256 commands per expression');
      if (name === 'begin' || name === 'end') {
        const env = /^\{([^}]+)\}/.exec(tex.slice(i + command[0].length));
        if (!env || !ENVIRONMENTS.has(env[1])) throw fail('bad-math', `unsupported \\${name} environment ${env?.[1] || ''}`);
      }
      i += command[0].length - 1;
    } else if (tex[i] === '{' && ++depth > 48) throw fail('bad-math', 'at most 48 nested groups');
    else if (tex[i] === '}') depth--;
  }
  try {
    return serializeMathML(renderToString(tex, { displayMode: display, annotate: true, trust: false, strict: true, throwOnError: true, maxExpand: 200, maxSize: [20, 200], macros: {} }), tex);
  } catch (e) {
    if (e instanceof Refusal) throw fail(e.code, e.detail);
    if (e instanceof ParseError || e instanceof RangeError) throw fail('bad-math', e.message);
    throw e;
  }
}

mathState.render = renderMath;
