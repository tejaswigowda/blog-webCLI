// The Custom CSS box's syntax highlighting: the tokenizer is lossless and colours what it says it does; painting makes text, never markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeCss } from '../app/highlight.js';

const kinds = (css) => tokenizeCss(css).filter(([t]) => t !== 'space').map(([t, s]) => `${t}:${s.trim()}`);

test('the tokens, joined, are exactly the input, whatever the input', () => {
  const samples = [
    '', ' ', '.a { color: red }', '@media (max-width: 600px) {\n  .posts h2 { letter-spacing: .02em; margin: -1.5rem auto }\n}\n',
    '/* c */ a:hover { color: #fff !important; background: rgb(1, 2, 3) }', '.a { content: "x\\"y" }', '.a { color: red', '}}}{{{;;;', '/* unterminated',
    'a[href="x"] { x: \'y\' }', '"unterminated', '@keyframes k { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }', '日本語 { colour: 赤 }\r\n',
    '.a{b:c;d:e}', '@supports (display: grid) { .a { display: grid } }', '\u0000\u2028 { }',
  ];
  for (const s of samples) assert.equal(tokenizeCss(s).map((t) => t[1]).join(''), s, JSON.stringify(s));
});

test('selectors, properties, values, numbers, colours, functions and !important are told apart', () => {
  assert.deepEqual(kinds('.posts h2 { color: #0b7a5f; margin: -1.5rem 0; width: calc(100% - 2px) !important }'), [
    'selector:.posts h2', 'punct:{', 'property:color', 'punct::', 'color:#0b7a5f', 'punct:;', 'property:margin', 'punct::', 'number:-1.5rem', 'number:0',
    'punct:;', 'property:width', 'punct::', 'function:calc', 'punct:(', 'number:100%', 'punct:-', 'number:2px', 'punct:)', 'important:!important', 'punct:}',
  ]);
});

test('at-rules, rules inside them, comments and strings', () => {
  assert.deepEqual(kinds('/* hi */ @media (min-width: 40em) { a { content: "x" } }'), [
    'comment:/* hi */', 'atrule:@media (min-width: 40em)', 'punct:{', 'selector:a', 'punct:{', 'property:content', 'punct::', 'string:"x"', 'punct:}', 'punct:}',
  ]);
  // a comment or a string in a value is not read as syntax
  assert.deepEqual(kinds('a { x: "}{;" /* ; */ }').filter((k) => k.startsWith('punct')), ['punct:{', 'punct::', 'punct:}']);
});

test('after a block, the next thing is a selector again; a property is not mistaken for one', () => {
  const t = kinds('a { b: c } d { e: f }');
  assert.equal(t.filter((k) => k.startsWith('selector')).join(), 'selector:a,selector:d');
  assert.equal(t.filter((k) => k.startsWith('property')).join(), 'property:b,property:e');
});

test('painting builds text nodes and spans with fixed classes only: typed markup stays text', () => {
  const made = [];
  const node = (tag) => ({ tag, children: [], className: '', textContent: '', append(...k) { this.children.push(...k); } });
  const doc = { createElement: (t) => node(t), createTextNode: (t) => ({ text: t }) };
  const pre = { ownerDocument: doc, children: [], set textContent(v) { this.children = []; }, append(...k) { this.children.push(...k); } };
  return import('../app/highlight.js').then(({ paintCss }) => {
    paintCss(pre, '<img src=x onerror=alert(1)> { color: red } /* <script>x</script> */', doc);
    for (const c of pre.children) made.push(c);
    assert.ok(made.every((c) => c.text !== undefined || (c.tag === 'span' && /^tk-[a-z]+$/.test(c.className))));
    assert.ok(made.some((c) => /<img src=x onerror=alert\(1\)>/.test(c.text || c.textContent)), 'the text is kept, as text');
    assert.equal(made[made.length - 1].text, '\n', 'the last empty line is drawn');
  });
});
